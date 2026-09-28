//! The rig's agent core, built on the `rig` crates: provider clients,
//! manuscript embeddings, read-only tools the model can call (semantic
//! search, grep, codex lookup, scene reads, the fact ledger), the run
//! registry for stoppable jobs, and every agent job (chat, continuity,
//! ledger, timeline, relations, synopses, hygiene, voice, critique, field
//! drafting).
//!
//! Hard boundary: agents never write to the manuscript.

use crate::app::App;
use crate::diagnostics::{DiagSource, Diagnostic, Severity};
use crate::events::Event;
use crate::fsx::{self, Matcher, RelPath};
use crate::rpc::invalid;
use crate::{ai, codex, db, embed};
use anyhow::{Context, Result, bail};
use parking_lot::Mutex;
use rig_agent::agent::{AgentBuilder, MultiTurnStreamItem, StreamingResult};
use rig_agent::completion::{Message, Prompt};
use rig_agent::streaming::{StreamedAssistantContent, StreamingChat};
use rig_agent::tool::{Tool, ToolContext};
use rig_core::client::completion::CompletionClient;
use rig_core::client::embeddings::EmbeddingsClient;
use rig_core::embeddings::EmbeddingModel;
use rig_core::providers::{openai, openrouter};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::watch;
use ts_rs::TS;

const AGENT_PREAMBLE: &str = "You are the writing companion inside a novelist's editor. The writer \
is the author; you are their well-read, candid first reader and continuity checker.\n\
\n\
What you do: answer questions about their book, find passages, check facts and continuity, and \
talk craft — pacing, structure, character, voice, clarity — grounded in their actual text.\n\
\n\
What you never do: write or rewrite their prose. No replacement sentences, no \"here's a revised \
version\", no drafted scenes or dialogue — even if asked. Instead say what isn't working and why, \
point at the exact words, and suggest directions in plain terms; the writing is theirs. \
Brainstorming in note form (possibilities, questions, lists) is fine; prose for the manuscript is \
not.\n\
\n\
Be brief and specific. Quote their words when you discuss them. Don't summarise their own book \
back to them, don't flatter, and say so when you don't know. Mind reading order: what a reader \
knows at a given scene is only what came before it.\n\
\n\
Tools (use them when they'd ground your answer in the text; skip them for pure craft talk):\n\
- search_manuscript: find passages by meaning (\"where does Veyra first doubt the Order?\").\n\
- grep_manuscript: exact words — names, phrases, counting occurrences.\n\
- query_codex: the writer's world bible. Check it before asserting facts about the world.\n\
- query_facts: the ledger of what each scene establishes, pre-extracted. Cheaper than reading \
scenes; start here for continuity questions.\n\
- read_scene: read one scene in full.\n\
- read_research: the writer's research folder — their notes and clipped articles. Background \
for the book, not part of it; list first, then read by path.\n\
\n\
Format replies in markdown. Cite scenes as clickable links in exactly this form — scene:// plus \
the project-relative path, in angle brackets, with an optional line anchor:\n\
[Cold Rain](<scene://01 The Arrival/01 Cold Rain.md#L12>)\n\
Only link paths you were given; never invent them.";

// ---------- Provider plumbing ----------

enum Provider {
    OpenRouter(openrouter::Client),
    Compat(openai::CompletionsClient),
}

fn provider(app: &App) -> Result<Provider> {
    let cfg = ai::config(app);
    match cfg.provider {
        ai::Provider::OpenRouter => {
            let key = app
                .ai
                .key()
                .context("No API key set — add one in Settings → AI")?;
            let client = if cfg.base_url.is_empty() {
                openrouter::Client::new(key)?
            } else {
                openrouter::Client::builder()
                    .api_key(key)
                    .base_url(cfg.base_url.clone())
                    .build()?
            };
            Ok(Provider::OpenRouter(client))
        }
        ai::Provider::OpenAiCompat => {
            if cfg.base_url.is_empty() {
                bail!("OpenAI-compatible provider needs a base URL (Settings → AI)");
            }
            let key = app.ai.key().unwrap_or_else(|| "sk-no-key".to_string());
            let client = openai::Client::builder()
                .api_key(key)
                .base_url(cfg.base_url.clone())
                .build()?
                .completions_api();
            Ok(Provider::Compat(client))
        }
    }
}

/// The embedding model to use: explicit config, or a sensible default per
/// provider (OpenRouter routes OpenAI's embedding models).
pub fn embed_model_name(app: &App) -> Result<String> {
    let cfg = ai::config(app);
    if !cfg.embed_model.is_empty() {
        return Ok(cfg.embed_model);
    }
    match cfg.provider {
        ai::Provider::OpenRouter => Ok("openai/text-embedding-3-small".to_string()),
        ai::Provider::OpenAiCompat => bail!(
            "Set an embedding model in Settings → AI (e.g. nomic-embed-text on Ollama, text-embedding-3-small on OpenAI)"
        ),
    }
}

