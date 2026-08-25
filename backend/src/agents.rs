use crate::{ai, codex, db, embed};
use anyhow::{bail, Context, Result};
use rig_agent::agent::{Agent, AgentBuilder, MultiTurnStreamItem};
use rig_agent::completion::{Message, Prompt};
use rig_agent::streaming::{StreamedAssistantContent, StreamingChat};
use rig_agent::tool::{Tool, ToolContext};
use rig_core::client::completion::CompletionClient;
use rig_core::client::embeddings::EmbeddingsClient;
use rig_core::embeddings::EmbeddingModel;
use rig_core::providers::{openai, openrouter};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio::sync::{mpsc, oneshot};

// The rig's agent core, built on the `rig` crates: provider clients,
// manuscript RAG embeddings, tools the model can call (semantic search,
// grep, codex lookup, scene reads), and the streaming chat loop that
// forwards deltas and tool activity to the frontend as JSON-RPC
// notifications.

const AGENT_PREAMBLE: &str = "You are a fiction-writing assistant embedded in the author's editor, \
with tools over their manuscript and world bible. Help with drafting, revision, continuity, and craft.\n\
\n\
Tools:\n\
- search_manuscript: semantic search over the whole novel. Use it to find scenes by meaning \
(\"where does Veyra first doubt the Order?\") — quotes, themes, callbacks, continuity checks.\n\
- grep_manuscript: exact text search. Use it for names, phrases, and counting occurrences.\n\
- query_codex: the writer's world bible — characters, places, items, factions. Check it before \
asserting facts about the world.\n\
- read_scene: read one scene in full by path when you need complete context.\n\
\n\
Use tools when they would ground your answer in the actual text; skip them for pure craft talk. \
Quote the writer's own words when discussing them. Never rewrite wholesale unless asked — \
suggest, don't replace.\n\
\n\
Format replies in markdown (it renders). Cite scenes as clickable links, always in exactly this \
form — the destination is scene:// plus the project-relative path from your tool results, wrapped \
in angle brackets, with an optional #L<line> anchor:\n\
[Cold Rain](<scene://01 The Arrival/01 Cold Rain.md#L12>)\n\
Never invent paths; only link paths a tool returned or the writer mentioned.";

// ---------- Provider plumbing ----------

enum Provider {
    OpenRouter(openrouter::Client),
    Compat(openai::CompletionsClient),
}

fn provider(root: &Path) -> Result<Provider> {
    let cfg = ai::load_config(root);
    match cfg.provider.as_str() {
        "openrouter" => {
            let key = ai::api_key().context("No API key set — add one in Settings → AI")?;
            let client = if cfg.base_url.is_empty() {
                openrouter::Client::new(key)?
            } else {
                openrouter::Client::builder().api_key(key).base_url(cfg.base_url.clone()).build()?
            };
            Ok(Provider::OpenRouter(client))
        }
        "openai-compat" => {
            if cfg.base_url.is_empty() {
                bail!("OpenAI-compatible provider needs a base URL (Settings → AI)");
            }
            let key = ai::api_key().unwrap_or_else(|| "sk-no-key".to_string());
            let client = openai::Client::builder()
                .api_key(key)
                .base_url(cfg.base_url.clone())
                .build()?
                .completions_api();
            Ok(Provider::Compat(client))
        }
        other => bail!("Unknown AI provider: {}", other),
    }
}

/// The embedding model to use: explicit config, or a sensible default per
/// provider (OpenRouter routes OpenAI's embedding models).
pub fn embed_model_name(root: &Path) -> Result<String> {
    let cfg = ai::load_config(root);
    if !cfg.embed_model.is_empty() {
        return Ok(cfg.embed_model);
    }
    match cfg.provider.as_str() {
        "openrouter" => Ok("openai/text-embedding-3-small".to_string()),
        _ => bail!(
            "Set an embedding model in Settings → AI (e.g. nomic-embed-text on Ollama, text-embedding-3-small on OpenAI)"
        ),
    }
}

