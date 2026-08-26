use anyhow::{bail, Context};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod ai;
mod codex;
mod compile;
mod db;
mod diagnostics;
mod embed;
mod ner;
mod agents;
mod rpc;
mod stats;
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

/// Every .md file in the project, as relative paths.
pub fn list_md_files(root: &Path) -> Vec<String> {
    let mut entries = Vec::new();
    get_files_recursive(root, "", &mut entries);
    entries
        .iter()
        .filter(|e| !e["is_dir"].as_bool().unwrap_or(false))
        .filter_map(|e| e["name"].as_str().map(String::from))
        .collect()
}

/// Run NER discovery over files, feeding the candidates inbox.
/// Returns the number of newly seen names.
fn discover_files(root: &Path, files: &[String]) -> anyhow::Result<usize> {
    if !ner::is_ready() {
        return Ok(0);
    }
    let mut new_total = 0;
    for rel in files {
        let Ok(path) = resolve_path(root, rel) else { continue };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let spans = ner::extract(&content)?;
        let lines: Vec<&str> = content.lines().collect();
        let candidates: Vec<codex::Candidate> = spans
            .into_iter()
            .map(|s| codex::Candidate {
                context: lines
                    .get(s.line.saturating_sub(1))
                    .map(|l| l.trim().chars().take(160).collect())
                    .unwrap_or_default(),
                name: s.text,
                kind_guess: s.kind,
                source: "ner".into(),
                summary: String::new(),
                line: s.line,
            })
            .collect();
        new_total += codex::record_candidates(root, rel, &candidates)?;
    }
    Ok(new_total)
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

    // Warm the diagnostics engines off the hot path — harper/nlprule take a
    // moment to load, and the first check shouldn't pay for it.
    if diagnostics::is_ready() {
        tokio::task::spawn_blocking(|| {
            if let Err(e) = diagnostics::warm() {
                tracing::warn!("diagnostics warm-up failed: {:#}", e);
            }
        });
    }

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
            let discovery_pending: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
                Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
            let mut discovery_task: Option<tokio::task::JoinHandle<()>> = None;
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
                let paths: Vec<String> = rels.into_iter().collect();
                let notif = json!({
                    "jsonrpc": "2.0",
                    "method": "project/changed",
                    "params": { "paths": paths.clone() }
                });
                let _ = tx.send(notif.to_string()).await;

                // Codex upkeep: mention reindex is cheap, run per batch.
                // NER discovery is not — queue files and run after a quiet
                // period so autosave bursts don't grind the CPU.
                let md_files: Vec<String> =
                    paths.into_iter().filter(|p| p.ends_with(".md")).collect();
                if md_files.is_empty() {
                    continue;
                }
                {
                    let root = root.clone();
                    let files = md_files.clone();
                    let tx3 = tx.clone();
                    tokio::spawn(async move {
                        let root2 = root.clone();
                        let files2 = files.clone();
                        let diags = tokio::task::spawn_blocking(move || {
                            if let Err(e) = codex::reindex_mentions(&root2, Some(&files2)) {
                                tracing::warn!("mention reindex failed: {:#}", e);
                            }
                            let mut by_file = serde_json::Map::new();
                            for rel in &files2 {
                                by_file.insert(rel.clone(), Value::Array(collect_diags(&root2, rel)));
                            }
                            by_file
                        })
                        .await
                        .unwrap_or_default();
                        if !diags.is_empty() {
                            let notif = json!({
                                "jsonrpc": "2.0",
                                "method": "diag/updated",
                                "params": { "files": diags }
                            });
                            let _ = tx3.send(notif.to_string()).await;
                        }
                    });
                }
                {
                    let mut pending = discovery_pending.lock().unwrap();
                    pending.extend(md_files);
                }
                if let Some(handle) = discovery_task.take() {
                    handle.abort(); // reset the quiet period
                }
                let pending = discovery_pending.clone();
                let root2 = root.clone();
                let tx2 = tx.clone();
                discovery_task = Some(tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    let files: Vec<String> = {
                        let mut p = pending.lock().unwrap();
                        p.drain().collect()
                    };
                    if files.is_empty() {
                        return;
                    }
                    // Keep the agent's manuscript index fresh: re-embed changed scenes, but
                    // only once the writer has built an index with the
                    // currently configured embedding model.
                    if embed::stats(&root2).map(|(_, chunks)| chunks > 0).unwrap_or(false)
                        && embed::index_is_current_model(&root2)
                    {
                        match embed::index_files(&root2, &files).await {
                            Ok(n) => tracing::info!("agent index refreshed: {} passages", n),
                            Err(e) => tracing::warn!("agent index refresh failed: {:#}", e),
                        }
                    }
                    let root3 = root2.clone();
                    let ner_files = files.clone();
                    let found = tokio::task::spawn_blocking(move || {
                        discover_files(&root3, &ner_files)
                    })
                    .await
                    .unwrap_or(Ok(0));
                    match found {
                        Ok(n) if n > 0 => {
                            // NER surfaced something new: optionally follow up
                            // with the (costlier) LLM pass on the same files.
                            let mut total = n;
                            if ai::auto_scan_ready(&root2) {
                                for rel in &files {
                                    match ai::scan_file(&root2, rel).await {
                                        Ok((extra, _aliases)) => total += extra,
                                        Err(e) => tracing::warn!("auto LLM scan failed for {}: {:#}", rel, e),
                                    }
                                }
                            }
                            let notif = json!({
                                "jsonrpc": "2.0",
                                "method": "codex/changed",
                                "params": { "newCandidates": total }
                            });
                            let _ = tx2.send(notif.to_string()).await;
                        }
                        Ok(_) => {}
                        Err(e) => tracing::warn!("NER discovery failed: {:#}", e),
                    }
                }));
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
            let response = handle_request_line(&root, &line, tx.clone()).await;
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

