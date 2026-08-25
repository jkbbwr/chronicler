use crate::{ai, codex, db, embed};
use anyhow::{bail, Context, Result};
use rig_agent::agent::{Agent, AgentBuilder, MultiTurnStreamItem};
use rig_agent::completion::Message;
use rig_agent::streaming::{StreamedAssistantContent, StreamingChat};
use rig_agent::tool::{Tool, ToolContext};
use rig_core::client::completion::CompletionClient;
use rig_core::client::embeddings::EmbeddingsClient;
use rig_core::embeddings::EmbeddingModel;
use rig_core::providers::{openai, openrouter};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

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
                "error": "The manuscript is not indexed yet. Ask the writer to run 'Rig: Index Manuscript' — falling back to grep_manuscript may help meanwhile."
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

/// Run one rig conversation turn with streaming. Emits agents/delta, agents/tool,
/// agents/tool_done, and agents/error notifications tagged with `id`; returns the
/// full assistant text when the run completes.
pub async fn run_chat(
    root: &Path,
    tx: mpsc::Sender<String>,
    id: String,
    messages: &[Value],
    context: Option<&str>,
    attach: &[String],
) -> Result<String> {
    use futures::StreamExt;

    let (prompt_text, history) = split_messages(messages)?;
    let preamble = build_preamble(root, context, attach);
    let agent = build_agent(root, &preamble)?;

    let mut stream = agent.stream_chat(Message::user(prompt_text), history).max_turns(8).await;

    let mut text = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t))) => {
                text.push_str(&t.text);
                notify(&tx, "agents/delta", json!({ "id": id, "text": t.text })).await;
            }
            Ok(MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall {
                tool_call,
                ..
            })) => {
                notify(
                    &tx,
                    "agents/tool",
                    json!({ "id": id, "name": tool_call.function.name, "args": tool_call.function.arguments }),
                )
                .await;
            }
            Ok(MultiTurnStreamItem::ToolExecutionCommitted { tool_call, .. }) => {
                notify(&tx, "agents/tool_done", json!({ "id": id, "name": tool_call.function.name }))
                    .await;
            }
            Ok(_) => {}
            Err(e) => {
                let msg = format!("{}", e);
                notify(&tx, "agents/error", json!({ "id": id, "message": msg })).await;
                bail!("model stream failed: {}", msg);
            }
        }
    }
    Ok(text)
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