/// Embed texts through the provider. Vectors come back L2-normalized so
/// cosine similarity reduces to a dot product.
pub async fn embed_texts(root: &Path, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    let model_name = embed_model_name(root)?;
    let prov = provider(root)?;
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for batch in texts.chunks(32) {
        let embeddings = match &prov {
            Provider::OpenRouter(c) => {
                let model = c.embedding_model(&model_name);
                model.embed_texts(batch.to_vec()).await.context("provider embeddings call")?
            }
            Provider::Compat(c) => {
                let model = c.embedding_model(&model_name);
                model.embed_texts(batch.to_vec()).await.context("provider embeddings call")?
            }
        };
        if embeddings.len() != batch.len() {
            bail!("provider returned {} embeddings for {} texts", embeddings.len(), batch.len());
        }
        for e in embeddings {
            let mut v: Vec<f32> = e.vec.iter().map(|&f| f as f32).collect();
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
            for x in v.iter_mut() {
                *x /= norm;
            }
            out.push(v);
        }
    }
    Ok(out)
}

// ---------- Tools ----------

#[derive(Debug)]
pub struct ToolFail(String);

impl std::fmt::Display for ToolFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ToolFail {}

fn fail(e: anyhow::Error) -> ToolFail {
    ToolFail(format!("{:#}", e))
}

struct SearchManuscript {
    root: PathBuf,
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    limit: Option<usize>,
}

impl Tool for SearchManuscript {
    const NAME: &'static str = "search_manuscript";
    type Args = SearchArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "Semantic search over the entire manuscript. Finds passages by meaning, not exact words. \
         Returns the most relevant chunks with file paths and line ranges."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to look for, phrased naturally" },
                "limit": { "type": "integer", "description": "Max results (default 5)" }
            },
            "required": ["query"]
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let (files, chunks) = embed::stats(&self.root).map_err(fail)?;
        if chunks == 0 {
            return Ok(json!({
                "error": "The manuscript is not indexed yet. Ask the writer to run 'Agent: Index Manuscript' — falling back to grep_manuscript may help meanwhile."
            }));
        }
        let hits = embed::search(&self.root, &args.query, args.limit.unwrap_or(5).clamp(1, 12))
            .await
            .map_err(fail)?;
        Ok(json!({
            "indexedFiles": files,
            "results": hits.iter().map(|h| json!({
                "file": h.file,
                "lines": format!("{}-{}", h.start_line, h.end_line),
                "score": (h.score * 1000.0).round() / 1000.0,
                "text": h.text,
            })).collect::<Vec<_>>(),
        }))
    }
}

struct GrepManuscript {
    root: PathBuf,
}

#[derive(Deserialize)]
struct GrepArgs {
    pattern: String,
    case_sensitive: Option<bool>,
}

impl Tool for GrepManuscript {
    const NAME: &'static str = "grep_manuscript";
    type Args = GrepArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "Exact substring search over every scene. Returns matching lines with file paths and line \
         numbers. Use for names, distinctive phrases, and counting occurrences."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Text to find (plain substring, not regex)" },
                "case_sensitive": { "type": "boolean", "description": "Default false" }
            },
            "required": ["pattern"]
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let cased = args.case_sensitive.unwrap_or(false);
        let needle = if cased { args.pattern.clone() } else { args.pattern.to_lowercase() };
        let mut matches = Vec::new();
        let mut total = 0usize;
        for rel in crate::list_md_files(&self.root) {
            let Ok(path) = crate::resolve_path(&self.root, &rel) else { continue };
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            for (i, line) in content.lines().enumerate() {
                let hay = if cased { line.to_string() } else { line.to_lowercase() };
                if hay.contains(&needle) {
                    total += 1;
                    if matches.len() < 40 {
                        matches.push(json!({
                            "file": rel,
                            "line": i + 1,
                            "text": line.chars().take(240).collect::<String>(),
                        }));
                    }
                }
            }
        }
        Ok(json!({ "totalMatches": total, "matches": matches }))
    }
}

