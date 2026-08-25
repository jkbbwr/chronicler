use anyhow::{bail, Context};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod compile;
mod db;
mod rpc;
use rpc::protocol::{JsonRpcRequest, JsonRpcResponse};

type AnyResult<T> = anyhow::Result<T>;

/// Render an error (with its whole context chain) into a JSON-RPC error pair.
fn rpc_err(e: anyhow::Error) -> (i32, String) {
    (-32000, format!("{:#}", e))
}

/// Required non-empty string parameter.
fn param<'a>(params: &'a Value, key: &str) -> AnyResult<&'a str> {
    match params[key].as_str() {
        Some(s) if !s.is_empty() => Ok(s),
        _ => bail!("Missing param: {}", key),
    }
}

/// Resolve a client-supplied relative path against the project root,
/// rejecting anything that could escape it (absolute paths, `..`).
fn resolve_path(root: &Path, rel: &str) -> AnyResult<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() {
        bail!("Absolute paths are not allowed");
    }
    for comp in p.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("Path escapes project root"),
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

/// Case-insensitive substring search across all .md files under `dir`.
fn search_files(dir: &Path, prefix: &str, query_lower: &str, results: &mut Vec<serde_json::Value>) {
    const MAX_RESULTS: usize = 200;
    if results.len() >= MAX_RESULTS {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if results.len() >= MAX_RESULTS {
                return;
            }
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name.starts_with('.') { continue; }

            let rel_path = if prefix.is_empty() {
                file_name.to_string()
            } else {
                format!("{}/{}", prefix, file_name)
            };

            if path.is_dir() {
                search_files(&path, &rel_path, query_lower, results);
            } else if path.extension().unwrap_or_default() == "md" {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for (i, line) in content.lines().enumerate() {
                        if line.to_lowercase().contains(query_lower) {
                            results.push(json!({
                                "file": rel_path,
                                "line": i + 1,
                                "text": line.trim().chars().take(200).collect::<String>(),
                            }));
                            if results.len() >= MAX_RESULTS {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Run git in the project root with a fixed snapshot identity.
fn run_git(root: &Path, args: &[&str]) -> AnyResult<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=Chronicler", "-c", "user.email=snapshots@chronicler.local"])
        .args(args)
        .output()
        .context("running git")?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
}

fn ensure_repo(root: &Path) -> AnyResult<()> {
    if run_git(root, &["rev-parse", "--git-dir"]).is_err() {
        run_git(root, &["init"]).context("initializing snapshot repository")?;
    }
    Ok(())
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

    // Watch the project for external changes (git, sync tools, other editors)
    // and push them to the frontend as JSON-RPC notifications.
    let (fs_tx, mut fs_rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            for p in event.paths {
                let _ = fs_tx.send(p);
            }
        }
    })?;
    notify::Watcher::watch(&mut watcher, &root, notify::RecursiveMode::Recursive)?;

    let debounce_task = {
        let tx = tx_out.clone();
        let root = root.clone();
        tokio::spawn(async move {
            use std::time::Duration;
            while let Some(first) = fs_rx.recv().await {
                let mut paths = vec![first];
                // Debounce: batch everything that arrives within 300ms
                let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
                while let Ok(Some(p)) = tokio::time::timeout_at(deadline, fs_rx.recv()).await {
                    paths.push(p);
                }
                let rels: std::collections::BTreeSet<String> = paths
                    .iter()
                    .filter_map(|p| p.strip_prefix(&**root).ok())
                    .filter(|r| {
                        r.components().all(|c| {
                            matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.'))
                        })
                    })
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .collect();
                if rels.is_empty() {
                    continue;
                }
                let notif = json!({
                    "jsonrpc": "2.0",
                    "method": "project/changed",
                    "params": { "paths": rels.into_iter().collect::<Vec<_>>() }
                });
                let _ = tx.send(notif.to_string()).await;
            }
        })
    };

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
    // The watcher pipeline holds a clone of tx_out; tear it down or the
    // writer's channel never closes and the process hangs instead of exiting.
    debounce_task.abort();
    drop(watcher);
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

    // Dispatch methods; handlers return anyhow::Result and are rendered
    // into JSON-RPC errors (with full context chains) in one place.
    let result: Result<Value, (i32, String)> = match req.method.as_str() {
        "ping" => Ok(json!("pong")),
        "system/info" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "status": "ready",
            "root": root.display().to_string()
        })),
        "db/get" => db_get(root, &req.params).map_err(rpc_err),
        "db/set" => db_set(root, &req.params).map_err(rpc_err),
        "compile/run" => compile_run(root, &req.params).map_err(rpc_err),
        "snapshot/create" => snapshot_create(root, &req.params).map_err(rpc_err),
        "snapshot/list" => snapshot_list(root).map_err(rpc_err),
        "snapshot/restore_file" => snapshot_restore_file(root, &req.params).map_err(rpc_err),
        "project/search" => project_search(root, &req.params).map_err(rpc_err),
        "document/read" => document_read(root, &req.params).map_err(rpc_err),
        "document/save" => document_save(root, &req.params).map_err(rpc_err),
        "project/list_files" => Ok(project_list_files(root)),
        "project/create_folder" => project_create_folder(root, &req.params).map_err(rpc_err),
        "project/rename" => project_rename(root, &req.params).map_err(rpc_err),
        "project/delete" => project_delete(root, &req.params).map_err(rpc_err),
        _ => Err((-32601, format!("Method not found: {}", req.method))),
    };

    match result {
        Ok(res) => Some(JsonRpcResponse::success(req.id, res)),
        Err((code, msg)) => Some(JsonRpcResponse::error(req.id, code, msg)),
    }
}

