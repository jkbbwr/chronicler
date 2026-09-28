//! AI configuration and agent jobs.

use super::codex::{IdParams, OptionalPathParams};
use super::docs::PathParams;
use super::{NoParams, required};
use crate::agents::{self, ChatMessage, CritiqueBrief, FillField};
use crate::ai::{self, AiConfig, Provider};
use crate::app::App;
use crate::embed;
use crate::fsx::RelPath;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

// ---------- AI configuration ----------

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    pub provider: Provider,
    pub base_url: String,
    pub fast_model: String,
    pub deep_model: String,
    pub embed_model: String,
    /// Task key → model id.
    pub overrides: std::collections::BTreeMap<String, String>,
    pub discovery: bool,
    pub ledger_on_save: bool,
    pub live_continuity: bool,
    /// Added to the conversation prompt.
    pub chat_instructions: String,
    /// Replaces the built-in conversation prompt ("" = built-in).
    pub chat_prompt: String,
    pub has_key: bool,
}

pub fn ai_config(app: &App, _: NoParams) -> Result<AiConfigView> {
    let c = ai::config(app);
    Ok(AiConfigView {
        provider: c.provider,
        base_url: c.base_url,
        fast_model: c.fast_model,
        deep_model: c.deep_model,
        embed_model: c.embed_model,
        overrides: c.overrides,
        discovery: c.discovery,
        ledger_on_save: c.ledger_on_save,
        live_continuity: c.live_continuity,
        chat_instructions: c.chat_instructions,
        chat_prompt: c.chat_prompt,
        has_key: app.ai.has_key(),
    })
}

/// Partial update: omitted fields keep their current values. Settings are
/// app-wide (every book).
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct AiConfigSetParams {
    pub provider: Option<Provider>,
    /// Required for openai-compat; optional override for openrouter.
    pub base_url: Option<String>,
    /// High-volume extraction (facts, names, synopses).
    pub fast_model: Option<String>,
    /// Judgement (continuity, critique, voice, conversation).
    pub deep_model: Option<String>,
    /// Embeddings model for passage search ("" = provider default).
    pub embed_model: Option<String>,
    /// Task key → model id; replaces the whole map.
    pub overrides: Option<std::collections::BTreeMap<String, String>>,
    pub discovery: Option<bool>,
    pub ledger_on_save: Option<bool>,
    pub live_continuity: Option<bool>,
    /// Added to the conversation prompt.
    pub chat_instructions: Option<String>,
    /// Replaces the built-in conversation prompt ("" = back to built-in).
    pub chat_prompt: Option<String>,
}