struct QueryCodex {
    root: PathBuf,
}

#[derive(Deserialize)]
struct CodexArgs {
    name: Option<String>,
}

impl Tool for QueryCodex {
    const NAME: &'static str = "query_codex";
    type Args = CodexArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "The writer's world bible. Without a name: lists every entity (characters, places, items, \
         factions, creatures, events, lore). With a name or alias: returns that entity's full \
         entry including notes and where it is mentioned."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Entity name or alias for a full entry; omit to list all" }
            }
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let all = codex::list_entities(&self.root).map_err(fail)?;
        let entities = all["entities"].as_array().cloned().unwrap_or_default();
        match args.name {
            None => Ok(json!({
                "entities": entities.iter().map(|e| json!({
                    "name": e["name"], "kind": e["kind"], "summary": e["summary"],
                    "aliases": e["aliases"], "mentions": e["mentionCount"],
                })).collect::<Vec<_>>(),
            })),
            Some(name) => {
                let query = name.to_lowercase();
                let found = entities.iter().find(|e| {
                    e["name"].as_str().is_some_and(|n| n.to_lowercase() == query)
                        || e["aliases"].as_array().is_some_and(|aliases| {
                            aliases
                                .iter()
                                .any(|a| a.as_str().is_some_and(|s| s.to_lowercase() == query))
                        })
                });
                match found {
                    Some(e) => {
                        let mentions = e["id"]
                            .as_i64()
                            .and_then(|id| codex::entity_mentions(&self.root, id).ok())
                            .unwrap_or_else(|| json!({ "mentions": [] }));
                        Ok(json!({ "entity": e, "mentions": mentions["mentions"] }))
                    }
                    None => Ok(json!({
                        "error": format!("No codex entry named \"{}\"", name),
                        "available": entities.iter().filter_map(|e| e["name"].as_str().map(String::from)).collect::<Vec<_>>(),
                    })),
                }
            }
        }
    }
}

struct ReadScene {
    root: PathBuf,
}

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
}

impl Tool for ReadScene {
    const NAME: &'static str = "read_scene";
    type Args = ReadArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "Read one scene in full by its project-relative path (as returned by the search tools)."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Project-relative path, e.g. \"01 The Arrival/01 Cold Rain.md\"" }
            },
            "required": ["path"]
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let path = crate::resolve_path(&self.root, &args.path).map_err(fail)?;
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", args.path))
            .map_err(fail)?;
        let capped: String = content.chars().take(32_000).collect();
        Ok(json!({
            "path": args.path,
            "lines": content.lines().count(),
            "truncated": capped.len() < content.len(),
            "content": capped,
        }))
    }
}

// ---------- Agent + streaming chat ----------

fn build_agent(root: &Path, preamble: &str) -> Result<Agent> {
    let cfg = ai::load_config(root);
    let root_buf = root.to_path_buf();
    let agent = match provider(root)? {
        Provider::OpenRouter(client) => {
            let model = client.completion_model(&cfg.model);
            AgentBuilder::new(model)
                .name("rig")
                .preamble(preamble)
                .tool(SearchManuscript { root: root_buf.clone() })
                .tool(GrepManuscript { root: root_buf.clone() })
                .tool(QueryCodex { root: root_buf.clone() })
                .tool(ReadScene { root: root_buf })
                .build()
        }
        Provider::Compat(client) => {
            let model = client.completion_model(&cfg.model);
            AgentBuilder::new(model)
                .name("rig")
                .preamble(preamble)
                .tool(SearchManuscript { root: root_buf.clone() })
                .tool(GrepManuscript { root: root_buf.clone() })
                .tool(QueryCodex { root: root_buf.clone() })
                .tool(ReadScene { root: root_buf })
                .build()
        }
    };
    Ok(agent)
}

