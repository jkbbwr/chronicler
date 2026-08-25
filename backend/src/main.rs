use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod rpc;
use rpc::protocol::{JsonRpcRequest, JsonRpcResponse};

/// Resolve a client-supplied relative path against the project root,
/// rejecting anything that could escape it (absolute paths, `..`).
fn resolve_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for comp in p.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("Path escapes project root".to_string()),
        }
    }
    Ok(root.join(p))
}

/// Write via a temp file + rename so a crash mid-write can't truncate the target.
fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid file name"))?;
    // Dot-prefixed so it never shows up in project/list_files if a rename fails.
    let tmp = path.with_file_name(format!(".{}.tmp", file_name));
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

fn get_files_recursive(dir: &Path, prefix: &str, files: &mut Vec<serde_json::Value>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = path.is_dir();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if file_name.starts_with('.') { continue; }

            let rel_path = if prefix.is_empty() {
                file_name.to_string()
            } else {
                format!("{}/{}", prefix, file_name)
            };

            if is_dir {
                files.push(json!({ "name": rel_path, "is_dir": true }));
                get_files_recursive(&path, &rel_path, files);
            } else if path.extension().unwrap_or_default() == "md" {
                files.push(json!({ "name": rel_path, "is_dir": false }));
            }
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize file-based or stderr logging since stdout is used for JSON-RPC
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("chronicler_backend=info".parse()?))
        .with_writer(io::stderr)
        .init();

    let root: Arc<PathBuf> = Arc::new(std::env::current_dir()?.canonicalize()?);
    info!("Chronicler backend started. Project root: {}", root.display());

    // Channel to send responses back to stdout
    let (tx_out, mut rx_out) = mpsc::channel::<String>(100);

    // Spawn stdout writer task
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx_out.recv().await {
            println!("{}", msg);
        }
    });

    use tokio::io::AsyncBufReadExt;
    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin).lines();

    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = reader.next_line().await {
        let tx = tx_out.clone();
        let root = root.clone();

        tasks.spawn(async move {
            let response = handle_request_line(&root, &line).await;
            if let Some(resp) = response {
                if let Ok(json_str) = serde_json::to_string(&resp) {
                    let _ = tx.send(json_str).await;
                }
            }
        });
    }

    // Stdin closed: finish in-flight requests and flush all queued responses
    // before exiting, or the last responses (e.g. a save on quit) get dropped.
    while tasks.join_next().await.is_some() {}
    drop(tx_out);
    let _ = writer.await;

    info!("Stdin closed. Backend shutting down.");
    Ok(())
}

async fn handle_request_line(root: &Path, line: &str) -> Option<JsonRpcResponse> {
    if line.trim().is_empty() {
        return None;
    }

    let req: JsonRpcRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            error!("Failed to parse JSON-RPC request: {}", e);
            return Some(JsonRpcResponse::error(Value::Null, -32700, "Parse error"));
        }
    };

    info!("Received method: {}", req.method);

    // Dispatch methods
    let result = match req.method.as_str() {
        "ping" => Ok(json!("pong")),
        "system/info" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "status": "ready"
        })),
        "document/read" => {
            let rel_path = req.params["rel_path"].as_str().unwrap_or("");
            if rel_path.is_empty() {
                Err((-32602, "Missing rel_path".to_string()))
            } else {
                match resolve_path(root, rel_path) {
                    Err(e) => Err((-32602, e)),
                    Ok(path) => match std::fs::read_to_string(&path) {
                        Ok(content) => Ok(json!({ "content": content })),
                        Err(e) => Err((-32000, format!("Failed to read file: {}", e))),
                    },
                }
            }
        },
        "document/save" => {
            let rel_path = req.params["rel_path"].as_str().unwrap_or("");
            let content = req.params["content"].as_str().unwrap_or("");
            if rel_path.is_empty() {
                Err((-32602, "Missing rel_path".to_string()))
            } else {
                match resolve_path(root, rel_path) {
                    Err(e) => Err((-32602, e)),
                    Ok(path) => match atomic_write(&path, content) {
                        Ok(_) => Ok(json!({ "success": true })),
                        Err(e) => Err((-32000, format!("Failed to save file: {}", e))),
                    },
                }
            }
        },
        "project/list_files" => {
            let mut files = Vec::new();
            get_files_recursive(root, "", &mut files);
            // Sort files: directories first, then alphabetical
            files.sort_by(|a, b| {
                let a_is_dir = a["is_dir"].as_bool().unwrap_or(false);
                let b_is_dir = b["is_dir"].as_bool().unwrap_or(false);
                if a_is_dir && !b_is_dir {
                    std::cmp::Ordering::Less
                } else if !a_is_dir && b_is_dir {
                    std::cmp::Ordering::Greater
                } else {
                    a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
                }
            });
            Ok(json!({ "files": files }))
        },
        "project/create_folder" => {
            let rel_path = req.params["rel_path"].as_str().unwrap_or("");
            if rel_path.is_empty() {
                Err((-32602, "Missing rel_path".to_string()))
            } else {
                match resolve_path(root, rel_path) {
                    Err(e) => Err((-32602, e)),
                    Ok(path) => match std::fs::create_dir_all(&path) {
                        Ok(_) => Ok(json!({ "success": true })),
                        Err(e) => Err((-32000, format!("Failed to create folder: {}", e))),
                    },
                }
            }
        },
        "project/rename" => {
            let old_path = req.params["old_path"].as_str().unwrap_or("");
            let new_path = req.params["new_path"].as_str().unwrap_or("");
            if old_path.is_empty() || new_path.is_empty() {
                Err((-32602, "Missing old_path or new_path".to_string()))
            } else {
                match (resolve_path(root, old_path), resolve_path(root, new_path)) {
                    (Err(e), _) | (_, Err(e)) => Err((-32602, e)),
                    (Ok(old), Ok(new)) => match std::fs::rename(&old, &new) {
                        Ok(_) => Ok(json!({ "success": true })),
                        Err(e) => Err((-32000, format!("Failed to rename: {}", e))),
                    },
                }
            }
        },
        "project/delete" => {
            let path = req.params["path"].as_str().unwrap_or("");
            if path.is_empty() {
                Err((-32602, "Missing path".to_string()))
            } else {
                match resolve_path(root, path) {
                    Err(e) => Err((-32602, e)),
                    Ok(p) => {
                        let result = if p.is_dir() {
                            std::fs::remove_dir_all(&p)
                        } else {
                            std::fs::remove_file(&p)
                        };
                        match result {
                            Ok(_) => Ok(json!({ "success": true })),
                            Err(e) => Err((-32000, format!("Failed to delete: {}", e))),
                        }
                    },
                }
            }
        },
        _ => Err((-32601, format!("Method not found: {}", req.method))),
    };

    match result {
        Ok(res) => Some(JsonRpcResponse::success(req.id, res)),
        Err((code, msg)) => Some(JsonRpcResponse::error(req.id, code, msg)),
    }
}