pub fn ai_config_set(app: &App, p: AiConfigSetParams) -> Result<()> {
    let cur = ai::config(app);
    ai::save_config(
        app,
        AiConfig {
            provider: p.provider.unwrap_or(cur.provider),
            base_url: p.base_url.unwrap_or(cur.base_url),
            fast_model: p.fast_model.unwrap_or(cur.fast_model),
            deep_model: p.deep_model.unwrap_or(cur.deep_model),
            embed_model: p.embed_model.unwrap_or(cur.embed_model),
            overrides: p.overrides.map(|o| o.into_iter().filter(|(_, m)| !m.trim().is_empty()).collect()).unwrap_or(cur.overrides),
            discovery: p.discovery.unwrap_or(cur.discovery),
            ledger_on_save: p.ledger_on_save.unwrap_or(cur.ledger_on_save),
            live_continuity: p.live_continuity.unwrap_or(cur.live_continuity),
            chat_instructions: p.chat_instructions.unwrap_or(cur.chat_instructions),
            chat_prompt: p.chat_prompt.unwrap_or(cur.chat_prompt),
        },
    )
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct KeyParams {
    /// Empty clears the key.
    pub key: String,
}

pub fn ai_set_key(app: &App, p: KeyParams) -> Result<()> {
    app.ai.set_key(p.key.trim());
    Ok(())
}

#[derive(Serialize, TS)]
pub struct ModelList {
    pub models: Vec<ai::ModelInfo>,
}

pub async fn ai_models(app: Arc<App>, _: NoParams) -> Result<ModelList> {
    Ok(ModelList {
        models: ai::list_models(&app).await?,
    })
}

/// Replies from each model tier.
#[derive(Serialize, TS)]
pub struct TestResult {
    pub fast: String,
    pub deep: String,
}

pub async fn ai_test(app: Arc<App>, _: NoParams) -> Result<TestResult> {
    let (fast, deep) = agents::test_connection(&app).await?;
    Ok(TestResult { fast, deep })
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AiScanResult {
    pub new_candidates: usize,
    pub aliases_added: usize,
}

pub async fn ai_scan(app: Arc<App>, p: PathParams) -> Result<AiScanResult> {
    let r = ai::scan_file(&app, &p.path).await?;
    Ok(AiScanResult {
        new_candidates: r.new_candidates,
        aliases_added: r.aliases_added,
    })
}

// ---------- Agent jobs ----------

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChatParams {
    /// Run id, for `agents/stop` and event tagging. Default "rig".
    pub id: Option<String>,
    /// The conversation; the last message is the live prompt and must be
    /// from the user.
    pub messages: Vec<ChatMessage>,
    /// The currently open scene's text.
    pub context: Option<String>,
    /// Files the writer attached explicitly.
    pub attach: Option<Vec<String>>,
}

#[derive(Serialize, TS)]
pub struct ChatResult {
    pub text: String,
    pub stopped: bool,
}

pub async fn chat(app: Arc<App>, p: ChatParams) -> Result<ChatResult> {
    let id =
        p.id.filter(|i| !i.is_empty())
            .unwrap_or_else(|| "rig".into());
    let (text, stopped) = agents::run_chat(
        &app,
        &id,
        &p.messages,
        p.context.as_deref(),
        &p.attach.unwrap_or_default(),
    )
    .await?;
    Ok(ChatResult { text, stopped })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StopParams {
    /// A chat id, or a job: continuity | ledger | timeline | relations |
    /// synopses | hygiene | critique.
    pub id: String,
}

#[derive(Serialize, TS)]
pub struct Stopped {
    /// Whether anything was running under that id.
    pub stopped: bool,
}

pub fn stop(app: &App, p: StopParams) -> Result<Stopped> {
    Ok(Stopped {
        stopped: app.runs.stop(required("id", &p.id)?),
    })
}

#[derive(Serialize, TS)]
pub struct ContinuityResult {
    /// Contradictions standing (in the checked scope).
    pub findings: usize,
    /// Scenes checked this run.
    pub checked: usize,
    /// Scenes skipped because nothing they depend on changed.
    pub unchanged: usize,
    /// Scenes the AI provider failed on.
    pub failed: usize,
    pub summary: String,
    pub stopped: bool,
}

pub async fn continuity(app: Arc<App>, p: OptionalPathParams) -> Result<ContinuityResult> {
    let scope: Option<RelPath> = p.rel()?;
    let o = agents::run_continuity(&app, scope.as_ref()).await?;
    Ok(ContinuityResult {
        findings: o.findings,
        checked: o.checked,
        unchanged: o.unchanged,
        failed: o.failed,
        summary: o.summary(),
        stopped: o.stopped,
    })
}

pub fn finding_dismiss(app: &App, p: IdParams) -> Result<()> {
    app.db.with(|c| agents::dismiss_finding(c, p.id))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LedgerParams {
    /// Re-extract every scene, not just changed ones.
    pub force: Option<bool>,
}

#[derive(Serialize, TS)]
pub struct LedgerResult {
    /// Scenes (re)read.
    pub scenes: usize,
    /// Facts in the ledger.
    pub facts: usize,
    /// Scenes the AI provider failed on.
    pub failed: usize,
}

pub async fn ledger(app: Arc<App>, p: LedgerParams) -> Result<LedgerResult> {
    let o = agents::ledger_update(&app, p.force.unwrap_or(false)).await?;
    Ok(LedgerResult { scenes: o.updated, facts: o.total_facts, failed: o.failed })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct FactsParams {
    /// Name or keyword filter.
    pub subject: Option<String>,
}

#[derive(Serialize, TS)]
pub struct Markdown {
    pub markdown: String,
}

pub fn facts(app: &App, p: FactsParams) -> Result<Markdown> {
    Ok(Markdown {
        markdown: agents::ledger_report(app, p.subject.as_deref())?,
    })
}

pub async fn timeline_build(app: Arc<App>, _: NoParams) -> Result<agents::StoredTimeline> {
    agents::timeline_build(&app).await
}

pub fn timeline(app: &App, _: NoParams) -> Result<Option<agents::StoredTimeline>> {
    app.db.with(agents::timeline_get)
}

#[derive(Serialize, TS)]
pub struct LinksResult {
    pub links: usize,
}

pub async fn relations_build(app: Arc<App>, _: NoParams) -> Result<LinksResult> {
    Ok(LinksResult {
        links: agents::relations_build(&app).await?,
    })
}

#[derive(Serialize, TS)]
pub struct DraftedResult {
    pub drafted: usize,
}

pub async fn synopses(app: Arc<App>, _: NoParams) -> Result<DraftedResult> {
    Ok(DraftedResult {
        drafted: agents::draft_synopses(&app).await?,
    })
}

#[derive(Serialize, TS)]
pub struct HygieneResult {
    pub suggestions: usize,
    pub summary: String,
    pub stopped: bool,
}

pub async fn hygiene(app: Arc<App>, _: NoParams) -> Result<HygieneResult> {
    let (suggestions, summary, stopped) = agents::hygiene_sweep(&app).await?;
    Ok(HygieneResult {
        suggestions,
        summary,
        stopped,
    })
}

pub async fn voice(app: Arc<App>, p: IdParams) -> Result<Markdown> {
    Ok(Markdown {
        markdown: agents::voice_report(&app, p.id).await?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CritiqueParams {
    pub brief: Option<CritiqueBrief>,
}

#[derive(Serialize, TS)]
pub struct CritiqueResult {
    pub problems: usize,
    pub markdown: String,
}

pub async fn critique(app: Arc<App>, p: CritiqueParams) -> Result<CritiqueResult> {
    let (problems, markdown) = agents::critique_run(&app, p.brief.unwrap_or_default()).await?;
    Ok(CritiqueResult { problems, markdown })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct FillParams {
    /// Entity id.
    pub id: i64,
    pub field: FillField,
}

#[derive(Serialize, TS)]
pub struct TextResult {
    pub text: String,
}

pub async fn fill(app: Arc<App>, p: FillParams) -> Result<TextResult> {
    Ok(TextResult {
        text: agents::fill_field(&app, p.id, p.field).await?,
    })
}

#[derive(Serialize, TS)]
pub struct IndexResult {
    pub files: usize,
    pub chunks: usize,
}

pub async fn index(app: Arc<App>, _: NoParams) -> Result<IndexResult> {
    let _run = app.runs.try_register("index")?;
    let (files, chunks) = embed::reindex_all(&app).await?;
    Ok(IndexResult { files, chunks })
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub indexed_files: usize,
    pub chunks: usize,
    /// Empty when no embedding model is configured.
    pub embed_model: String,
    /// The index was built with the configured model.
    pub current_model: bool,
}

pub fn status(app: &App, _: NoParams) -> Result<IndexStatus> {
    let (indexed_files, chunks) = embed::stats(app).unwrap_or((0, 0));
    Ok(IndexStatus {
        indexed_files,
        chunks,
        embed_model: agents::embed_model_name(app).unwrap_or_default(),
        current_model: embed::index_is_current_model(app),
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EstimateParams {
    pub job: agents::EstimateJob,
}

pub async fn estimate(app: Arc<App>, p: EstimateParams) -> Result<agents::Estimate> {
    agents::estimate(&app, p.job).await
}

#[derive(Serialize, TS)]
pub struct DefaultPrompts {
    /// The built-in conversation prompt.
    pub chat: String,
}

pub fn default_prompts(_: &App, _: NoParams) -> Result<DefaultPrompts> {
    Ok(DefaultPrompts { chat: agents::default_chat_prompt().to_string() })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CatchUpParams {
    pub path: String,
    /// Write the story so far if it isn't cached (an AI call). Default true;
    /// false returns the factual parts at once (and a cached summary).
    pub summary: Option<bool>,
    /// Ignore a cached summary and write a fresh one.
    pub refresh: Option<bool>,
}

pub async fn catch_up(app: Arc<App>, p: CatchUpParams) -> Result<crate::catchup::CatchUp> {
    let rel = RelPath::parse(required("path", &p.path)?)?;
    crate::catchup::catch_up(&app, &rel, p.summary.unwrap_or(true), p.refresh.unwrap_or(false)).await
}