/// A tool-less agent for one-shot jobs (field drafting, codex extraction,
/// connection tests): preamble + single prompt, no conversation, no tools.
fn build_bare_agent(root: &Path, preamble: &str) -> Result<Agent> {
    let cfg = ai::load_config(root);
    let agent = match provider(root)? {
        Provider::OpenRouter(client) => {
            AgentBuilder::new(client.completion_model(&cfg.model)).preamble(preamble).build()
        }
        Provider::Compat(client) => {
            AgentBuilder::new(client.completion_model(&cfg.model)).preamble(preamble).build()
        }
    };
    Ok(agent)
}

/// One-shot completion through the configured provider.
pub async fn one_shot(root: &Path, system: &str, user: &str) -> Result<String> {
    let agent = build_bare_agent(root, system)?;
    let text = agent.prompt(user).await.map_err(|e| anyhow::anyhow!("{}", e))?;
    if text.trim().is_empty() {
        bail!("model returned an empty response");
    }
    Ok(text)
}

async fn notify(tx: &mpsc::Sender<String>, method: &str, params: Value) {
    let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    if let Ok(s) = serde_json::to_string(&msg) {
        let _ = tx.send(s).await;
    }
}

/// Build the full system prompt: agent identity + optional current-scene
/// context + explicitly attached files.
fn build_preamble(root: &Path, context: Option<&str>, attach: &[String]) -> String {
    let mut preamble = AGENT_PREAMBLE.to_string();
    if let Some(ctx) = context {
        if !ctx.trim().is_empty() {
            preamble.push_str("\n\n# Currently open scene\n");
            preamble.push_str(&ctx.chars().take(24_000).collect::<String>());
        }
    }
    for rel in attach.iter().take(8) {
        let Ok(path) = crate::resolve_path(root, rel) else { continue };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        preamble.push_str(&format!("\n\n# Attached by the writer: {}\n", rel));
        preamble.push_str(&content.chars().take(20_000).collect::<String>());
    }
    preamble
}

/// Live chat runs by id, so the writer can stop one mid-stream.
static RUNNING: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

fn running() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    RUNNING.get_or_init(Default::default)
}

/// Stop a running chat by id. Returns whether anything was running.
pub fn stop_chat(id: &str) -> bool {
    running().lock().unwrap().remove(id).is_some_and(|cancel| cancel.send(()).is_ok())
}

/// A chat run's entry in the cancellation registry; deregisters on drop, so
/// completion, stop, and error all clean up the same way.
struct RunHandle {
    id: String,
    cancelled: oneshot::Receiver<()>,
}

impl RunHandle {
    fn register(id: &str) -> Self {
        let (cancel, cancelled) = oneshot::channel();
        running().lock().unwrap().insert(id.to_string(), cancel);
        RunHandle { id: id.to_string(), cancelled }
    }
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        running().lock().unwrap().remove(&self.id);
    }
}

