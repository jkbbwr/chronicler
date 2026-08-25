use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod rpc;
use rpc::protocol::{JsonRpcRequest, JsonRpcResponse};

fn get_files_recursive(dir: &std::path::Path, prefix: &str, files: &mut Vec<serde_json::Value>) {
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

    info!("Chronicler backend started. Listening on stdin for JSON-RPC...");

    // Channel to send responses back to stdout
    let (tx_out, mut rx_out) = mpsc::channel::<String>(100);

    // Spawn stdout writer task
    tokio::spawn(async move {
        while let Some(msg) = rx_out.recv().await {
            println!("{}", msg);
        }
    });

    use tokio::io::AsyncBufReadExt;
    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        let tx = tx_out.clone();
        
        tokio::spawn(async move {
            let response = handle_request_line(&line).await;
            if let Some(resp) = response {
                if let Ok(json_str) = serde_json::to_string(&resp) {
                    let _ = tx.send(json_str).await;
                }
            }
        });
    }

    info!("Stdin closed. Backend shutting down.");
    Ok(())
}

async fn handle_request_line(line: &str) -> Option<JsonRpcResponse> {
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
                match std::fs::read_to_string(rel_path) {
                    Ok(content) => Ok(json!({ "content": content })),
                    Err(e) => Err((-32000, format!("Failed to read file: {}", e))),
                }
            }
        },
        "document/save" => {
            let rel_path = req.params["rel_path"].as_str().unwrap_or("");
            let content = req.params["content"].as_str().unwrap_or("");
            if rel_path.is_empty() {
                Err((-32602, "Missing rel_path".to_string()))
            } else {
                match std::fs::write(rel_path, content) {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(e) => Err((-32000, format!("Failed to save file: {}", e))),
                }
            }
        },
        "project/list_files" => {
            let mut files = Vec::new();
            get_files_recursive(std::path::Path::new("."), "", &mut files);
            // Sort files: directories first, then alphabetical
            files.sort_by(|a, b| {
                let a_is_dir = a["is_dir"].as_bool().unwrap_or(false);
                let b_is_dir = b["is_dir"].as_bool().unwrap_or(false);
                if a_is_dir && !b_is_dir {
                    std::cmp::Ordering::Less
                } else if !a_is_dir && b_is_dir {
                    std::cmp::Ordering::Greater
                } else {
                    a["name"].as_str().unwrap().cmp(b["name"].as_str().unwrap())
                }
            });
            Ok(json!({ "files": files }))
        },
        "project/create_folder" => {
            let rel_path = req.params["rel_path"].as_str().unwrap_or("");
            if rel_path.is_empty() {
                Err((-32602, "Missing rel_path".to_string()))
            } else {
                match std::fs::create_dir_all(rel_path) {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(e) => Err((-32000, format!("Failed to create folder: {}", e))),
                }
            }
        },
        "project/rename" => {
            let old_path = req.params["old_path"].as_str().unwrap_or("");
            let new_path = req.params["new_path"].as_str().unwrap_or("");
            if old_path.is_empty() || new_path.is_empty() {
                Err((-32602, "Missing old_path or new_path".to_string()))
            } else {
                match std::fs::rename(old_path, new_path) {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(e) => Err((-32000, format!("Failed to rename: {}", e))),
                }
            }
        },
        "project/delete" => {
            let path = req.params["path"].as_str().unwrap_or("");
            if path.is_empty() {
                Err((-32602, "Missing path".to_string()))
            } else {
                let p = std::path::Path::new(path);
                let result = if p.is_dir() {
                    std::fs::remove_dir_all(p)
                } else {
                    std::fs::remove_file(p)
                };
                match result {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(e) => Err((-32000, format!("Failed to delete: {}", e))),
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