/// Embed texts through the provider. Vectors come back L2-normalized so
/// cosine similarity reduces to a dot product.
pub async fn embed_texts(app: &App, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    let model_name = embed_model_name(app)?;
    let prov = provider(app)?;
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for batch in texts.chunks(32) {
        let embeddings = match &prov {
            Provider::OpenRouter(c) => c
                .embedding_model(&model_name)
                .embed_texts(batch.to_vec())
                .await
                .context("provider embeddings call")?,
            Provider::Compat(c) => c
                .embedding_model(&model_name)
                .embed_texts(batch.to_vec())
                .await
                .context("provider embeddings call")?,
        };
        if embeddings.len() != batch.len() {
            bail!(
                "provider returned {} embeddings for {} texts",
                embeddings.len(),
                batch.len()
            );
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

/// A builder for `task`'s model (from the tiers and overrides in Settings),
/// at the task's temperature.
fn model_builder(app: &App, task: ai::Task) -> Result<AgentBuilder> {
    let cfg = ai::config(app);
    let model = cfg.model_for(task).trim().to_string();
    if model.is_empty() {
        bail!("Choose a model for “{}” in Settings → AI", task.key());
    }
    let builder = match provider(app)? {
        Provider::OpenRouter(client) => AgentBuilder::new(client.completion_model(&model)),
        Provider::Compat(client) => AgentBuilder::new(client.completion_model(&model)),
    };
    Ok(builder.temperature(task.temperature()))
}

/// Is this error worth another try (rate limits, overload, timeouts)?
fn transient(e: &anyhow::Error) -> bool {
    let s = format!("{e:#}").to_lowercase();
    ["429", "rate limit", "rate-limit", "overloaded", "timed out", "timeout", "502", "503", "504", "connection reset", "temporarily"]
        .iter()
        .any(|k| s.contains(k))
}

/// Run an AI call, retrying transient failures twice with backoff.
async fn with_retry<T, Fut>(mut call: impl FnMut() -> Fut) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut delay = std::time::Duration::from_secs(2);
    let mut attempt = 0;
    loop {
        match call().await {
            Err(e) if attempt < 2 && transient(&e) => {
                tracing::warn!("AI call failed ({e:#}); retrying in {delay:?}");
                tokio::time::sleep(delay).await;
                delay *= 2;
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// One-shot completion for `task`.
pub async fn one_shot(app: &App, task: ai::Task, system: &str, user: &str) -> Result<String> {
    with_retry(|| async {
        let agent = model_builder(app, task)?.preamble(system).build();
        let text = agent.prompt(user).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        if text.trim().is_empty() {
            bail!("the model returned an empty response");
        }
        Ok(text)
    })
    .await
}

/// One-shot with schema-enforced structured output for `task`.
pub(crate) async fn one_shot_typed<T>(app: &App, task: ai::Task, system: &str, user: &str) -> Result<T>
where
    T: schemars::JsonSchema + serde::de::DeserializeOwned + Send + 'static,
{
    use rig_agent::completion::TypedPrompt;
    with_retry(|| async {
        let agent = model_builder(app, task)?.preamble(system).build();
        agent.prompt_typed::<T>(user).await.map_err(|e| anyhow::anyhow!("{e}"))
    })
    .await
}

/// Round trips to both model tiers. Returns their replies.
pub async fn test_connection(app: &App) -> Result<(String, String)> {
    let ask = |task| one_shot(app, task, "You are a connection test.", "Reply with the single word: ok");
    let fast = ask(ai::Task::Ledger).await.context("quick model")?;
    let deep = ask(ai::Task::Chat).await.context("careful model")?;
    Ok((fast, deep))
}

// ---------- Run registry ----------

/// Live runs by id, so the writer can stop one mid-flight and the same job
/// can't run twice at once.
type RunMap = Arc<Mutex<HashMap<String, (u64, watch::Sender<bool>)>>>;

#[derive(Default)]
pub struct Runs {
    map: RunMap,
    next: AtomicU64,
}

impl Runs {
    /// Register a run, or fail if one with this id is already live.
    pub fn try_register(&self, id: &str) -> Result<RunGuard> {
        let mut map = self.map.lock();
        if map.contains_key(id) {
            return Err(invalid(format!("the “{id}” job is already running")));
        }
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = watch::channel(false);
        map.insert(id.to_string(), (token, tx));
        Ok(RunGuard {
            id: id.to_string(),
            token,
            map: self.map.clone(),
            rx,
        })
    }

    /// Stop a run by id. Returns whether anything was running.
    pub fn stop(&self, id: &str) -> bool {
        match self.map.lock().remove(id) {
            Some((_, tx)) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.map.lock().contains_key(id)
    }
}

/// A live run's registration; deregisters on drop — but only its own entry,
/// never a newer run that reused the id after a stop.
pub struct RunGuard {
    id: String,
    token: u64,
    map: RunMap,
    rx: watch::Receiver<bool>,
}

impl RunGuard {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// Resolves once the run is stopped.
    pub async fn cancelled(&mut self) {
        let _ = self.rx.wait_for(|stopped| *stopped).await;
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut map = self.map.lock();
        if map
            .get(&self.id)
            .is_some_and(|(token, _)| *token == self.token)
        {
            map.remove(&self.id);
        }
    }
}

// ---------- Tools ----------

#[derive(Debug)]
pub struct ToolFail(String);

impl std::fmt::Display for ToolFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ToolFail {}

fn fail(e: anyhow::Error) -> ToolFail {
    ToolFail(format!("{e:#}"))
}

struct SearchManuscript {
    app: Arc<App>,
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
        let (files, chunks) = embed::stats(&self.app).map_err(fail)?;
        if chunks == 0 {
            return Ok(json!({
                "error": "Passage search isn't ready yet (the manuscript hasn't been read for it). Use grep_manuscript or query_facts instead."
            }));
        }
        let hits = embed::search(&self.app, &args.query, args.limit.unwrap_or(5).clamp(1, 12))
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
    app: Arc<App>,
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
        self.app
            .blocking(move |app| {
                let matcher = Matcher::new(&args.pattern, args.case_sensitive.unwrap_or(false))?;
                let mut matches = Vec::new();
                let mut total = 0usize;
                fsx::grep(&app.root, &matcher, |file, line, text| {
                    total += 1;
                    if matches.len() < 40 {
                        matches.push(json!({
                            "file": file,
                            "line": line,
                            "text": text.chars().take(240).collect::<String>(),
                        }));
                    }
                    ControlFlow::Continue(())
                });
                Ok(json!({ "totalMatches": total, "matches": matches }))
            })
            .await
            .map_err(fail)
    }
}

struct QueryCodex {
    app: Arc<App>,
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
        let entities = self.app.db.with(codex::list_entities).map_err(fail)?;
        let Some(name) = args.name.filter(|n| !n.trim().is_empty()) else {
            return Ok(json!({
                "entities": entities.iter().map(|e| json!({
                    "name": e.name, "kind": e.kind, "summary": e.summary,
                    "aliases": e.aliases, "mentions": e.mention_count,
                })).collect::<Vec<_>>(),
            }));
        };
        match entities.iter().find(|e| e.answers_to(&name)) {
            Some(e) => {
                let mentions = self
                    .app
                    .db
                    .with(|c| codex::entity_mentions(c, e.id))
                    .unwrap_or_default();
                Ok(json!({ "entity": e, "mentions": mentions }))
            }
            None => Ok(json!({
                "error": format!("No codex entry named \"{name}\""),
                "available": entities.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            })),
        }
    }
}

struct ReadScene {
    app: Arc<App>,
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
        let rel = RelPath::parse(&args.path).map_err(fail)?;
        let content = self.app.read(&rel).map_err(fail)?;
        let capped: String = content.chars().take(32_000).collect();
        Ok(json!({
            "path": rel.as_str(),
            "lines": content.lines().count(),
            "truncated": capped.len() < content.len(),
            "content": capped,
        }))
    }
}

struct QueryFacts {
    app: Arc<App>,
}

#[derive(Deserialize)]
struct FactsArgs {
    subject: Option<String>,
}

impl Tool for QueryFacts {
    const NAME: &'static str = "query_facts";
    type Args = FactsArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "The continuity ledger: facts each scene establishes (physical, timeline, knowledge, \
         object, relationship), pre-extracted. Filter by subject (name or keyword) or omit for \
         everything. Much cheaper than re-reading scenes."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "subject": { "type": "string", "description": "Name or keyword to filter by (optional)" }
            }
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let groups = ledger_facts(&self.app, args.subject.as_deref()).map_err(fail)?;
        Ok(json!({
            "scenes": groups.iter().map(|(file, facts)| json!({ "file": file, "facts": facts })).collect::<Vec<_>>(),
        }))
    }
}

/// The read-only tool loadout every investigative agent gets.
fn with_read_tools(
    builder: AgentBuilder,
    app: &Arc<App>,
) -> rig_agent::agent::AgentBuilder<rig_agent::agent::WithBuilderTools> {
    builder
        .tool(ReadScene { app: app.clone() })
        .tool(GrepManuscript { app: app.clone() })
        .tool(SearchManuscript { app: app.clone() })
        .tool(QueryCodex { app: app.clone() })
        .tool(QueryFacts { app: app.clone() })
}

// ---------- Streaming runs ----------

/// What a streaming run surfaced.
enum Step<'a> {
    Text(&'a str),
    ToolCall { name: &'a str, args: &'a Value },
    ToolDone { name: &'a str },
}

/// Drive a streaming agent run until it finishes or the writer stops it.
/// Returns whether it was stopped; model errors come back as `Err`.
async fn drive(
    mut stream: StreamingResult,
    run: &mut RunGuard,
    mut on: impl FnMut(Step<'_>),
) -> std::result::Result<bool, String> {
    use MultiTurnStreamItem as Item;
    use StreamedAssistantContent as Content;
    use futures::StreamExt;
    loop {
        let item = tokio::select! {
            _ = run.cancelled() => return Ok(true),
            item = stream.next() => match item {
                Some(item) => item,
                None => return Ok(false),
            },
        };
        match item {
            Ok(Item::StreamAssistantItem(Content::Text(t))) => on(Step::Text(&t.text)),
            Ok(Item::StreamAssistantItem(Content::ToolCall { tool_call, .. })) => {
                on(Step::ToolCall {
                    name: &tool_call.function.name,
                    args: &tool_call.function.arguments,
                })
            }
            Ok(Item::ToolExecutionCommitted { tool_call, .. }) => on(Step::ToolDone {
                name: &tool_call.function.name,
            }),
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn sweep_note(app: &App, job: &str, note: impl Into<String>) {
    app.emit(Event::AgentSweep {
        job: job.to_string(),
        note: note.into(),
    });
}

// ---------- Chat ----------

#[derive(Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Deserialize, TS, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// The built-in conversation prompt (shown in Settings as the starting point).
pub fn default_chat_prompt() -> &'static str {
    AGENT_PREAMBLE
}

/// Build the full system prompt: the conversation prompt (built-in or the
/// writer's) + their standing instructions + the book (brief and map) +
/// optional current-scene context + explicitly attached files.
fn build_preamble(app: &App, context: Option<&str>, attach: &[String]) -> String {
    let cfg = ai::config(app);
    let mut preamble = if cfg.chat_prompt.trim().is_empty() {
        AGENT_PREAMBLE.to_string()
    } else {
        cfg.chat_prompt.trim().to_string()
    };
    if !cfg.chat_instructions.trim().is_empty() {
        preamble.push_str("\n\n# The writer's standing instructions (follow them)\n");
        preamble.push_str(cfg.chat_instructions.trim());
    }
    let book = crate::book::context(app);
    if !book.is_empty() {
        preamble.push_str("\n\n");
        preamble.push_str(&book);
    }
    if let Some(ctx) = context.filter(|c| !c.trim().is_empty()) {
        preamble.push_str("\n\n# Currently open scene\n");
        preamble.push_str(&ctx.chars().take(24_000).collect::<String>());
    }
    for rel in attach.iter().take(8) {
        let Ok(rel) = RelPath::parse(rel) else {
            continue;
        };
        let Ok(content) = app.read(&rel) else {
            continue;
        };
        preamble.push_str(&format!("\n\n# Attached by the writer: {rel}\n"));
        preamble.push_str(&content.chars().take(20_000).collect::<String>());
    }
    preamble
}

/// Run one conversation turn with streaming. Emits agents/delta,
/// agents/tool, agents/tool_done, and agents/error tagged with `id`;
/// returns the full assistant text and whether the writer stopped it.
pub async fn run_chat(
    app: &Arc<App>,
    id: &str,
    messages: &[ChatMessage],
    context: Option<&str>,
    attach: &[String],
) -> Result<(String, bool)> {
    let (last, earlier) = messages
        .split_last()
        .ok_or_else(|| invalid("Missing param: messages"))?;
    if last.role != Role::User {
        return Err(invalid("the last message must be from the user"));
    }
    let history: Vec<Message> = earlier
        .iter()
        .map(|m| match m.role {
            Role::User => Message::user(m.content.clone()),
            Role::Assistant => Message::assistant(m.content.clone()),
        })
        .collect();
    let mut run = app.runs.try_register(id)?;
    let agent = with_read_tools(
        model_builder(app, ai::Task::Chat)?
            .name("rig")
            .preamble(&build_preamble(app, context, attach)),
        app,
    )
    .tool(crate::research::ResearchTool::new(app.clone()))
    .build();
    let stream = agent
        .stream_chat(Message::user(last.content.clone()), history)
        .max_turns(12)
        .await;

    let mut text = String::new();
    let outcome = drive(stream, &mut run, |step| match step {
        Step::Text(t) => {
            text.push_str(t);
            app.emit(Event::AgentDelta {
                id: id.to_string(),
                text: t.to_string(),
            });
        }
        Step::ToolCall { name, args } => app.emit(Event::AgentTool {
            id: id.to_string(),
            name: name.to_string(),
            args: args.clone(),
        }),
        Step::ToolDone { name, .. } => app.emit(Event::AgentToolDone {
            id: id.to_string(),
            name: name.to_string(),
        }),
    })
    .await;
    match outcome {
        Ok(stopped) => Ok((text, stopped)),
        Err(e) => {
            app.emit(Event::AgentError {
                id: id.to_string(),
                message: e.clone(),
            });
            bail!("model stream failed: {e}")
        }
    }
}

// ---------- Scenes for per-scene jobs ----------

pub(crate) struct Scene {
    pub rel: String,
    pub content: String,
}

/// Manuscript scenes in reading order (the binder's), Front/Back Matter
/// excluded, stubs under `min_words` skipped.
pub(crate) fn scenes(app: &App, min_words: usize) -> Vec<Scene> {
    crate::book::reading_order(app)
        .into_iter()
        .filter_map(|rel| {
            let content = std::fs::read_to_string(app.root.join(&rel)).ok()?;
            (content.split_whitespace().count() >= min_words).then_some(Scene { rel, content })
        })
        .collect()
}

/// Longest scene text sent to a model in one piece (~10k words). Longer
/// scenes are cut, and the model is told so.
const SCENE_CHARS: usize = 60_000;

/// A scene's text for a prompt, marked if it had to be cut.
pub fn scene_text(content: &str) -> String {
    if content.chars().count() <= SCENE_CHARS {
        return content.to_string();
    }
    let mut out: String = content.chars().take(SCENE_CHARS).collect();
    out.push_str("\n\n[… the scene continues; this is where the text was cut for length]");
    out
}

/// Stable content hash (FNV-1a) for change detection across restarts.
fn content_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Codex names (with aliases) for prompts, so models use the writer's names.
fn codex_names(entities: &[codex::Entity]) -> String {
    if entities.is_empty() {
        return "(none yet)".into();
    }
    entities
        .iter()
        .map(|e| if e.aliases.is_empty() { format!("{} ({})", e.name, e.kind) } else { format!("{} ({}; also {})", e.name, e.kind, e.aliases.join(", ")) })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Codex entries whose name or an alias appears in `text`.
pub(crate) fn entities_in<'a>(entities: &'a [codex::Entity], text: &str) -> Vec<&'a codex::Entity> {
    let lower = text.to_lowercase();
    entities
        .iter()
        .filter(|e| e.names().any(|n| n.chars().count() >= 2 && lower.contains(&n.to_lowercase())))
        .collect()
}

// ---------- Fact ledger ----------

const EXTRACT_FACTS: &str = "You build a continuity ledger for a novel: the facts one scene \
establishes, so later scenes can be checked against them.\n\
\n\
Record what a careful reader would need to catch a contradiction later:\n\
- physical details (appearance, injuries, clothing, weather, geography)\n\
- locations — who is where, and when\n\
- timeline — dates, times of day, durations, ages, what happened before what\n\
- knowledge — who learns or knows what (\"Maren learns that the ship sank\")\n\
- possessions — who has what, where objects are\n\
- relationships, and any state change (\"the bridge is destroyed\", \"Ilse no longer trusts Aron\")\n\
\n\
Rules:\n\
- Use the codex names given, so facts about the same subject line up across scenes.\n\
- basis: \"narrated\" when the story presents it as true; \"claimed\" when it is only what a \
character says, believes, suspects or lies about — and say who (\"Maren claims…\").\n\
- quote: copy the few words of the scene that establish it, verbatim.\n\
- Skip style, mood, themes and interpretation. One fact per sentence; roughly one fact per 100 \
words of scene, more for dense scenes.";

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
struct SceneFacts {
    facts: Vec<Fact>,
}

fn narrated() -> String {
    "narrated".into()
}

#[derive(Serialize, Deserialize, schemars::JsonSchema, Clone, Debug)]
pub struct Fact {
    /// One concrete sentence stating what the text establishes, using codex names.
    pub fact: String,
    /// physical | location | timeline | knowledge | possession | relationship | state_change | other
    pub kind: String,
    /// Who or what it's about — codex names where they exist.
    pub subjects: Vec<String>,
    /// Story-time marker, when the scene gives one.
    #[serde(default)]
    pub time: Option<String>,
    /// The scene's own words that establish it, verbatim (under 120 characters).
    #[serde(default)]
    pub quote: String,
    /// "narrated" (presented as true) or "claimed" (a character's word or belief).
    #[serde(default = "narrated")]
    pub basis: String,
}

/// Extract (or re-extract) one scene's facts if its text changed. Returns
/// whether it ran.
async fn update_scene_facts(app: &Arc<App>, scene: &Scene, names: &str, force: bool) -> Result<bool> {
    let hash = content_hash(&scene.content);
    let stored: Option<String> = app.db.with(|c| {
        Ok(c.query_row("SELECT hash FROM scene_facts WHERE file = ?1", [&scene.rel], |r| r.get(0))
            .optional()?)
    })?;
    if !force && stored.as_deref() == Some(hash.as_str()) {
        return Ok(false);
    }
    let prompt = format!(
        "Codex names: {names}\n\nScene: {} ({})\n\n{}",
        crate::book::display_name(&scene.rel),
        scene.rel,
        scene_text(&scene.content)
    );
    let extracted: SceneFacts = one_shot_typed(app, ai::Task::Ledger, EXTRACT_FACTS, &prompt).await?;
    let facts = serde_json::to_string(&extracted.facts)?;
    app.db.with(|c| {
        c.execute(
            "INSERT INTO scene_facts (file, hash, facts, extracted) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(file) DO UPDATE SET hash = excluded.hash, facts = excluded.facts,
             extracted = excluded.extracted",
            rusqlite::params![scene.rel, hash, facts, db::now()],
        )?;
        Ok(())
    })?;
    Ok(true)
}

/// Outcome of a ledger pass.
pub struct LedgerOutcome {
    pub updated: usize,
    pub total_facts: usize,
    /// Scenes that failed (after retries) and were skipped.
    pub failed: usize,
}

/// Bring the ledger up to date for `only` (or every scene). A failing scene
/// is skipped and counted, never fatal.
async fn refresh_ledger(app: &Arc<App>, only: Option<&[String]>, force: bool, run: Option<&RunGuard>) -> Result<LedgerOutcome> {
    let entities = app.db.with(codex::list_entities)?;
    let names = codex_names(&entities);
    let mut out = LedgerOutcome { updated: 0, total_facts: 0, failed: 0 };
    for scene in scenes(app, 20) {
        if run.is_some_and(|r| r.is_cancelled()) {
            break;
        }
        if only.is_some_and(|o| !o.contains(&scene.rel)) {
            continue;
        }
        match update_scene_facts(app, &scene, &names, force).await {
            Ok(true) => {
                out.updated += 1;
                sweep_note(app, "ledger", format!("noted facts: {}", crate::book::display_name(&scene.rel)));
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("fact extraction failed for {}: {e:#}", scene.rel);
                out.failed += 1;
            }
        }
    }
    out.total_facts = app.db.with(|c| {
        Ok(c.query_row("SELECT COALESCE(SUM(json_array_length(facts)), 0) FROM scene_facts", [], |r| r.get::<_, i64>(0))? as usize)
    })?;
    Ok(out)
}

/// (Re)extract facts for scenes whose content changed.
pub async fn ledger_update(app: &Arc<App>, force: bool) -> Result<LedgerOutcome> {
    let run = app.runs.try_register("ledger")?;
    refresh_ledger(app, None, force, Some(&run)).await
}

/// Every scene's facts, keyed by path.
pub(crate) fn ledger_by_scene(conn: &Connection) -> Result<HashMap<String, Vec<Fact>>> {
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT file, facts FROM scene_facts")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows.into_iter().map(|(file, raw)| (file, serde_json::from_str(&raw).unwrap_or_default())).collect())
}

/// All ledger facts in reading order, optionally filtered by subject.
pub fn ledger_facts(app: &App, subject: Option<&str>) -> Result<Vec<(String, Vec<Fact>)>> {
    let mut by_scene = app.db.with(ledger_by_scene)?;
    let needle = subject.map(str::to_lowercase).filter(|n| !n.is_empty());
    let mut out = Vec::new();
    for rel in crate::book::reading_order(app) {
        let Some(facts) = by_scene.remove(&rel) else { continue };
        let kept: Vec<Fact> = facts
            .into_iter()
            .filter(|f| match &needle {
                None => true,
                Some(n) => f.fact.to_lowercase().contains(n) || f.subjects.iter().any(|s| s.to_lowercase().contains(n)),
            })
            .collect();
        if !kept.is_empty() {
            out.push((rel, kept));
        }
    }
    Ok(out)
}

/// The ledger as a markdown report with scene links.
pub fn ledger_report(app: &App, subject: Option<&str>) -> Result<String> {
    let groups = ledger_facts(app, subject)?;
    if groups.is_empty() {
        return Ok("No facts noted yet.".into());
    }
    let mut md = match subject.filter(|s| !s.is_empty()) {
        Some(s) => format!("# Facts: {s}\n"),
        None => "# What the manuscript establishes\n".to_string(),
    };
    for (file, facts) in groups {
        md.push_str(&format!("\n## [{}](<scene://{file}>)\n", crate::book::display_name(&file)));
        for f in facts {
            let time = f.time.as_deref().map(|t| format!(" _({t})_")).unwrap_or_default();
            let claimed = if f.basis == "claimed" { " _(claimed)_" } else { "" };
            md.push_str(&format!("- **{}** {}{}{}\n", f.kind.replace('_', " "), f.fact, claimed, time));
        }
    }
    Ok(md)
}

// ---------- Findings (continuity + critique markers) ----------

/// Finding kinds the continuity sweep owns; critique owns "critique".
const CRITIQUE_KIND: &str = "critique";

/// Find a verbatim quote in scene content: (1-based line, char col range).
/// Falls back to a case-insensitive match; multi-line quotes anchor on
/// their first line.
fn locate_quote(content: &str, quote: &str) -> Option<(usize, usize, usize)> {
    let needle = quote.lines().next().unwrap_or(quote).trim();
    for case_sensitive in [true, false] {
        let matcher = Matcher::new(needle, case_sensitive).ok()?;
        for (i, line) in content.lines().enumerate() {
            if let Some(r) = matcher.find_all(line).first() {
                let col = line[..r.start].chars().count();
                let end = col + line[r.clone()].chars().count();
                return Some((i + 1, col, end));
            }
        }
    }
    None
}

/// Stored findings for one scene as diagnostics, re-anchored to the current
/// text (the quote is searched again so edits don't strand the marker).
pub fn findings_for(conn: &Connection, rel: &str, content: &str) -> Result<Vec<Diagnostic>> {
    let rows: Vec<(i64, i64, String, String, String)> = conn
        .prepare("SELECT id, line, quote, kind, message FROM assistant_findings WHERE file = ?1")?
        .query_map([rel], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, stored_line, quote, kind, message)| {
            let (line, col_start, col_end) =
                locate_quote(content, &quote).unwrap_or((stored_line.max(1) as usize, 0, 0));
            Diagnostic {
                source: DiagSource::Assistant,
                severity: Severity::Info,
                file: rel.to_string(),
                line,
                col_start,
                col_end,
                text: quote.chars().take(60).collect(),
                message,
                rule_id: format!("ASSIST/{}", kind.to_uppercase()),
                replacements: vec![],
                finding_id: Some(id),
            }
        })
        .collect())
}

pub fn dismiss_finding(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM assistant_findings WHERE id = ?1", [id])?;
    Ok(())
}

// ---------- Continuity ----------
//
// Each scene is checked against the ledger facts of the scenes before it
// (the ones that share its people and places first, the latest state of
// things preferred), in one structured call. Quotes are verified in code:
// a finding whose words aren't in the scene, or whose cited fact doesn't
// exist, is dropped. A scene is only re-checked when its text or the facts
// it was checked against change, so this is cheap enough to run on save.

const CONTINUITY_SYSTEM: &str = "You are the continuity editor for a novel. You check ONE scene \
against facts established by the scenes BEFORE it (each with an id like F12). When the scene's \
point of view is given, remember that character only knows what they've seen or been told.\n\
\n\
Report a contradiction only when this scene states or shows something that cannot be true given \
an earlier NARRATED fact: a physical detail, where someone is, timing or age, who has what, who \
knows what, or a state that changed.\n\
\n\
Not contradictions: a character lying, misremembering or being wrong (\"claimed\" facts can be \
false); new information that adds to earlier facts; time having plausibly passed; deliberate \
mysteries and reveals; dreams, flashbacks and hypotheticals; anything the writer's notes say is \
intentional. When unsure, leave it out — a false alarm costs the writer more than a miss.\n\
\n\
For each contradiction, quote the clashing words from THIS scene verbatim (one line, under 150 \
characters) and cite the id of the earlier fact. Most scenes have none; an empty list is the \
usual answer.";

#[derive(Deserialize, schemars::JsonSchema)]
struct SceneCheck {
    contradictions: Vec<Contradiction>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct Contradiction {
    /// Verbatim words from THIS scene that contradict (one line, under 150 characters).
    quote: String,
    /// Id of the earlier fact it contradicts, e.g. "F12".
    contradicts: String,
    /// timeline | physical | location | knowledge | possession | other
    kind: String,
    /// One or two sentences: what clashes with what, concretely.
    message: String,
    /// high = a careful reader would certainly flag it; medium = likely; low = possible.
    confidence: String,
}

/// Budget for earlier facts in one check.
const FACT_CHARS: usize = 40_000;

struct EarlierFact<'a> {
    rel: &'a str,
    fact: &'a Fact,
}

/// Earlier facts for scene `idx`: those about subjects in this scene
/// first (latest first, as the latest state is what can be contradicted),
/// then time-anchored ones, within the budget; returned in reading order.
fn facts_for_check<'a>(
    order: &'a [String],
    idx: usize,
    by_scene: &'a HashMap<String, Vec<Fact>>,
    present: &[&codex::Entity],
) -> Vec<EarlierFact<'a>> {
    let names: Vec<String> = present.iter().flat_map(|e| e.names()).map(|n| n.to_lowercase()).collect();
    let about_present = |f: &Fact| {
        f.subjects.iter().any(|s| names.contains(&s.to_lowercase()))
            || names.iter().any(|n| f.fact.to_lowercase().contains(n.as_str()))
    };
    let earlier: Vec<EarlierFact> = order[..idx]
        .iter()
        .flat_map(|rel| by_scene.get(rel).into_iter().flatten().map(move |fact| EarlierFact { rel, fact }))
        .collect();
    let mut chosen = std::collections::BTreeSet::new();
    let mut used = 0usize;
    let passes: [&dyn Fn(&Fact) -> bool; 2] = [&about_present, &|f: &Fact| f.time.is_some() || f.kind == "timeline"];
    for wanted in passes {
        for (i, ef) in earlier.iter().enumerate().rev() {
            if chosen.contains(&i) || !wanted(ef.fact) {
                continue;
            }
            let size = ef.fact.fact.len() + ef.fact.quote.len() + 60;
            if used + size <= FACT_CHARS {
                used += size;
                chosen.insert(i);
            }
        }
    }
    earlier.into_iter().enumerate().filter(|(i, _)| chosen.contains(i)).map(|(_, f)| f).collect()
}

fn settings_key(rel: &str) -> String {
    format!("continuity:{rel}")
}

/// Check one scene. Returns the findings recorded, or None if it was
/// unchanged since its last check (and not forced).
#[allow(clippy::too_many_arguments)]
async fn check_scene(
    app: &Arc<App>,
    order: &[String],
    idx: usize,
    by_scene: &HashMap<String, Vec<Fact>>,
    entities: &[codex::Entity],
    brief: &str,
    labels: &HashMap<String, String>,
    force: bool,
) -> Result<Option<usize>> {
    let rel = &order[idx];
    let content = app.read(&RelPath::parse(rel)?)?;
    let present = entities_in(entities, &content);
    let earlier = facts_for_check(order, idx, by_scene, &present);

    let mut listing = String::new();
    for (i, ef) in earlier.iter().enumerate() {
        let quote = if ef.fact.quote.is_empty() { String::new() } else { format!(" — “{}”", ef.fact.quote) };
        listing.push_str(&format!(
            "F{} [{}] ({}) {}{}\n",
            i + 1,
            crate::book::display_name(ef.rel),
            ef.fact.basis,
            ef.fact.fact,
            quote
        ));
    }
    // Whose eyes and when: lets the check tell limited knowledge from error.
    let details = labels.get(rel).map(|l| format!(" — {l}")).unwrap_or_default();
    let signature = content_hash(&format!("{content}\u{1}{listing}\u{1}{brief}\u{1}{details}"));
    let key = settings_key(rel);
    if !force && app.db.get_setting(&key)?.as_deref() == Some(signature.as_str()) {
        return Ok(None);
    }

    let found: Vec<Contradiction> = if earlier.is_empty() {
        Vec::new() // nothing before it to contradict
    } else {
        let codex_lines = present
            .iter()
            .map(|e| format!("- {} ({}): {}", e.name, e.kind, e.summary))
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "{brief}\n\n# Facts established earlier\n{listing}\n# Codex entries in this scene\n{}\n\n# This scene: {}{details} (scene {} of {})\n{}",
            if codex_lines.is_empty() { "(none)".into() } else { codex_lines },
            crate::book::display_name(rel),
            idx + 1,
            order.len(),
            scene_text(&content)
        );
        let check: SceneCheck = one_shot_typed(app, ai::Task::Continuity, CONTINUITY_SYSTEM, &prompt).await?;
        check.contradictions
    };

    // Verify in code, then replace this scene's continuity findings.
    let mut rows = Vec::new();
    for c in found {
        if c.confidence.eq_ignore_ascii_case("low") {
            continue;
        }
        let Some((line, _, _)) = locate_quote(&content, &c.quote) else { continue };
        let Some(ef) = c
            .contradicts
            .trim()
            .trim_start_matches(['F', 'f'])
            .parse::<usize>()
            .ok()
            .and_then(|n| earlier.get(n.wrapping_sub(1)))
        else {
            continue;
        };
        let established = if ef.fact.quote.is_empty() { ef.fact.fact.clone() } else { format!("“{}”", ef.fact.quote) };
        let message = format!(
            "{} — established in {}: {}",
            c.message.trim(),
            crate::book::display_name(ef.rel),
            established
        );
        let kind = if c.kind == CRITIQUE_KIND { "other".to_string() } else { c.kind };
        rows.push((line as i64, c.quote, kind, message));
    }
    let count = rows.len();
    app.db.tx(|tx| {
        tx.execute("DELETE FROM assistant_findings WHERE file = ?1 AND kind != ?2", [rel.as_str(), CRITIQUE_KIND])?;
        for (line, quote, kind, message) in &rows {
            tx.execute(
                "INSERT INTO assistant_findings (file, line, quote, kind, message, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![rel, line, quote, kind, message, db::now()],
            )?;
        }
        db::set_setting(tx, &key, &signature)?;
        Ok(())
    })?;
    app.emit(Event::AgentFinding { file: rel.clone() });
    Ok(Some(count))
}