/// Run one rig conversation turn with streaming. Emits agents/delta, agents/tool,
/// agents/tool_done, and agents/error notifications tagged with `id`; returns the
/// full assistant text (and whether the writer stopped it) when the run ends.
pub async fn run_chat(
    root: &Path,
    tx: mpsc::Sender<String>,
    id: String,
    messages: &[Value],
    context: Option<&str>,
    attach: &[String],
) -> Result<(String, bool)> {
    use futures::StreamExt;
    use MultiTurnStreamItem as Item;
    use StreamedAssistantContent as Content;

    let (prompt, history) = split_messages(messages)?;
    let agent = build_agent(root, &build_preamble(root, context, attach))?;
    let mut run = RunHandle::register(&id);
    let mut stream = agent.stream_chat(Message::user(prompt), history).max_turns(8).await;

    let mut text = String::new();
    loop {
        let item = tokio::select! {
            _ = &mut run.cancelled => return Ok((text, true)),
            item = stream.next() => match item {
                Some(item) => item,
                None => return Ok((text, false)),
            },
        };
        match item {
            Ok(Item::StreamAssistantItem(Content::Text(t))) => {
                text.push_str(&t.text);
                notify(&tx, "agents/delta", json!({ "id": id, "text": t.text })).await;
            }
            Ok(Item::StreamAssistantItem(Content::ToolCall { tool_call, .. })) => {
                let params = json!({ "id": id, "name": tool_call.function.name, "args": tool_call.function.arguments });
                notify(&tx, "agents/tool", params).await;
            }
            Ok(Item::ToolExecutionCommitted { tool_call, .. }) => {
                notify(&tx, "agents/tool_done", json!({ "id": id, "name": tool_call.function.name })).await;
            }
            Ok(_) => {}
            Err(e) => {
                notify(&tx, "agents/error", json!({ "id": id, "message": e.to_string() })).await;
                bail!("model stream failed: {e}");
            }
        }
    }
}

// ---------- Continuity sweep ----------

const SWEEP_RUN_ID: &str = "continuity";

/// Find a verbatim quote in scene content: (1-based line, char col range).
/// Falls back to a case-insensitive match; multi-line quotes anchor on
/// their first line.
fn locate_quote(content: &str, quote: &str) -> Option<(usize, usize, usize)> {
    let needle = quote.lines().next().unwrap_or(quote).trim();
    if needle.is_empty() {
        return None;
    }
    let find = |case_sensitive: bool| {
        for (i, line) in content.lines().enumerate() {
            let hay =
                if case_sensitive { line.to_string() } else { line.to_lowercase() };
            let pat = if case_sensitive { needle.to_string() } else { needle.to_lowercase() };
            if let Some(byte_pos) = hay.find(&pat) {
                let col = line[..byte_pos].chars().count();
                return Some((i + 1, col, col + needle.chars().count()));
            }
        }
        None
    };
    find(true).or_else(|| find(false))
}

struct ReportFinding {
    root: PathBuf,
    tx: mpsc::Sender<String>,
}

#[derive(Deserialize)]
struct Evidence {
    file: String,
    quote: String,
}

#[derive(Deserialize)]
struct FindingArgs {
    file: String,
    quote: String,
    kind: String,
    message: String,
    #[serde(default)]
    evidence: Vec<Evidence>,
}

impl Tool for ReportFinding {
    const NAME: &'static str = "report_finding";
    type Args = FindingArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "Record one continuity finding. Call this once per defensible contradiction you have \
         verified. The quote must be copied verbatim from the scene being flagged (the LATER \
         passage — the one that breaks continuity), under 150 characters, on one line."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file": { "type": "string", "description": "Scene path containing the contradicting passage" },
                "quote": { "type": "string", "description": "Verbatim text from that scene (anchors the marker)" },
                "kind": { "type": "string", "enum": ["timeline", "fact", "knowledge", "object", "other"] },
                "message": { "type": "string", "description": "What contradicts what, concretely and briefly" },
                "evidence": {
                    "type": "array",
                    "description": "Where the earlier fact was established",
                    "items": {
                        "type": "object",
                        "properties": {
                            "file": { "type": "string" },
                            "quote": { "type": "string" }
                        },
                        "required": ["file", "quote"]
                    }
                }
            },
            "required": ["file", "quote", "kind", "message"]
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let path = crate::resolve_path(&self.root, &args.file).map_err(fail)?;
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", args.file))
            .map_err(fail)?;
        let anchored = locate_quote(&content, &args.quote);
        let line = anchored.map(|(l, _, _)| l).unwrap_or(1);

        let mut message = args.message.trim().to_string();
        for ev in args.evidence.iter().take(4) {
            message.push_str(&format!(" — established in {}: “{}”", ev.file, ev.quote.trim()));
        }

        let conn = db::open(&self.root).map_err(fail)?;
        conn.execute(
            "INSERT INTO assistant_findings (file, line, quote, kind, message, created)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![args.file, line as i64, args.quote, args.kind, message, db::now()],
        )
        .map_err(|e| ToolFail(e.to_string()))?;
        notify(&self.tx, "agents/finding", json!({ "file": args.file })).await;
        Ok(json!({ "recorded": true, "anchored": anchored.is_some() }))
    }
}

