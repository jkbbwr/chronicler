//! The stdio server: read one JSON-RPC request per line from stdin, answer
//! each on stdout (in completion order), and push notifications in between.

use crate::app::{App, OutLine, Output};
use crate::rpc::{
    self, RpcError,
    protocol::{Request, Response},
};
use futures::FutureExt;
use serde_json::Value;
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tracing_subscriber::EnvFilter;

pub fn main() -> anyhow::Result<()> {
    // stdout carries JSON-RPC; logs go to stderr.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("chronicler_backend=info".parse()?),
        )
        .with_writer(std::io::stderr)
        .init();

    let (out, rx) = Output::channel();
    let writer = std::thread::spawn(move || {
        let stdout = std::io::stdout();
        for msg in rx {
            match msg {
                OutLine::Line(line) => {
                    let mut lock = stdout.lock();
                    let _ = writeln!(lock, "{line}");
                    let _ = lock.flush();
                }
                OutLine::Close => break,
            }
        }
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(out.clone()));
    out.close();
    let _ = writer.join();
    if let Err(e) = &result {
        tracing::error!("backend failed: {e:#}");
    }
    tracing::info!("Stdin closed. Backend shutting down.");
    // Blocking-pool work (a model download, a jj call) must not hold the
    // process open after the frontend has gone.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

async fn serve(out: Output) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    let (app, queue) = App::open(&root, out)?;
    tracing::info!(
        "Chronicler backend started. Project root: {}",
        app.root.display()
    );
    let background = crate::indexer::start(app.clone(), queue)?;

    let mut reader = tokio::io::BufReader::new(tokio::io::stdin());
    let mut buf = Vec::new();
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                tracing::error!("reading stdin: {e}");
                break;
            }
        }
        // Reap finished requests so the set doesn't grow for the whole session.
        while tasks.try_join_next().is_some() {}
        let app = app.clone();
        match String::from_utf8(std::mem::take(&mut buf)) {
            Ok(line) => {
                tasks.spawn(async move {
                    if let Some(resp) = handle_line(app.clone(), &line).await
                        && let Ok(s) = serde_json::to_string(&resp)
                    {
                        app.out.send(s);
                    }
                });
            }
            Err(_) => {
                let resp = Response::error(
                    Value::Null,
                    RpcError::new(rpc::PARSE_ERROR, "Parse error: request is not valid UTF-8"),
                );
                if let Ok(s) = serde_json::to_string(&resp) {
                    app.out.send(s);
                }
            }
        }
    }

    // Stdin closed: finish in-flight requests (e.g. a save on quit) before
    // the writer is told to close.
    while tasks.join_next().await.is_some() {}
    drop(background);
    Ok(())
}

/// Parse and dispatch one request line. Handler panics are caught and
/// answered, so a bug never leaves the frontend waiting forever.
pub async fn handle_line(app: Arc<App>, line: &str) -> Option<Response> {
    if line.trim().is_empty() {
        return None;
    }
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Failed to parse JSON-RPC request: {e}");
            return Some(Response::error(
                Value::Null,
                RpcError::new(rpc::PARSE_ERROR, format!("Parse error: {e}")),
            ));
        }
    };
    tracing::debug!("request {}", req.method);
    Some(respond(req.id, rpc::dispatch(app, &req.method, req.params)).await)
}

/// Await a handler and turn its outcome — value, error, or panic — into
/// a response.
async fn respond(
    id: Value,
    handler: impl std::future::Future<Output = Result<Value, RpcError>>,
) -> Response {
    match AssertUnwindSafe(handler).catch_unwind().await {
        Ok(Ok(value)) => Response::success(id, value),
        Ok(Err(e)) => Response::error(id, e),
        Err(panic) => Response::error(id, RpcError::from_panic(panic)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn panics_become_error_responses() {
        let resp = respond(Value::from(7), async {
            let v: Vec<u8> = vec![];
            #[allow(clippy::useless_vec)]
            let _ = v[3]; // index out of bounds
            Ok(Value::Null)
        })
        .await;
        assert_eq!(resp.id, 7);
        let err = resp.error.expect("error response");
        assert_eq!(err.code, rpc::INTERNAL_ERROR);
        assert!(
            err.message.contains("index out of bounds"),
            "{}",
            err.message
        );

        // Panics on the blocking pool are caught too.
        let dir = std::env::temp_dir().join(format!("chronicler-panic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (app, _q) = App::open(&dir, crate::app::Output::discard()).unwrap();
        let resp = respond(Value::from(8), async move {
            app.blocking(|_| -> anyhow::Result<()> { panic!("boom") })
                .await
                .map_err(RpcError::from)?;
            Ok(Value::Null)
        })
        .await;
        assert!(resp.error.unwrap().message.contains("boom"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