/// Outcome of a continuity pass.
pub struct ContinuityOutcome {
    pub findings: usize,
    pub checked: usize,
    pub unchanged: usize,
    pub failed: usize,
    pub stopped: bool,
}

impl ContinuityOutcome {
    pub fn summary(&self) -> String {
        let mut s = format!(
            "Checked {} scene{}; {} contradiction{} found.",
            self.checked,
            if self.checked == 1 { "" } else { "s" },
            self.findings,
            if self.findings == 1 { "" } else { "s" }
        );
        if self.unchanged > 0 {
            s.push_str(&format!(" {} unchanged since the last check.", self.unchanged));
        }
        if self.failed > 0 {
            s.push_str(&format!(" {} couldn't be checked (the AI provider failed).", self.failed));
        }
        s
    }
}

/// Check continuity for `scope` (one scene), `only` (a set, e.g. on save),
/// or the whole book. The ledger is brought up to date first.
async fn continuity_pass(app: &Arc<App>, only: Option<Vec<String>>, force: bool, run: Option<&RunGuard>) -> Result<ContinuityOutcome> {
    const JOB: &str = "continuity";
    // Everything before the scenes being checked must have current facts.
    let order = crate::book::reading_order(app);
    let last = match &only {
        Some(files) => files.iter().filter_map(|f| order.iter().position(|o| o == f)).max(),
        None => order.len().checked_sub(1),
    };
    let Some(last) = last else {
        return Ok(ContinuityOutcome { findings: 0, checked: 0, unchanged: 0, failed: 0, stopped: false });
    };
    sweep_note(app, JOB, "noting what earlier scenes establish…");
    let ledger = refresh_ledger(app, Some(&order[..=last]), false, run).await?;

    let by_scene = app.db.with(ledger_by_scene)?;
    let entities = app.db.with(codex::list_entities)?;
    let brief = {
        let b = crate::book::brief_text(&crate::book::info(app));
        if b.is_empty() { String::new() } else { format!("# About this book (from the writer)\n{b}") }
    };
    let labels = crate::story::detail_labels(app);
    let targets: Vec<usize> = match &only {
        Some(files) => files.iter().filter_map(|f| order.iter().position(|o| o == f)).collect(),
        None => (0..order.len()).collect(),
    };

    let mut out = ContinuityOutcome { findings: 0, checked: 0, unchanged: 0, failed: ledger.failed, stopped: false };
    for (n, idx) in targets.into_iter().enumerate() {
        if run.is_some_and(|r| r.is_cancelled()) {
            out.stopped = true;
            break;
        }
        sweep_note(app, JOB, format!("checking {} ({})", crate::book::display_name(&order[idx]), n + 1));
        match check_scene(app, &order, idx, &by_scene, &entities, &brief, &labels, force).await {
            Ok(Some(found)) => {
                out.checked += 1;
                out.findings += found;
            }
            Ok(None) => out.unchanged += 1,
            Err(e) => {
                tracing::warn!("continuity check failed for {}: {e:#}", order[idx]);
                out.failed += 1;
            }
        }
    }
    // Findings still standing from scenes that weren't re-checked count too.
    if only.is_none() {
        out.findings = app.db.with(|c| {
            Ok(c.query_row("SELECT COUNT(*) FROM assistant_findings WHERE kind != ?1", [CRITIQUE_KIND], |r| r.get::<_, i64>(0))? as usize)
        })?;
    }
    Ok(out)
}