/// Stored findings for one scene as diagnostics, re-anchored to the current
/// text (the quote is searched again so edits don't strand the marker).
pub fn findings_for(root: &Path, rel: &str) -> Result<Vec<Value>> {
    let conn = db::open(root)?;
    let mut stmt = conn.prepare(
        "SELECT id, line, quote, kind, message FROM assistant_findings WHERE file = ?1",
    )?;
    let rows: Vec<(i64, i64, String, String, String)> = stmt
        .query_map([rel], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let content = crate::resolve_path(root, rel)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|(id, stored_line, quote, kind, message)| {
            let (line, col_start, col_end) =
                locate_quote(&content, &quote).unwrap_or((stored_line as usize, 0, 0));
            json!({
                "source": "assistant",
                "severity": "info",
                "file": rel,
                "line": line,
                "colStart": col_start,
                "colEnd": col_end,
                "text": quote.chars().take(60).collect::<String>(),
                "message": message,
                "ruleId": format!("ASSIST/{}", kind.to_uppercase()),
                "findingId": id,
            })
        })
        .collect())
}

pub fn dismiss_finding(root: &Path, id: i64) -> Result<()> {
    let conn = db::open(root)?;
    conn.execute("DELETE FROM assistant_findings WHERE id = ?1", [id])?;
    Ok(())
}

fn clear_findings(root: &Path, scope: Option<&str>) -> Result<()> {
    let conn = db::open(root)?;
    match scope {
        Some(file) => conn.execute("DELETE FROM assistant_findings WHERE file = ?1", [file])?,
        None => conn.execute("DELETE FROM assistant_findings", [])?,
    };
    Ok(())
}

