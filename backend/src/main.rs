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
fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=Chronicler", "-c", "user.email=snapshots@chronicler.local"])
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn ensure_repo(root: &Path) -> Result<(), String> {
    if run_git(root, &["rev-parse", "--git-dir"]).is_err() {
        run_git(root, &["init"])?;
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

    {
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
        });
    }

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
            "status": "ready",
            "root": root.display().to_string()
        })),
        "snapshot/create" => {
            let message = req.params["message"].as_str().unwrap_or("Snapshot");
            let result = (|| -> Result<Value, String> {
                ensure_repo(root)?;
                run_git(root, &["add", "-A"])?;
                let status = run_git(root, &["status", "--porcelain"])?;
                if status.trim().is_empty() {
                    return Ok(json!({ "created": false, "reason": "No changes since last snapshot" }));
                }
                run_git(root, &["commit", "-m", message])?;
                Ok(json!({ "created": true }))
            })();
            result.map_err(|e| (-32000, e))
        },
        "snapshot/list" => {
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
        },
        "snapshot/restore_file" => {
            let hash = req.params["hash"].as_str().unwrap_or("");
            let rel_path = req.params["rel_path"].as_str().unwrap_or("");
            if hash.is_empty() || rel_path.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                Err((-32602, "Missing or invalid hash/rel_path".to_string()))
            } else {
                match resolve_path(root, rel_path) {
                    Err(e) => Err((-32602, e)),
                    Ok(_) => match run_git(root, &["checkout", hash, "--", rel_path]) {
                        Ok(_) => Ok(json!({ "success": true })),
                        Err(e) => Err((-32000, format!("Failed to restore: {}", e))),
                    },
                }
            }
        },
        "project/search" => {
            let query = req.params["query"].as_str().unwrap_or("");
            if query.is_empty() {
                Err((-32602, "Missing query".to_string()))
            } else {
                let mut results = Vec::new();
                search_files(root, "", &query.to_lowercase(), &mut results);
                Ok(json!({ "results": results }))
            }
        },
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