/// The writer asked: check one scene (always re-checked) or the whole book
/// (unchanged scenes skipped).
pub async fn run_continuity(app: &Arc<App>, scope: Option<&RelPath>) -> Result<ContinuityOutcome> {
    let run = app.runs.try_register("continuity")?;
    match scope {
        Some(rel) => continuity_pass(app, Some(vec![rel.as_str().to_string()]), true, Some(&run)).await,
        None => continuity_pass(app, None, false, Some(&run)).await,
    }
}

/// On save: keep facts current and (if enabled) check the changed scenes.
/// Quietly does nothing when a writer-started job holds the lock.
pub async fn on_scenes_saved(app: &Arc<App>, files: &[String]) {
    let cfg = ai::config(app);
    if !ai::usable(app) || (!cfg.ledger_on_save && !cfg.live_continuity) {
        return;
    }
    let Ok(run) = app.runs.try_register("live") else { return };
    if app.runs.is_running("continuity") || app.runs.is_running("ledger") {
        return;
    }
    let result = if cfg.live_continuity {
        continuity_pass(app, Some(files.to_vec()), false, Some(&run)).await.map(|_| ())
    } else {
        refresh_ledger(app, Some(files), false, Some(&run)).await.map(|_| ())
    };
    if let Err(e) = result {
        tracing::warn!("background continuity failed: {e:#}");
    }
}