fn sweep_preamble(root: &Path, files: &[String]) -> String {
    let scenes = files
        .iter()
        .enumerate()
        .map(|(i, f)| format!("{}. {}", i + 1, f))
        .collect::<Vec<_>>()
        .join("\n");
    let codex_lines = codex::list_entities(root)
        .ok()
        .and_then(|all| {
            all["entities"].as_array().map(|es| {
                es.iter()
                    .filter_map(|e| {
                        Some(format!(
                            "- {} ({}): {}",
                            e["name"].as_str()?,
                            e["kind"].as_str().unwrap_or(""),
                            e["summary"].as_str().unwrap_or("")
                        ))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        })
        .unwrap_or_default();
    format!(
        "You are the continuity editor for a novel, working inside the writer's IDE. Your job is \
         to find CONTRADICTIONS — not style, not taste, not deliberate mystery.\n\n\
         Scenes in reading order:\n{scenes}\n\nWorld bible:\n{codex_lines}\n\n\
         Method: call read_scene on each scene in order. Track what the text establishes — \
         physical details, timeline, who knows what and when, where objects are. When a later \
         passage contradicts something established earlier, verify with grep_manuscript or \
         search_manuscript, then call report_finding with a verbatim quote from the LATER \
         (contradicting) passage and evidence quotes from where the fact was established.\n\n\
         Report only defensible contradictions a careful reader would flag. Ambiguity, \
         intentional unreliability, and things a revision might intend are not findings. \
         When you have read every scene, reply with a one-paragraph summary of the sweep."
    )
}

/// Sweep the manuscript (or one scene) for continuity errors. Findings land
/// in the db as they are reported and surface as assistant diagnostics.
/// Returns (findings, model summary, stopped).
pub async fn run_continuity(
    root: &Path,
    tx: mpsc::Sender<String>,
    scope: Option<&str>,
) -> Result<(usize, String, bool)> {
    use futures::StreamExt;
    use MultiTurnStreamItem as Item;
    use StreamedAssistantContent as Content;

    if running().lock().unwrap().contains_key(SWEEP_RUN_ID) {
        bail!("a continuity sweep is already running");
    }
    let files = match scope {
        Some(f) => vec![f.to_string()],
        None => crate::list_md_files(root),
    };
    if files.is_empty() {
        bail!("no scenes to sweep");
    }
    clear_findings(root, scope)?;

    let cfg = ai::load_config(root);
    let root_buf = root.to_path_buf();
    let preamble = sweep_preamble(root, &files);
    let agent = match provider(root)? {
        Provider::OpenRouter(client) => AgentBuilder::new(client.completion_model(&cfg.model)),
        Provider::Compat(client) => AgentBuilder::new(client.completion_model(&cfg.model)),
    }
    .name("continuity")
    .preamble(&preamble)
    .tool(ReadScene { root: root_buf.clone() })
    .tool(GrepManuscript { root: root_buf.clone() })
    .tool(SearchManuscript { root: root_buf.clone() })
    .tool(QueryCodex { root: root_buf.clone() })
    .tool(ReportFinding { root: root_buf, tx: tx.clone() })
    .build();

    let mut run = RunHandle::register(SWEEP_RUN_ID);
    let max_turns = (files.len() * 3 + 12).min(80);
    let mut stream = agent
        .stream_chat(Message::user("Begin the sweep."), Vec::<Message>::new())
        .max_turns(max_turns)
        .await;

    let mut summary = String::new();
    let mut reported = 0usize;
    loop {
        let item = tokio::select! {
            _ = &mut run.cancelled => return Ok((reported, summary, true)),
            item = stream.next() => match item {
                Some(item) => item,
                None => return Ok((reported, summary, false)),
            },
        };
        match item {
            Ok(Item::StreamAssistantItem(Content::Text(t))) => summary.push_str(&t.text),
            Ok(Item::ToolExecutionCommitted { tool_call, .. }) => {
                let name = tool_call.function.name.as_str();
                if name == ReportFinding::NAME {
                    reported += 1;
                    notify(&tx, "agents/sweep", json!({ "note": format!("{} finding(s) so far", reported) })).await;
                } else if name == ReadScene::NAME {
                    let scene = tool_call.function.arguments["path"].as_str().unwrap_or("…");
                    notify(&tx, "agents/sweep", json!({ "note": format!("reading {}", scene) })).await;
                }
            }
            Ok(_) => {}
            Err(e) => {
                notify(&tx, "agents/error", json!({ "id": SWEEP_RUN_ID, "message": e.to_string() })).await;
                bail!("continuity sweep failed: {e}");
            }
        }
    }
}

// ---------- Field filling (codex "draft from manuscript") ----------

/// Draft a codex field from the manuscript: gather every passage that
/// mentions the entity (plus semantic neighbours when the index is live),
/// then ask the model to write just that field.
pub async fn fill_field(root: &Path, entity_id: i64, field: &str) -> Result<String> {
    let all = codex::list_entities(root)?;
    let entity = all["entities"]
        .as_array()
        .and_then(|es| es.iter().find(|e| e["id"].as_i64() == Some(entity_id)).cloned())
        .context("entity not found")?;
    let name = entity["name"].as_str().unwrap_or("").to_string();
    let kind = entity["kind"].as_str().unwrap_or("").to_string();
    let aliases: Vec<String> = entity["aliases"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // Passages around every indexed mention, grouped by scene
    let mut evidence = String::new();
    let mentions = codex::entity_mentions(root, entity_id)?;
    let mut by_file: std::collections::BTreeMap<String, Vec<usize>> = Default::default();
    if let Some(list) = mentions["mentions"].as_array() {
        for m in list.iter().take(60) {
            if let (Some(f), Some(l)) = (m["file"].as_str(), m["line"].as_u64()) {
                by_file.entry(f.to_string()).or_default().push(l as usize);
            }
        }
    }
    for (file, lines) in &by_file {
        let Ok(path) = crate::resolve_path(root, file) else { continue };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let all_lines: Vec<&str> = content.lines().collect();
        evidence.push_str(&format!("\n## {}\n", file));
        let mut last_end = 0usize;
        for &line in lines {
            let start = line.saturating_sub(2).max(1).max(last_end + 1);
            let end = (line + 1).min(all_lines.len());
            if start > end {
                continue;
            }
            evidence.push_str(&format!("[lines {}-{}]\n", start, end));
            for l in &all_lines[start - 1..end] {
                evidence.push_str(l);
                evidence.push('\n');
            }
            last_end = end;
        }
        if evidence.len() > 18_000 {
            break;
        }
    }

    // Semantic neighbours: passages about the entity that don't name it
    if embed::stats(root).map(|(_, c)| c > 0).unwrap_or(false)
        && embed::index_is_current_model(root)
    {
        let query = format!("{} {} {}", name, aliases.join(" "), kind);
        if let Ok(hits) = embed::search(root, &query, 4).await {
            evidence.push_str("\n## Related passages (by meaning)\n");
            for h in hits {
                evidence.push_str(&format!("[{} lines {}-{}]\n{}\n", h.file, h.start_line, h.end_line, h.text));
            }
        }
    }
    if evidence.trim().is_empty() {
        bail!("no manuscript passages mention \"{}\" yet — nothing to draft from", name);
    }
    let evidence: String = evidence.chars().take(24_000).collect();

    let instruction = match field {
        "summary" => {
            "Write the SUMMARY field: one crisp sentence (under 25 words) saying who or what this \
             is, at a glance. Output only the sentence."
        }
        "body" => {
            "Write the NOTES field: organized world-bible notes covering only what the manuscript \
             establishes — facts, relationships, history, physical details, and open questions \
             worth tracking. Short markdown bullets grouped under bold headers where it helps. \
             No invention beyond the text; mark uncertain readings with (?). Output only the notes."
        }
        other => bail!("unknown field: {}", other),
    };

    let system = "You maintain the world bible inside a fiction writer's IDE. You draft entry \
        fields strictly from manuscript passages the app provides. Never invent facts the text \
        does not support. Write in the writer's service: terse, concrete, spoiler-tolerant. \
        Output only the requested field content — no preamble, no code fences.";
    let user = format!(
        "Entity: {} (kind: {}){}\nCurrent summary: {}\nCurrent notes:\n{}\n\n{}\n\n# Manuscript passages\n{}",
        name,
        kind,
        if aliases.is_empty() { String::new() } else { format!(" — aliases: {}", aliases.join(", ")) },
        entity["summary"].as_str().unwrap_or("(empty)"),
        entity["body"].as_str().unwrap_or("(empty)"),
        instruction,
        evidence
    );

    let text = one_shot(root, system, &user).await?;
    Ok(text.trim().to_string())
}

/// The last message is the live prompt; everything before it is history.
fn split_messages(messages: &[Value]) -> Result<(String, Vec<Message>)> {
    let last = messages.last().context("empty message list")?;
    if last["role"].as_str() != Some("user") {
        bail!("last message must be from the user");
    }
    let prompt = last["content"].as_str().unwrap_or("").to_string();
    let history = messages[..messages.len() - 1]
        .iter()
        .filter_map(|m| {
            let content = m["content"].as_str()?.to_string();
            match m["role"].as_str()? {
                "user" => Some(Message::user(content)),
                "assistant" => Some(Message::assistant(content)),
                _ => None,
            }
        })
        .collect();
    Ok((prompt, history))
}