async fn handle_request_line(
    root: &Path,
    line: &str,
    tx: mpsc::Sender<String>,
) -> Option<JsonRpcResponse> {
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
        "codex/list" => codex::list_entities(root).map_err(rpc_err),
        "codex/create" => codex_create(root, &req.params).map_err(rpc_err),
        "codex/update" => codex_update(root, &req.params).map_err(rpc_err),
        "codex/delete" => codex_delete(root, &req.params).map_err(rpc_err),
        "codex/add_alias" => codex_add_alias(root, &req.params).map_err(rpc_err),
        "codex/mentions" => codex_mentions(root, &req.params).map_err(rpc_err),
        "codex/candidates" => codex::list_candidates(root).map_err(rpc_err),
        "codex/dismiss" => codex_dismiss(root, &req.params).map_err(rpc_err),
        "codex/promote" => codex_promote(root, &req.params).map_err(rpc_err),
        "codex/suggest" => codex_suggest(root, &req.params).map_err(rpc_err),
        "codex/reindex" => codex_reindex(root).map_err(rpc_err),
        "index/rebuild" => index_rebuild(root).map_err(rpc_err),
        "agents/chat" => {
            let id = req.params["id"].as_str().unwrap_or("rig").to_string();
            let messages = req.params["messages"].as_array().cloned().unwrap_or_default();
            let attach: Vec<String> = req.params["attach"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if messages.is_empty() {
                Err((-32000, "Missing param: messages".to_string()))
            } else {
                match agents::run_chat(
                    root,
                    tx.clone(),
                    id,
                    &messages,
                    req.params["context"].as_str(),
                    &attach,
                )
                .await
                {
                    Ok((text, stopped)) => Ok(json!({ "text": text, "stopped": stopped })),
                    Err(e) => Err(rpc_err(e)),
                }
            }
        }
        "agents/stop" => {
            let id = req.params["id"].as_str().unwrap_or("");
            Ok(json!({ "stopped": agents::stop_chat(id) }))
        }
        "agents/continuity" => {
            match agents::run_continuity(root, tx.clone(), req.params["rel_path"].as_str()).await
            {
                Ok((findings, summary, stopped)) => {
                    Ok(json!({ "findings": findings, "summary": summary, "stopped": stopped }))
                }
                Err(e) => Err(rpc_err(e)),
            }
        }
        "agents/finding_dismiss" => {
            let id = req.params["id"].as_i64().unwrap_or(-1);
            agents::dismiss_finding(root, id).map(|_| json!({ "success": true })).map_err(rpc_err)
        }
        "agents/ledger" => {
            let force = req.params["force"].as_bool().unwrap_or(false);
            match agents::ledger_update(root, tx.clone(), force).await {
                Ok((scenes, facts)) => Ok(json!({ "scenes": scenes, "facts": facts })),
                Err(e) => Err(rpc_err(e)),
            }
        }
        "agents/facts" => agents::ledger_report(root, req.params["subject"].as_str())
            .map(|md| json!({ "markdown": md }))
            .map_err(rpc_err),
        "agents/timeline_build" => match agents::timeline_build(root).await {
            Ok(v) => Ok(v),
            Err(e) => Err(rpc_err(e)),
        },
        "agents/timeline" => agents::timeline_get(root).map_err(rpc_err),
        "agents/synopses" => match agents::draft_synopses(root, tx.clone()).await {
            Ok(drafted) => Ok(json!({ "drafted": drafted })),
            Err(e) => Err(rpc_err(e)),
        },
        "agents/hygiene" => match agents::hygiene_sweep(root, tx.clone()).await {
            Ok((suggestions, summary)) => {
                Ok(json!({ "suggestions": suggestions, "summary": summary }))
            }
            Err(e) => Err(rpc_err(e)),
        },
        "agents/voice" => {
            let id = req.params["id"].as_i64().unwrap_or(-1);
            match agents::voice_report(root, id).await {
                Ok(markdown) => Ok(json!({ "markdown": markdown })),
                Err(e) => Err(rpc_err(e)),
            }
        }
        "agents/critique" => {
            let brief: agents::CritiqueBrief =
                serde_json::from_value(req.params["brief"].clone()).unwrap_or_default();
            match agents::critique_run(root, tx.clone(), brief).await {
                Ok((problems, report)) => {
                    Ok(json!({ "problems": problems, "markdown": report }))
                }
                Err(e) => Err(rpc_err(e)),
            }
        }
        "agents/fill" => {
            let id = req.params["id"].as_i64().unwrap_or(-1);
            let field = req.params["field"].as_str().unwrap_or("").to_string();
            match agents::fill_field(root, id, &field).await {
                Ok(text) => Ok(json!({ "text": text })),
                Err(e) => Err(rpc_err(e)),
            }
        }
        "agents/index" => match embed::reindex_all(root).await {
            Ok((files, chunks)) => Ok(json!({ "files": files, "chunks": chunks })),
            Err(e) => Err(rpc_err(e)),
        },
        "agents/status" => {
            let (files, chunks) = embed::stats(root).unwrap_or((0, 0));
            Ok(json!({
                "indexedFiles": files,
                "chunks": chunks,
                "embedModel": agents::embed_model_name(root).unwrap_or_default(),
                "currentModel": embed::index_is_current_model(root),
            }))
        }
        "codex/scan" => codex_scan(root, &req.params).map_err(rpc_err),
        "stats/get" => (|| -> AnyResult<Value> {
            let today = param(&req.params, "today")?;
            stats::project_stats(root, today)
        })().map_err(rpc_err),
        "diag/status" => Ok(json!({ "ready": diagnostics::is_ready(), "langDir": diagnostics::lang_dir().display().to_string() })),
        "diag/ensure" => match diagnostics::ensure_models().await {
            Ok(()) => Ok(json!({ "ready": diagnostics::is_ready() })),
            Err(e) => Err(rpc_err(e)),
        },
        "diag/check" => diag_check(root, &req.params).map_err(rpc_err),
        "diag/fix" => diag_fix(root, &req.params).map_err(rpc_err),
        "diag/add_word" => (|| -> AnyResult<Value> {
            diagnostics::add_word(root, param(&req.params, "word")?)?;
            Ok(json!({ "success": true }))
        })().map_err(rpc_err),
        "diag/ignore" => (|| -> AnyResult<Value> {
            let rule_id = param(&req.params, "ruleId")?;
            let file = req.params["file"].as_str().unwrap_or("*");
            let text = req.params["text"].as_str().unwrap_or("");
            diagnostics::suppress(root, rule_id, file, text)?;
            Ok(json!({ "success": true }))
        })().map_err(rpc_err),
        "ner/status" => Ok(json!({ "ready": ner::is_ready(), "modelDir": ner::model_dir().display().to_string() })),
        "ner/ensure" => match ner::ensure_model().await {
            Ok(()) => Ok(json!({ "ready": ner::is_ready() })),
            Err(e) => Err(rpc_err(e)),
        },
        "ai/config" => {
            let cfg = ai::load_config(root);
            Ok(json!({
                "provider": cfg.provider, "model": cfg.model,
                "baseUrl": cfg.base_url, "embedModel": cfg.embed_model, "enabled": cfg.enabled,
                "hasKey": ai::has_key(),
            }))
        },
        "ai/config_set" => {
            let cfg = ai::AiConfig {
                provider: req.params["provider"].as_str().unwrap_or("openrouter").to_string(),
                model: req.params["model"].as_str().unwrap_or("openrouter/auto").to_string(),
                base_url: req.params["baseUrl"].as_str().unwrap_or("").to_string(),
                embed_model: req.params["embedModel"].as_str().unwrap_or("").to_string(),
                enabled: req.params["enabled"].as_bool().unwrap_or(false),
            };
            ai::save_config(root, cfg).map(|_| json!({ "success": true })).map_err(rpc_err)
        },
        "ai/models" => match ai::list_models(&ai::load_config(root)).await {
            Ok(models) => Ok(json!({ "models": models })),
            Err(e) => Err(rpc_err(e)),
        },
        "ai/test" => match ai::test_connection(root).await {
            Ok(reply) => Ok(json!({ "ok": true, "reply": reply })),
            Err(e) => Err(rpc_err(e)),
        },
        "ai/set_key" => {
            ai::set_key(req.params["key"].as_str().unwrap_or(""));
            Ok(json!({ "success": true }))
        }
        "ai/scan" => {
            let rel = req.params["rel_path"].as_str().unwrap_or("").to_string();
            if rel.is_empty() {
                Err((-32000, "Missing param: rel_path".to_string()))
            } else {
                match ai::scan_file(root, &rel).await {
                    Ok((new, aliases)) => {
                        Ok(json!({ "newCandidates": new, "aliasesAdded": aliases }))
                    }
                    Err(e) => Err(rpc_err(e)),
                }
            }
        }
        "compile/run" => compile_run(root, &req.params).map_err(rpc_err),
        "snapshot/create" => snapshot_create(root, &req.params).map_err(rpc_err),
        "snapshot/list" => snapshot_list(root).map_err(rpc_err),
        "snapshot/restore_file" => snapshot_restore_file(root, &req.params).map_err(rpc_err),
        "project/search" => project_search(root, &req.params).map_err(rpc_err),
        "project/replace" => project_replace(root, &req.params).map_err(rpc_err),
        "document/read" => document_read(root, &req.params).map_err(rpc_err),
        "document/save" => document_save(root, &req.params).map_err(rpc_err),
        "project/list_files" => Ok(project_list_files(root)),
        "project/create_folder" => project_create_folder(root, &req.params).map_err(rpc_err),
        "project/rename" => project_rename(root, &req.params).map_err(rpc_err),
        "meta/get_all" => meta_get_all(root).map_err(rpc_err),
        "meta/set" => meta_set(root, &req.params).map_err(rpc_err),
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

/// Language-engine diagnostics plus stored assistant findings for one scene.
/// Missing language models yield an empty engine list — assistant findings
/// surface regardless.
fn collect_diags(root: &Path, rel: &str) -> Vec<Value> {
    let mut diags = diagnostics::check_file(root, rel).unwrap_or_default();
    if let Ok(mut findings) = agents::findings_for(root, rel) {
        diags.append(&mut findings);
    }
    diags
}

fn diag_check(root: &Path, params: &Value) -> AnyResult<Value> {
    let files: Vec<String> = match params["rel_path"].as_str() {
        Some(f) => vec![f.to_string()],
        None => list_md_files(root),
    };
    let mut by_file = serde_json::Map::new();
    for rel in &files {
        by_file.insert(rel.clone(), Value::Array(collect_diags(root, rel)));
    }
    Ok(json!({ "files": by_file }))
}

fn codex_create(root: &Path, params: &Value) -> AnyResult<Value> {
    let name = param(params, "name")?;
    let kind = params["kind"].as_str().unwrap_or("character");
    let summary = params["summary"].as_str().unwrap_or("");
    let aliases: Vec<String> = params["aliases"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let id = codex::create_entity(root, name, kind, summary, &aliases)?;
    codex::reindex_mentions(root, None)?;
    Ok(json!({ "id": id }))
}

fn codex_update(root: &Path, params: &Value) -> AnyResult<Value> {
    let id = params["id"].as_i64().context("missing id")?;
    codex::update_entity(root, id, params)?;
    // Renames and alias edits change what the mention automaton matches
    if params["name"].is_string() || params["aliases"].is_array() {
        codex::reindex_mentions(root, None)?;
    }
    Ok(json!({ "success": true }))
}

fn codex_delete(root: &Path, params: &Value) -> AnyResult<Value> {
    let id = params["id"].as_i64().context("missing id")?;
    codex::delete_entity(root, id)?;
    Ok(json!({ "success": true }))
}

fn codex_add_alias(root: &Path, params: &Value) -> AnyResult<Value> {
    let id = params["id"].as_i64().context("missing id")?;
    let alias = param(params, "alias")?;
    codex::add_alias(root, id, alias)?;
    codex::reindex_mentions(root, None)?;
    Ok(json!({ "success": true }))
}

fn codex_mentions(root: &Path, params: &Value) -> AnyResult<Value> {
    let id = params["id"].as_i64().context("missing id")?;
    codex::entity_mentions(root, id)
}

fn codex_dismiss(root: &Path, params: &Value) -> AnyResult<Value> {
    codex::dismiss_candidate(root, param(params, "name")?)?;
    Ok(json!({ "success": true }))
}

fn codex_promote(root: &Path, params: &Value) -> AnyResult<Value> {
    let name = param(params, "name")?;
    let kind = params["kind"].as_str().unwrap_or("character");
    let summary = params["summary"].as_str().unwrap_or("");
    let as_alias_of = params["asAliasOf"].as_i64();
    let result = codex::promote_candidate(root, name, kind, summary, as_alias_of)?;
    codex::reindex_mentions(root, None)?;
    Ok(result)
}

/// Manual "promote to codex" from an editor selection: lands in the inbox
/// as a manual-source candidate (or returns matching entities for aliasing).
fn codex_suggest(root: &Path, params: &Value) -> AnyResult<Value> {
    let name = param(params, "name")?;
    let file = params["file"].as_str().unwrap_or("");
    let context = params["context"].as_str().unwrap_or("");
    let line = params["line"].as_u64().unwrap_or(0) as usize;
    let new = codex::record_candidates(
        root,
        file,
        &[codex::Candidate {
            name: name.to_string(),
            kind_guess: String::new(),
            source: "manual".into(),
            summary: String::new(),
            context: context.chars().take(160).collect(),
            line,
        }],
    )?;
    Ok(json!({ "added": new > 0 }))
}

fn codex_reindex(root: &Path) -> AnyResult<Value> {
    let count = codex::reindex_mentions(root, None)?;
    Ok(json!({ "mentions": count }))
}

/// Nuke every derived index (mentions, discovery candidates) and rebuild from
/// the files on disk. User data — entities, dismissals, dictionary,
/// suppressions, scene metadata — is untouched.
fn index_rebuild(root: &Path) -> AnyResult<Value> {
    let conn = db::open(root)?;
    conn.execute("DELETE FROM mentions", [])?;
    conn.execute("DELETE FROM candidates", [])?;
    drop(conn);
    let mentions = codex::reindex_mentions(root, None)?;
    let files = list_md_files(root);
    let candidates = if ner::is_ready() {
        discover_files(root, &files)?
    } else {
        0
    };
    Ok(json!({ "mentions": mentions, "candidates": candidates, "files": files.len() }))
}

fn codex_scan(root: &Path, params: &Value) -> AnyResult<Value> {
    if !ner::is_ready() {
        anyhow::bail!("NER model not downloaded yet — fetch it from the Codex panel first");
    }
    let files: Vec<String> = match params["rel_path"].as_str() {
        Some(f) => vec![f.to_string()],
        None => list_md_files(root),
    };
    let new = discover_files(root, &files)?;
    Ok(json!({ "newCandidates": new, "scanned": files.len() }))
}

/// Apply a single diagnostic fix on disk: replace the exact span if the text
/// there still matches what the diagnostic saw. Used for files that aren't
/// open in an editor tab (open tabs apply fixes in-editor instead).
fn diag_fix(root: &Path, params: &Value) -> AnyResult<Value> {
    let rel = param(params, "rel_path")?;
    let expect = param(params, "text")?;
    let replacement = param(params, "replacement")?;
    let line_no = params["line"].as_u64().context("missing line")? as usize; // 1-based
    let col_start = params["colStart"].as_u64().context("missing colStart")? as usize;
    let col_end = params["colEnd"].as_u64().context("missing colEnd")? as usize;
    let path = resolve_path(root, rel)?;
    let content = std::fs::read_to_string(&path).with_context(|| format!("reading {}", rel))?;
    let mut lines: Vec<String> = content.split('\n').map(str::to_string).collect();
    let line = lines
        .get(line_no.saturating_sub(1))
        .with_context(|| format!("line {} out of range", line_no))?;
    let chars: Vec<char> = line.chars().collect();
    if col_end > chars.len() || chars[col_start..col_end].iter().collect::<String>() != expect {
        anyhow::bail!("the text has changed since this problem was found — recheck first");
    }
    let new_line: String = chars[..col_start]
        .iter()
        .collect::<String>()
        + replacement
        + &chars[col_end..].iter().collect::<String>();
    lines[line_no - 1] = new_line;
    atomic_write(&path, &lines.join("\n"))?;
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
    let match_case = params["matchCase"].as_bool().unwrap_or(false);
    let mut results = Vec::new();
    if match_case {
        search_files_cased(root, "", query, &mut results, true);
    } else {
        search_files(root, "", &query.to_lowercase(), &mut results);
    }
    Ok(json!({ "results": results }))
}

/// Replace occurrences of `query`. Scope is the whole project, or one
/// specific line when `file` + `line` are given. Case-insensitive matching
/// splices the replacement over the matched span.
fn project_replace(root: &Path, params: &Value) -> AnyResult<Value> {
    let query = param(params, "query")?;
    let replacement = params["replacement"].as_str().unwrap_or("");
    let match_case = params["matchCase"].as_bool().unwrap_or(false);
    let only_file = params["file"].as_str();
    let only_line = params["line"].as_u64().map(|l| l as usize);

    let replace_in_line = |line: &str| -> (String, usize) {
        let mut out = String::with_capacity(line.len());
        let mut count = 0;
        let mut hay = if match_case { line.to_string() } else { line.to_lowercase() };
        let mut needle = if match_case { query.to_string() } else { query.to_lowercase() };
        // Lowercasing can change byte lengths for some scripts, which would
        // corrupt splice offsets — fall back to exact matching there.
        if hay.len() != line.len() || needle.len() != query.len() {
            hay = line.to_string();
            needle = query.to_string();
        }
        let mut byte = 0;
        while byte < line.len() {
            if let Some(pos) = hay[byte..].find(&needle) {
                let start = byte + pos;
                out.push_str(&line[byte..start]);
                out.push_str(replacement);
                count += 1;
                byte = start + needle.len();
            } else {
                out.push_str(&line[byte..]);
                break;
            }
        }
        (out, count)
    };

    let files: Vec<String> = match only_file {
        Some(f) => vec![f.to_string()],
        None => list_md_files(root),
    };

    let mut files_changed = 0;
    let mut occurrences = 0;
    for rel in &files {
        let path = resolve_path(root, rel)?;
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let had_trailing_newline = content.ends_with('\n');
        let mut changed = false;
        let new_lines: Vec<String> = content
            .lines()
            .enumerate()
            .map(|(i, line)| {
                if let Some(target) = only_line {
                    if i + 1 != target {
                        return line.to_string();
                    }
                }
                let (replaced, n) = replace_in_line(line);
                if n > 0 {
                    occurrences += n;
                    changed = true;
                }
                replaced
            })
            .collect();
        if changed {
            let mut new_content = new_lines.join("\n");
            if had_trailing_newline {
                new_content.push('\n');
            }
            atomic_write(&path, &new_content).with_context(|| format!("writing {}", rel))?;
            files_changed += 1;
        }
    }
    Ok(json!({ "filesChanged": files_changed, "occurrences": occurrences }))
}

/// Case-sensitive variant of the project search walk.
fn search_files_cased(dir: &Path, prefix: &str, query: &str, results: &mut Vec<serde_json::Value>, root_level: bool) {
    let _ = root_level;
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
            let rel_path = if prefix.is_empty() { file_name.to_string() } else { format!("{}/{}", prefix, file_name) };
            if path.is_dir() {
                search_files_cased(&path, &rel_path, query, results, false);
            } else if path.extension().unwrap_or_default() == "md" {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for (i, line) in content.lines().enumerate() {
                        if line.contains(query) {
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
    // Scene metadata follows the file (and children, for folder renames)
    if let Ok(conn) = db::open(root) {
        let _ = conn.execute(
            "UPDATE scene_meta SET file = ?2 WHERE file = ?1",
            rusqlite::params![old_path, new_path],
        );
        let prefix = format!("{}/", old_path);
        let _ = conn.execute(
            "UPDATE scene_meta SET file = ?2 || substr(file, ?3) WHERE file LIKE ?1 || '/%'",
            rusqlite::params![old_path, new_path, prefix.len()],
        );
    }
    Ok(json!({ "success": true }))
}

fn meta_get_all(root: &Path) -> AnyResult<Value> {
    let conn = db::open(root)?;
    let mut stmt = conn.prepare("SELECT file, synopsis, status FROM scene_meta")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "file": r.get::<_, String>(0)?,
                "synopsis": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "meta": rows }))
}

fn meta_set(root: &Path, params: &Value) -> AnyResult<Value> {
    let file = param(params, "file")?;
    let conn = db::open(root)?;
    conn.execute(
        "INSERT INTO scene_meta (file, synopsis, status) VALUES (?1, '', '')
         ON CONFLICT(file) DO NOTHING",
        [file],
    )?;
    if let Some(synopsis) = params["synopsis"].as_str() {
        conn.execute("UPDATE scene_meta SET synopsis = ?2 WHERE file = ?1", rusqlite::params![file, synopsis])?;
    }
    if let Some(status) = params["status"].as_str() {
        conn.execute("UPDATE scene_meta SET status = ?2 WHERE file = ?1", rusqlite::params![file, status])?;
    }
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