// ---------- Story timeline ----------

const TIMELINE_SYSTEM: &str = "You reconstruct the story-time timeline of a novel from what its \
scenes establish. Order events by when they happen IN THE STORY WORLD — not by reading order: \
backstory and flashbacks go where they happened. Produce 5 to 30 events, each a distinct beat or \
era with a clear time anchor or strong sequence evidence; merge scenes that share a moment. Keep \
labels relative when the book is (\"two days later\"). Use the scene paths exactly as given.";

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
struct Timeline {
    /// Events in story-chronological order.
    events: Vec<TimelineEvent>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema, TS, Clone, Debug)]
pub struct TimelineEvent {
    /// Short story-time label, e.g. "Years ago — the Siege", "Dawn, two days later".
    pub when: String,
    /// One sentence: what happens.
    pub what: String,
    /// Scene paths where this is established or shown.
    pub scenes: Vec<String>,
}

/// The persisted story timeline.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredTimeline {
    /// Unix seconds.
    pub built_at: i64,
    /// Story-chronological.
    pub events: Vec<TimelineEvent>,
}

/// Budget for ledger digests (timeline, relationships).
const DIGEST_CHARS: usize = 60_000;

/// Build the story timeline from the time-bearing facts of every scene (one
/// typed call) and persist it.
pub async fn timeline_build(app: &Arc<App>) -> Result<StoredTimeline> {
    let _run = app.runs.try_register("timeline")?;
    let groups = ledger_facts(app, None)?;
    if groups.is_empty() {
        bail!("no facts noted yet — update the fact ledger first");
    }
    let meta = app.db.with(|c| Ok(crate::book::scene_meta(c)))?;
    let mut digest = String::from("Scenes in reading order, with their time-related facts:\n");
    let mut cut = false;
    for (file, facts) in &groups {
        let mut block = format!("\n## {file}\n");
        if let Some((synopsis, _)) = meta.get(file).filter(|(s, _)| !s.trim().is_empty()) {
            block.push_str(&format!("(synopsis: {})\n", synopsis.trim()));
        }
        for f in facts.iter().filter(|f| f.time.is_some() || matches!(f.kind.as_str(), "timeline" | "state_change" | "location")) {
            let time = f.time.as_deref().map(|t| format!(" [time: {t}]")).unwrap_or_default();
            block.push_str(&format!("- {}{}\n", f.fact, time));
        }
        if digest.len() + block.len() > DIGEST_CHARS {
            cut = true;
            break;
        }
        digest.push_str(&block);
    }
    if cut {
        tracing::warn!("timeline digest reached its budget; later scenes left out");
    }
    let timeline: Timeline = one_shot_typed(app, ai::Task::Timeline, TIMELINE_SYSTEM, &digest).await?;
    let stored = StoredTimeline { built_at: db::now(), events: timeline.events };
    app.db.set_setting("timeline", &serde_json::to_string(&stored)?)?;
    Ok(stored)
}