fn db_get(root: &Path, params: &Value) -> AnyResult<Value> {
    let key = param(params, "key")?;
    Ok(json!({ "value": db::get_setting(root, key)? }))
}

fn db_set(root: &Path, params: &Value) -> AnyResult<Value> {
    let key = param(params, "key")?;
    let value = params["value"].as_str().unwrap_or("");
    db::set_setting(root, key, value)?;
    Ok(json!({ "success": true }))
}

fn compile_run(root: &Path, params: &Value) -> AnyResult<Value> {
    let settings: compile::CompileSettings =
        serde_json::from_value(params["settings"].clone()).context("bad compile settings")?;
    let specs: Vec<compile::ChapterSpec> =
        serde_json::from_value(params["chapters"].clone()).context("bad chapter list")?;
    let mut chapters: Vec<(String, Vec<String>)> = Vec::new();
    for spec in specs {
        let mut scenes = Vec::new();
        for rel in &spec.scenes {
            let path = resolve_path(root, rel)?;
            let content =
                std::fs::read_to_string(&path).with_context(|| format!("reading {}", rel))?;
            scenes.push(content);
        }
        chapters.push((spec.title, scenes));
    }
    let output = compile::run(root, chapters, &settings)?;
    Ok(json!({ "output": output.display().to_string() }))
}

fn snapshot_create(root: &Path, params: &Value) -> AnyResult<Value> {
    let message = params["message"].as_str().unwrap_or("Snapshot");
    ensure_repo(root)?;
    run_git(root, &["add", "-A"])?;
    let status = run_git(root, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Ok(json!({ "created": false, "reason": "No changes since last snapshot" }));
    }
    run_git(root, &["commit", "-m", message]).context("committing snapshot")?;
    Ok(json!({ "created": true }))
}

fn snapshot_list(root: &Path) -> AnyResult<Value> {
    match run_git(root, &["log", "--pretty=format:%H\u{1f}%ct\u{1f}%s", "-n", "50"]) {
        Err(_) => Ok(json!({ "snapshots": [] })), // not a repo yet
        Ok(log) => {
            let snapshots: Vec<Value> = log
                .lines()
                .filter_map(|line| {
                    let mut parts = line.split('\u{1f}');
                    let hash = parts.next()?;
                    let timestamp: i64 = parts.next()?.parse().ok()?;
                    let message = parts.next().unwrap_or("");
                    Some(json!({ "hash": hash, "timestamp": timestamp, "message": message }))
                })
                .collect();
            Ok(json!({ "snapshots": snapshots }))
        }
    }
}

fn snapshot_restore_file(root: &Path, params: &Value) -> AnyResult<Value> {
    let hash = param(params, "hash")?;
    let rel_path = param(params, "rel_path")?;
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("Invalid snapshot hash");
    }
    resolve_path(root, rel_path)?;
    run_git(root, &["checkout", hash, "--", rel_path])
        .with_context(|| format!("restoring {}", rel_path))?;
    Ok(json!({ "success": true }))
}

fn project_search(root: &Path, params: &Value) -> AnyResult<Value> {
    let query = param(params, "query")?;
    let mut results = Vec::new();
    search_files(root, "", &query.to_lowercase(), &mut results);
    Ok(json!({ "results": results }))
}

fn document_read(root: &Path, params: &Value) -> AnyResult<Value> {
    let rel_path = param(params, "rel_path")?;
    let path = resolve_path(root, rel_path)?;
    let content =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", rel_path))?;
    Ok(json!({ "content": content }))
}

fn document_save(root: &Path, params: &Value) -> AnyResult<Value> {
    let rel_path = param(params, "rel_path")?;
    let content = params["content"].as_str().unwrap_or("");
    let path = resolve_path(root, rel_path)?;
    atomic_write(&path, content).with_context(|| format!("saving {}", rel_path))?;
    Ok(json!({ "success": true }))
}

fn project_list_files(root: &Path) -> Value {
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
    json!({ "files": files })
}

fn project_create_folder(root: &Path, params: &Value) -> AnyResult<Value> {
    let rel_path = param(params, "rel_path")?;
    let path = resolve_path(root, rel_path)?;
    std::fs::create_dir_all(&path).with_context(|| format!("creating {}", rel_path))?;
    Ok(json!({ "success": true }))
}

fn project_rename(root: &Path, params: &Value) -> AnyResult<Value> {
    let old_path = param(params, "old_path")?;
    let new_path = param(params, "new_path")?;
    let old = resolve_path(root, old_path)?;
    let new = resolve_path(root, new_path)?;
    std::fs::rename(&old, &new)
        .with_context(|| format!("renaming {} to {}", old_path, new_path))?;
    Ok(json!({ "success": true }))
}

fn project_delete(root: &Path, params: &Value) -> AnyResult<Value> {
    let rel = param(params, "path")?;
    let p = resolve_path(root, rel)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).with_context(|| format!("deleting folder {}", rel))?;
    } else {
        std::fs::remove_file(&p).with_context(|| format!("deleting {}", rel))?;
    }
    Ok(json!({ "success": true }))
}