pub fn timeline_get(conn: &Connection) -> Result<Option<StoredTimeline>> {
    Ok(db::get_setting(conn, "timeline")?.and_then(|s| serde_json::from_str(&s).ok()))
}

// ---------- Relationship derivation ----------

const RELATIONS_SYSTEM: &str = "You map relationships between the entities of a novel's world \
bible, using the fact ledger and entity notes. Report only relationships the text supports: \
kinship, allegiance, employment, rivalry, ownership, location ties (\"guards\", \"built on\", \
\"haunts\"). Labels are short and directional, read as: FROM --label--> TO (e.g. \"captain of\", \
\"distrusts\", \"sealed behind\"). Use exact entity names from the list. Where a relationship \
changes over the book, describe where it ends up. 3-40 relations.";

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
struct DerivedRelations {
    relations: Vec<DerivedRelation>,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
struct DerivedRelation {
    /// Exact entity name the relation points from.
    from: String,
    /// Exact entity name the relation points to.
    to: String,
    /// Short directional label, e.g. "captain of", "sealed behind".
    label: String,
}

/// Derive typed relations between codex entities from relationship facts
/// and facts that involve two or more of them (replaces previous
/// agent-derived links; the writer's own links are untouched). Returns
/// links stored.
pub async fn relations_build(app: &Arc<App>) -> Result<usize> {
    let _run = app.runs.try_register("relations")?;
    let entities = app.db.with(codex::list_entities)?;
    if entities.len() < 2 {
        bail!("need at least two codex entries to find links");
    }
    let mut ids: HashMap<String, i64> = HashMap::new();
    let mut context = String::from("Entities:\n");
    for e in &entities {
        for n in e.names() {
            ids.insert(n.to_lowercase(), e.id);
        }
        context.push_str(&format!("- {} ({}): {}\n", e.name, e.kind, e.summary));
    }
    context.push_str("\nFacts involving them, in reading order:\n");
    let known = |s: &str| ids.contains_key(&s.to_lowercase());
    for (file, facts) in ledger_facts(app, None)? {
        for f in facts {
            let involved = f.subjects.iter().filter(|s| known(s)).count();
            if f.kind == "relationship" || involved >= 2 {
                let line = format!("- [{}] {}\n", crate::book::display_name(&file), f.fact);
                if context.len() + line.len() > DIGEST_CHARS {
                    break;
                }
                context.push_str(&line);
            }
        }
    }

    let derived: DerivedRelations = one_shot_typed(app, ai::Task::Relations, RELATIONS_SYSTEM, &context).await?;
    let edges: Vec<(i64, i64, String)> = derived
        .relations
        .into_iter()
        .filter_map(|r| {
            let from = *ids.get(&r.from.to_lowercase())?;
            let to = *ids.get(&r.to.to_lowercase())?;
            let label = r.label.trim().to_string();
            (from != to && !label.is_empty()).then_some((from, to, label))
        })
        .collect();
    app.db.tx(|tx| codex::relations_replace_llm(tx, &edges))
}

// ---------- Synopsis drafting (index cards) ----------

const SYNOPSIS_SYSTEM: &str = "You write index-card synopses for a novelist's own scenes. \
2-3 sentences, present tense, concrete: whose scene it is, what they do, what changes, what it \
sets up. Use the characters' names. The writer knows their book — no praise, no hedging, no \
themes. Output only the synopsis.";

/// Draft synopses for scenes that don't have one. Returns scenes drafted;
/// a scene that fails is skipped.
pub async fn draft_synopses(app: &Arc<App>) -> Result<usize> {
    const JOB: &str = "synopses";
    let run = app.runs.try_register(JOB)?;
    let meta = app.db.with(|c| Ok(crate::book::scene_meta(c)))?;
    let mut drafted = 0usize;
    let mut previous: Option<String> = None;
    for scene in scenes(app, 30) {
        if run.is_cancelled() {
            break;
        }
        let existing = meta.get(&scene.rel).map(|(s, _)| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(existing) = existing {
            previous = Some(existing);
            continue;
        }
        sweep_note(app, JOB, format!("drafting a synopsis: {}", crate::book::display_name(&scene.rel)));
        let before = previous.as_deref().map(|p| format!("The scene before: {p}\n\n")).unwrap_or_default();
        let prompt = format!("{before}Scene: {}\n\n{}", crate::book::display_name(&scene.rel), scene_text(&scene.content));
        match one_shot(app, ai::Task::Synopses, SYNOPSIS_SYSTEM, &prompt).await {
            Ok(synopsis) => {
                let synopsis = synopsis.trim().to_string();
                app.db.with(|c| {
                    c.execute(
                        "INSERT INTO scene_meta (file, synopsis, status) VALUES (?1, ?2, '')
                         ON CONFLICT(file) DO UPDATE SET synopsis = excluded.synopsis",
                        rusqlite::params![scene.rel, synopsis],
                    )?;
                    Ok(())
                })?;
                previous = Some(synopsis);
                drafted += 1;
            }
            Err(e) => tracing::warn!("synopsis failed for {}: {e:#}", scene.rel),
        }
    }
    Ok(drafted)
}

// ---------- Codex hygiene sweep ----------

struct SuggestCodexChange {
    app: Arc<App>,
}

#[derive(Deserialize)]
struct HygieneArgs {
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    summary: String,
    reason: String,
    alias_of: Option<String>,
}

impl Tool for SuggestCodexChange {
    const NAME: &'static str = "suggest_codex_change";
    type Args = HygieneArgs;
    type Output = Value;
    type Error = ToolFail;

    fn description(&self) -> String {
        "File one codex suggestion for the writer's Discovered inbox: a missing entity \
         (name + kind + summary), or another name for an existing entry (set alias_of to that \
         entry's exact name). The writer approves or rejects each. Always give the reason."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "kind": { "type": "string", "enum": ["character", "place", "item", "faction", "creature", "event", "lore", ""] },
                "summary": { "type": "string", "description": "One sentence for a new entity" },
                "reason": { "type": "string", "description": "Why this belongs in the codex" },
                "alias_of": { "type": "string", "description": "Existing entity this name is a variant of" }
            },
            "required": ["name", "reason"]
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ToolFail> {
        let entities = self.app.db.with(codex::list_entities).map_err(fail)?;
        let alias_target = args.alias_of.as_deref().and_then(|t| entities.iter().find(|e| e.answers_to(t)));
        let kind = if codex::KINDS.contains(&args.kind.as_str()) { args.kind } else { String::new() };
        let summary = match alias_target {
            Some(t) => format!("Possibly another name for {}.", t.name),
            None => args.summary,
        };
        let candidate = codex::Candidate {
            name: args.name,
            kind_guess: kind,
            source: "hygiene".into(),
            summary,
            context: args.reason,
            line: 0,
        };
        let new = self
            .app
            .db
            .tx(|tx| codex::record_candidates(tx, "(hygiene)", &[candidate]))
            .map_err(fail)?;
        Ok(json!({ "queued": new > 0 }))
    }
}

/// Review the codex against the manuscript; every suggestion (including
/// "another name for…") lands in the Discovered inbox for the writer.
/// Returns (suggestions, summary, stopped).
pub async fn hygiene_sweep(app: &Arc<App>) -> Result<(usize, String, bool)> {
    const JOB: &str = "hygiene";
    let mut run = app.runs.try_register(JOB)?;
    let preamble = format!(
        "You are auditing the world bible (codex) of a novel against its manuscript. Find: \
         (1) recurring proper nouns with no codex entry — check query_codex, verify with \
         grep_manuscript; (2) other names for existing entries (nicknames, titles, surnames) not \
         listed as aliases; (3) entries whose summary no longer matches what the manuscript \
         establishes (query_facts helps). File each with suggest_codex_change. Be conservative: \
         only names that recur or matter. Finish with a one-paragraph summary.\n\n{}",
        crate::book::context(app)
    );
    let agent = with_read_tools(model_builder(app, ai::Task::Hygiene)?.name("hygiene").preamble(&preamble), app)
        .tool(SuggestCodexChange { app: app.clone() })
        .build();
    let stream = agent
        .stream_chat(Message::user("Begin the audit."), Vec::<Message>::new())
        .max_turns(40)
        .await;
    let mut summary = String::new();
    let mut suggestions = 0usize;
    let outcome = drive(stream, &mut run, |step| match step {
        Step::Text(t) => summary.push_str(t),
        Step::ToolDone { name, .. } => {
            if name == SuggestCodexChange::NAME {
                suggestions += 1;
            }
            sweep_note(
                app,
                JOB,
                format!("codex audit: {suggestions} suggestion(s)"),
            );
        }
        Step::ToolCall { .. } => {}
    })
    .await;
    match outcome {
        Ok(stopped) => Ok((suggestions, summary, stopped)),
        Err(e) => {
            app.emit(Event::AgentError {
                id: JOB.into(),
                message: e.clone(),
            });
            bail!("hygiene sweep failed: {e}")
        }
    }
}

// ---------- Character voice report ----------

const VOICE_SYSTEM: &str = "You analyse how one character sounds in a novelist's own book, \
from the passages the app gathered around their appearances (dialogue is marked). Write a \
markdown report with these sections:\n\
**How they sound** — register, rhythm, vocabulary, verbal habits, each with quoted examples.\n\
**Signature moves** — what they do in conversation that no one else does.\n\
**Drift** — lines where the voice slips out of character, each quoted and cited as a link.\n\
**Pin-up guide** — one line the writer could keep beside the page.\n\
Quote generously, never invent lines, and cite scenes exactly as [Scene name](<scene://path#L12>) \
using the paths and line numbers given. Don't rewrite their lines.";

/// Opening/closing quote marks (not apostrophes, which are everywhere).
const DIALOGUE_MARKS: [char; 4] = ['"', '“', '”', '‘'];

/// A markdown report on how one character sounds across the manuscript:
/// the passages around every mention (dialogue first) are gathered here,
/// then read in one call.
pub async fn voice_report(app: &Arc<App>, entity_id: i64) -> Result<String> {
    let (entity, mentions) = app.db.with(|c| Ok((codex::get_entity(c, entity_id)?, codex::entity_mentions(c, entity_id)?)))?;
    let order = crate::book::reading_order(app);
    let mut by_file: std::collections::BTreeMap<usize, (String, Vec<usize>)> = Default::default();
    for m in &mentions {
        let pos = order.iter().position(|o| *o == m.file).unwrap_or(usize::MAX);
        by_file.entry(pos).or_insert_with(|| (m.file.clone(), Vec::new())).1.push(m.line.max(1) as usize);
    }
    let mut evidence = String::new();
    let mut dialogue_lines = 0usize;
    'files: for (file, lines) in by_file.values() {
        let Ok(content) = std::fs::read_to_string(app.root.join(file)) else { continue };
        let all: Vec<&str> = content.lines().collect();
        let mut taken = std::collections::BTreeSet::new();
        for &line in lines {
            for l in line.saturating_sub(1).max(1)..=(line + 2).min(all.len()) {
                let text = all[l - 1].trim();
                if !text.is_empty() && text.contains(DIALOGUE_MARKS) {
                    taken.insert(l);
                }
            }
        }
        if taken.is_empty() {
            continue;
        }
        evidence.push_str(&format!("\n## {} <{file}>\n", crate::book::display_name(file)));
        for l in taken {
            evidence.push_str(&format!("L{l} (dialogue): {}\n", all[l - 1].trim()));
            dialogue_lines += 1;
            if evidence.len() > 45_000 {
                break 'files;
            }
        }
    }
    if dialogue_lines < 3 {
        bail!("{} hardly speaks in the manuscript yet — not enough dialogue to go on", entity.name);
    }
    let aliases = if entity.aliases.is_empty() { String::new() } else { format!(" (also called {})", entity.aliases.join(", ")) };
    let prompt = format!(
        "{}\n\nCharacter: {}{aliases} — {}\n\n# Passages around their appearances, in reading order\n{evidence}",
        crate::book::brief_text(&crate::book::info(app)),
        entity.name,
        entity.summary
    );
    one_shot(app, ai::Task::Voice, VOICE_SYSTEM, &prompt).await
}

// ---------- Reading critique ----------

#[derive(Deserialize, TS, Default, Debug)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CritiqueBrief {
    pub audience: Option<String>,
    pub tone: Option<String>,
    pub similar_authors: Option<String>,
    pub style: Option<String>,
    pub notes: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct SceneCritique {
    /// 3-5 sentences on how the scene reads for this audience — pace,
    /// clarity, tone match, where attention flags.
    notes: String,
    /// 0-4 genuine stumbling blocks; not preferences.
    problems: Vec<CritiqueProblem>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct CritiqueProblem {
    /// Verbatim text (under 150 chars) where a reader stumbles.
    quote: String,
    /// What goes wrong for this audience, concretely.
    message: String,
}

fn critique_system(b: &CritiqueBrief, book: &str) -> String {
    let f = |s: &Option<String>| s.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "(not given)".into());
    format!(
        "You are a close reader giving a first-reader critique of one scene of a novel draft, on \
         the writer's own brief:\n\
         - Readers: {}\n- Intended tone: {}\n- Comparable authors: {}\n- Style goals: {}\n\
         - Writer's notes: {}\n\n{book}\n\n\
         Judge the scene against THAT brief and where it falls in the book, not your own taste. \
         Notes: 3-5 sentences on how it reads for that audience — pace, clarity, tension, where \
         attention flags. Problems: only genuine stumbling blocks such a reader would hit \
         (confusion, a lull, a jarring shift), each with the words quoted verbatim from the scene. \
         Don't rewrite anything.",
        f(&b.audience),
        f(&b.tone),
        f(&b.similar_authors),
        f(&b.style),
        f(&b.notes)
    )
}

const CRITIQUE_SYNTHESIS: &str = "You are a close reader. From your scene-by-scene notes on a \
novel draft, write the book-level part of the critique for the writer: how the whole reads for \
the intended audience — pacing across the book, where attention flags and where it's gripped, \
recurring stumbling blocks, and the two or three things most worth the writer's revision time. \
Refer to scenes by name. Markdown, under 400 words, no rewriting.";

/// Scene-by-scene readability critique against the writer's brief, then a
/// book-level synthesis. Problems land as findings (kind "critique");
/// results are saved as it goes, so a stop or failure keeps what's done.
/// Returns (problem count, markdown report).
pub async fn critique_run(app: &Arc<App>, brief: CritiqueBrief) -> Result<(usize, String)> {
    const JOB: &str = "critique";
    let run = app.runs.try_register(JOB)?;
    app.db.with(|c| {
        c.execute("DELETE FROM assistant_findings WHERE kind = ?1", [CRITIQUE_KIND])?;
        Ok(())
    })?;
    let book = crate::book::brief_text(&crate::book::info(app));
    let system = critique_system(&brief, &if book.is_empty() { String::new() } else { format!("About the book:\n{book}") });
    let meta = app.db.with(|c| Ok(crate::book::scene_meta(c)))?;
    let all = scenes(app, 30);
    let mut problems = 0usize;
    let mut failed = 0usize;
    let mut stopped = false;
    let mut sections = String::new();
    let mut per_scene: Vec<Value> = Vec::new();
    let mut previous: Option<String> = None;
    let save = |per_scene: &Vec<Value>, problems: usize, report: &str| -> Result<()> {
        let results = json!({ "ranAt": db::now(), "problems": problems, "scenes": per_scene }).to_string();
        app.db.with(|c| {
            db::set_setting(c, "critiqueResults", &results)?;
            db::set_setting(c, "critiqueReport", report)
        })
    };
    for (i, scene) in all.iter().enumerate() {
        if run.is_cancelled() {
            stopped = true;
            break;
        }
        let rel = &scene.rel;
        let name = crate::book::display_name(rel);
        sweep_note(app, JOB, format!("reading {name} ({} of {})", i + 1, all.len()));
        let before = previous.as_deref().map(|p| format!("Just before this, the reader has read: {p}\n")).unwrap_or_default();
        let prompt = format!("Scene {} of {}: {name}\n{before}\n{}", i + 1, all.len(), scene_text(&scene.content));
        let critique: SceneCritique = match one_shot_typed(app, ai::Task::Critique, &system, &prompt).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("critique failed for {rel}: {e:#}");
                failed += 1;
                continue;
            }
        };
        previous = meta.get(rel).map(|(s, _)| s.clone()).filter(|s| !s.trim().is_empty()).or_else(|| Some(critique.notes.clone()));
        sections.push_str(&format!("\n## [{name}](<scene://{rel}>)\n{}\n", critique.notes));
        per_scene.push(json!({ "file": rel, "notes": critique.notes, "problems": critique.problems.len() }));
        app.db.tx(|tx| {
            for p in &critique.problems {
                let line = locate_quote(&scene.content, &p.quote).map(|(l, _, _)| l).unwrap_or(1);
                tx.execute(
                    "INSERT INTO assistant_findings (file, line, quote, kind, message, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![rel, line as i64, p.quote, CRITIQUE_KIND, p.message, db::now()],
                )?;
            }
            Ok(())
        })?;
        problems += critique.problems.len();
        if !critique.problems.is_empty() {
            app.emit(Event::AgentFinding { file: rel.clone() });
        }
        save(&per_scene, problems, &format!("# Reading critique\n\n_(in progress)_\n{sections}"))?;
    }

    // The book as a whole, from the scene notes (skipped if nothing was read).
    let whole = if per_scene.len() >= 2 && !stopped {
        let notes = per_scene
            .iter()
            .map(|s| format!("{}: {}", crate::book::display_name(s["file"].as_str().unwrap_or("")), s["notes"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n");
        match one_shot(app, ai::Task::Critique, CRITIQUE_SYNTHESIS, &format!("{system}\n\nScene notes in reading order:\n{notes}")).await {
            Ok(text) => format!("\n## The book as a whole\n{}\n", text.trim()),
            Err(e) => {
                tracing::warn!("critique synthesis failed: {e:#}");
                String::new()
            }
        }
    } else {
        String::new()
    };
    let mut report = format!("# Reading critique\n{whole}\n# Scene by scene\n{sections}");
    if stopped {
        report.push_str("\n_(stopped here)_\n");
    }
    if failed > 0 {
        report.push_str(&format!("\n_{failed} scene(s) couldn't be read (the AI provider failed) — run it again to fill them in._\n"));
    }
    report.push_str(&format!("\n---\n{problems} reader stumbling block(s) marked in the manuscript.\n"));
    save(&per_scene, problems, &report)?;
    Ok((problems, report))
}

// ---------- Field filling (codex "draft from manuscript") ----------

#[derive(Deserialize, TS, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FillField {
    Summary,
    Body,
}

const FILL_SYSTEM: &str = "You keep a novelist's world bible. You draft one field of one entry \
from the passages provided — each is a paragraph of the manuscript where the entry's subject is \
named.\n\
\n\
Rules:\n\
- Only what these passages establish about the subject itself: who or what it is, appearance, \
history, relationships, what it knows, wants and does. Leave out scene events, setting, weather \
and other characters unless they bear directly on the subject.\n\
- Organise by aspect (Appearance, Relationships, History…), never scene by scene, and never name \
scenes or chapters.\n\
- The writer's existing entry is their intent, even where the text hasn't shown it yet: don't \
contradict it, don't comment on it, and never mention where the text and the entry differ.\n\
- Open questions only about the subject itself.\n\
- Never invent; mark uncertain readings with (?). Output only the field — no preamble, no code \
fences.";

/// Draft a codex field from the manuscript: only the paragraphs that name
/// the entity (by name or alias) are gathered, in reading order, then the
/// model writes just that field. The writer's other field goes along as
/// intent; the field being drafted doesn't (so an old draft can't echo).
pub async fn fill_field(app: &Arc<App>, entity_id: i64, field: FillField) -> Result<String> {
    let (entity, mentions) = app.db.with(|c| Ok((codex::get_entity(c, entity_id)?, codex::entity_mentions(c, entity_id)?)))?;
    let order = crate::book::reading_order(app);
    let mut by_file: std::collections::BTreeMap<usize, (String, Vec<usize>)> = Default::default();
    for m in &mentions {
        let pos = order.iter().position(|o| *o == m.file).unwrap_or(usize::MAX);
        by_file.entry(pos).or_insert_with(|| (m.file.clone(), Vec::new())).1.push(m.line.max(1) as usize);
    }
    let mut evidence = String::new();
    'files: for (file, lines) in by_file.values() {
        let Ok(content) = std::fs::read_to_string(app.root.join(file)) else { continue };
        let all: Vec<&str> = content.lines().collect();
        let mut seen = std::collections::BTreeSet::new();
        for &line in lines {
            if line > all.len() || !seen.insert(line) {
                continue;
            }
            let text = all[line - 1].trim();
            if text.is_empty() || text.starts_with('#') {
                continue;
            }
            evidence.push_str(text);
            evidence.push_str("\n\n");
            if evidence.len() > 30_000 {
                break 'files;
            }
        }
    }
    if evidence.trim().is_empty() {
        bail!("no paragraph names \"{}\" yet — nothing to draft from", entity.name);
    }

    let instruction = match field {
        FillField::Summary => "Write the SUMMARY field: one crisp sentence (under 25 words) saying who or what this is, at a glance.",
        FillField::Body => {
            "Write the NOTES field: short markdown bullets under bold aspect headers (only the aspects the \
             passages support), then any open questions about the subject."
        }
    };
    let writer_entry = match field {
        FillField::Summary if !entity.body.trim().is_empty() => format!("The writer's notes (their intent):\n{}\n", entity.body.trim()),
        FillField::Body if !entity.summary.trim().is_empty() => format!("The writer's summary (their intent): {}\n", entity.summary.trim()),
        _ => String::new(),
    };
    let aliases = if entity.aliases.is_empty() { String::new() } else { format!(" (also called {})", entity.aliases.join(", ")) };
    let book = crate::book::brief_text(&crate::book::info(app));
    let user = format!(
        "{book}\n\nSubject: {}{aliases} — a {}\n{writer_entry}\n{instruction}\n\n# Paragraphs that name {}\n{evidence}",
        entity.name, entity.kind, entity.name
    );
    Ok(one_shot(app, ai::Task::Fill, FILL_SYSTEM, &user).await?.trim().to_string())
}

// ---------- Cost estimates ----------

/// Jobs that read the whole book and are worth pricing before they run.
#[derive(Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EstimateJob {
    Continuity,
    Ledger,
    Critique,
    Synopses,
}

/// What a whole-book job will read, and roughly what it costs.
#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Estimate {
    /// Scenes the job will actually send (unchanged ones are skipped).
    pub scenes: usize,
    pub words: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub model: String,
    /// USD, when the provider publishes prices for the model.
    pub cost: Option<f64>,
}

const TOKENS_PER_WORD: f64 = 1.35;

pub async fn estimate(app: &Arc<App>, job: EstimateJob) -> Result<Estimate> {
    let all = scenes(app, 20);
    let facts = app.db.with(ledger_by_scene)?;
    let stale_facts = |s: &Scene| {
        app.db
            .with(|c| Ok(c.query_row("SELECT hash FROM scene_facts WHERE file = ?1", [&s.rel], |r| r.get::<_, String>(0)).optional()?))
            .ok()
            .flatten()
            != Some(content_hash(&s.content))
    };
    let meta = app.db.with(|c| Ok(crate::book::scene_meta(c)))?;
    let (task, picked, per_scene_in, per_scene_out): (ai::Task, Vec<&Scene>, u64, u64) = match job {
        // Checks re-read the scene plus up to FACT_CHARS of earlier facts.
        // Each check re-reads the scene plus earlier facts (capped per check).
        EstimateJob::Continuity => {
            let fact_chars: usize = facts.values().flatten().map(|f| f.fact.len() + f.quote.len() + 60).sum();
            let per_check = (fact_chars / 2).min(FACT_CHARS) / 4; // on average half the book is "earlier"
            (ai::Task::Continuity, all.iter().collect(), per_check as u64 + 1_200, 150)
        }
        EstimateJob::Ledger => (ai::Task::Ledger, all.iter().filter(|s| stale_facts(s)).collect(), 900, 0),
        EstimateJob::Critique => (ai::Task::Critique, all.iter().collect(), 1_000, 350),
        EstimateJob::Synopses => (
            ai::Task::Synopses,
            all.iter().filter(|s| meta.get(&s.rel).is_none_or(|(syn, _)| syn.trim().is_empty())).collect(),
            400,
            90,
        ),
    };
    let words: usize = picked.iter().map(|s| s.content.split_whitespace().count()).sum();
    let input_tokens = (words as f64 * TOKENS_PER_WORD) as u64 + per_scene_in * picked.len() as u64;
    let output_tokens = match job {
        EstimateJob::Ledger => (words as f64 * 0.25) as u64, // facts run about a quarter of the text
        _ => per_scene_out * picked.len() as u64,
    };
    let model = ai::config(app).model_for(task).to_string();
    let mut known = app.ai.known_models();
    if known.is_empty() && ai::usable(app) {
        known = ai::list_models(app).await.unwrap_or_default();
    }
    let cost = known.iter().find(|m| m.id == model).and_then(|m| {
        Some(m.input_price? * input_tokens as f64 / 1e6 + m.output_price? * output_tokens as f64 / 1e6)
    });
    Ok(Estimate { scenes: picked.len(), words, input_tokens, output_tokens, model, cost })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_ids_are_exclusive_and_cleanup_is_owned() {
        let runs = Runs::default();
        let first = runs.try_register("chat-1").unwrap();
        assert!(
            runs.try_register("chat-1").is_err(),
            "second run with the same id must be refused"
        );
        assert!(runs.stop("chat-1"));
        assert!(first.is_cancelled());
        // A new run reuses the id after the stop…
        let second = runs.try_register("chat-1").unwrap();
        // …and the stopped run's cleanup must not remove it.
        drop(first);
        assert!(runs.is_running("chat-1"));
        assert!(!second.is_cancelled());
        drop(second);
        assert!(!runs.is_running("chat-1"));
        assert!(!runs.stop("chat-1"));
    }

    #[test]
    fn quotes_anchor_by_char_columns() {
        let content = "First line.\nÉlan — she said “the gate is open” and left.";
        let (line, start, end) = locate_quote(content, "the gate is open").unwrap();
        assert_eq!(line, 2);
        let l: Vec<char> = content.lines().nth(1).unwrap().chars().collect();
        assert_eq!(l[start..end].iter().collect::<String>(), "the gate is open");
        assert!(locate_quote(content, "THE GATE").is_some());
        assert!(locate_quote(content, "").is_none());
    }
}
