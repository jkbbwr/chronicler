//! AI configuration (app-wide, shared by every book), task routing, and the
//! LLM codex scan.
//!
//! Two providers, both speaking the OpenAI chat-completions shape:
//!   - openrouter: https://openrouter.ai/api/v1 (key required)
//!   - openai-compat: any compatible server via base_url (OpenAI, Ollama's
//!     /v1, LM Studio, vLLM, ...); key optional for local.
//!
//! Every AI job is a [`Task`]. Tasks default to one of two model tiers —
//! a quick model for high-volume extraction, a careful one for judgement —
//! and the writer can override any single task.

use crate::app::App;
use crate::codex;
use anyhow::{Context, Result, bail};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Provider {
    #[default]
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "openai-compat")]
    OpenAiCompat,
}

/// Every AI job, for model routing, temperature and settings.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Task {
    Chat,
    Continuity,
    Critique,
    Voice,
    Timeline,
    Relations,
    Hygiene,
    Ledger,
    Discovery,
    Synopses,
    Fill,
    CatchUp,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tier {
    Fast,
    Deep,
}

impl Task {
    pub fn key(self) -> &'static str {
        match self {
            Task::Chat => "chat",
            Task::Continuity => "continuity",
            Task::Critique => "critique",
            Task::Voice => "voice",
            Task::Timeline => "timeline",
            Task::Relations => "relations",
            Task::Hygiene => "hygiene",
            Task::Ledger => "ledger",
            Task::Discovery => "discovery",
            Task::Synopses => "synopses",
            Task::Fill => "fill",
            Task::CatchUp => "catch_up",
        }
    }

    pub fn tier(self) -> Tier {
        match self {
            Task::Ledger | Task::Discovery | Task::Synopses | Task::Fill | Task::CatchUp => Tier::Fast,
            _ => Tier::Deep,
        }
    }

    /// Extraction wants determinism; judgement a little room; prose summaries
    /// a little more.
    pub fn temperature(self) -> f64 {
        match self {
            Task::Ledger | Task::Discovery | Task::Continuity | Task::Timeline | Task::Relations | Task::Hygiene => 0.0,
            Task::Critique | Task::Voice | Task::Fill | Task::CatchUp => 0.3,
            Task::Synopses | Task::Chat => 0.5,
        }
    }
}

/// Persisted AI settings (app-wide).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub provider: Provider,
    /// Required for openai-compat; optional override for openrouter.
    pub base_url: String,
    /// High-volume extraction: facts, names, synopses.
    pub fast_model: String,
    /// Judgement: continuity, critique, voice, conversation.
    pub deep_model: String,
    /// Embeddings model for the manuscript index ("" = provider default).
    pub embed_model: String,
    /// Task key → model id, overriding the task's tier.
    pub overrides: BTreeMap<String, String>,
    /// Suggest codex entries from new names (LLM pass after NER).
    pub discovery: bool,
    /// Keep the fact ledger current as scenes are saved.
    pub ledger_on_save: bool,
    /// Check each saved scene for continuity against earlier scenes.
    pub live_continuity: bool,
    /// The writer's own instructions, added to the conversation prompt.
    pub chat_instructions: String,
    /// A full replacement for the built-in conversation prompt ("" = built-in).
    pub chat_prompt: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            provider: Provider::OpenRouter,
            base_url: String::new(),
            fast_model: "openrouter/auto".into(),
            deep_model: "openrouter/auto".into(),
            embed_model: String::new(),
            overrides: BTreeMap::new(),
            discovery: false,
            ledger_on_save: true,
            live_continuity: false,
            chat_instructions: String::new(),
            chat_prompt: String::new(),
        }
    }
}

impl AiConfig {
    pub fn model_for(&self, task: Task) -> &str {
        if let Some(m) = self.overrides.get(task.key()).filter(|m| !m.trim().is_empty()) {
            return m;
        }
        match task.tier() {
            Tier::Fast => &self.fast_model,
            Tier::Deep => &self.deep_model,
        }
    }
}

/// A model the provider offers, with what it costs when the provider says.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ModelInfo {
    pub id: String,
    pub name: Option<String>,
    pub context_length: Option<u64>,
    /// USD per million input tokens.
    pub input_price: Option<f64>,
    /// USD per million output tokens.
    pub output_price: Option<f64>,
}

/// Config (cached) and the API key. The key lives only in memory; Electron
/// holds the encrypted copy and re-sends it on start.
#[derive(Default)]
pub struct AiState {
    config: RwLock<Option<AiConfig>>,
    key: RwLock<Option<String>>,
    models: RwLock<Vec<ModelInfo>>,
}

impl AiState {
    pub fn set_key(&self, key: &str) {
        *self.key.write() = if key.is_empty() { None } else { Some(key.to_string()) };
    }

    pub fn key(&self) -> Option<String> {
        self.key.read().clone()
    }

    pub fn has_key(&self) -> bool {
        self.key.read().is_some()
    }

    /// The last model list fetched (for price estimates).
    pub fn known_models(&self) -> Vec<ModelInfo> {
        self.models.read().clone()
    }
}

/// Where app-wide settings live: `$CHRONICLER_CONFIG_DIR`, else
/// `~/.config/chronicler`.
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CHRONICLER_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("chronicler")
}

fn config_file() -> PathBuf {
    config_dir().join("ai.json")
}

/// A per-project config from before settings went app-wide.
fn legacy_project_config(app: &App) -> Option<AiConfig> {
    let raw = app.db.get_setting("ai").ok().flatten()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let mut cfg = AiConfig::default();
    if let Ok(p) = serde_json::from_value::<Provider>(v["provider"].clone()) {
        cfg.provider = p;
    }
    if let Some(m) = v["model"].as_str().filter(|m| !m.is_empty()) {
        cfg.fast_model = m.to_string();
        cfg.deep_model = m.to_string();
    }
    cfg.base_url = v["baseUrl"].as_str().unwrap_or("").to_string();
    cfg.embed_model = v["embedModel"].as_str().unwrap_or("").to_string();
    cfg.discovery = v["enabled"].as_bool().unwrap_or(false);
    Some(cfg)
}

pub fn config(app: &App) -> AiConfig {
    if let Some(cfg) = app.ai.config.read().clone() {
        return cfg;
    }
    let cfg = std::fs::read_to_string(config_file())
        .ok()
        .and_then(|s| serde_json::from_str::<AiConfig>(&s).ok())
        .or_else(|| {
            // First run of app-wide settings: adopt this project's old ones.
            let legacy = legacy_project_config(app)?;
            let _ = write_config(&legacy);
            Some(legacy)
        })
        .unwrap_or_default();
    *app.ai.config.write() = Some(cfg.clone());
    cfg
}

fn write_config(cfg: &AiConfig) -> Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let tmp = dir.join(".ai.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg)?)?;
    std::fs::rename(&tmp, config_file())?;
    Ok(())
}

pub fn save_config(app: &App, cfg: AiConfig) -> Result<()> {
    write_config(&cfg)?;
    *app.ai.config.write() = Some(cfg);
    Ok(())
}

/// Can AI calls go out at all (a key, or a keyless local server)?
pub fn usable(app: &App) -> bool {
    let cfg = config(app);
    app.ai.has_key() || (cfg.provider == Provider::OpenAiCompat && !cfg.base_url.is_empty())
}

pub fn auto_scan_ready(app: &App) -> bool {
    config(app).discovery && usable(app)
}

/// The API base (".../v1", no trailing slash) for the configured provider.
pub(crate) fn api_base(cfg: &AiConfig) -> Result<String> {
    let base = match cfg.provider {
        Provider::OpenRouter if cfg.base_url.is_empty() => "https://openrouter.ai/api/v1".to_string(),
        Provider::OpenRouter => cfg.base_url.clone(),
        Provider::OpenAiCompat if cfg.base_url.is_empty() => bail!(
            "An OpenAI-compatible server needs an address (e.g. https://api.openai.com/v1 or http://localhost:11434/v1)"
        ),
        Provider::OpenAiCompat => cfg.base_url.clone(),
    };
    Ok(base.trim_end_matches('/').to_string())
}

/// Per-token price strings (OpenRouter) → USD per million tokens.
pub(crate) fn per_million(v: &Value) -> Option<f64> {
    let per_token = match v {
        Value::String(s) => s.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (per_token >= 0.0).then_some(per_token * 1_000_000.0)
}

/// The provider's models, with context size and price where offered.
pub async fn list_models(app: &App) -> Result<Vec<ModelInfo>> {
    let cfg = config(app);
    let base = api_base(&cfg)?;
    let mut req = reqwest::Client::new().get(format!("{base}/models"));
    match app.ai.key() {
        Some(k) => req = req.bearer_auth(k),
        None if cfg.provider == Provider::OpenAiCompat => {}
        None => bail!("No API key set — add one in Settings → AI"),
    }
    let resp = req.send().await.with_context(|| format!("calling {base}/models"))?;
    let status = resp.status();
    let body: Value = resp.json().await.context("reading model list")?;
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().unwrap_or("unknown error");
        bail!("AI provider error ({status}): {msg}");
    }
    let mut models: Vec<ModelInfo> = body["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m["id"].as_str()?.to_string(),
                        name: m["name"].as_str().map(String::from),
                        context_length: m["context_length"].as_u64(),
                        input_price: per_million(&m["pricing"]["prompt"]),
                        output_price: per_million(&m["pricing"]["completion"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    *app.ai.models.write() = models.clone();
    Ok(models)
}

const EXTRACTION_INSTRUCTION: &str = "You find new names in one scene of a novel for the writer's \
world bible (codex). Kinds: character, place, item, faction, creature, event, lore.\n\
- Only report proper names that aren't in the known list. A name that is clearly another name \
for a known entry (a nickname, title, surname alone, epithet) goes in alias_of, not as a new \
entry.\n\
- Skip real-world places and people unless the story treats them as characters, generic roles \
(\"the captain\") unless used as a name, and one-off background mentions.\n\
- The summary is one sentence of what THIS scene establishes about it.\n\
Return an empty list when nothing new appears.";

#[derive(Deserialize, schemars::JsonSchema)]
struct Extraction {
    entities: Vec<ExtractedEntity>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ExtractedEntity {
    name: String,
    /// character | place | item | faction | creature | event | lore. Omit when alias_of is set.
    kind: Option<String>,
    /// One sentence.
    summary: Option<String>,
    /// Exact name of the known entity this is another name for.
    alias_of: Option<String>,
}

pub struct ScanOutcome {
    pub new_candidates: usize,
    /// Suggested "another name for…" entries (never applied without the writer).
    pub aliases_added: usize,
}

/// LLM-extract names from one file into the Discovered inbox. Suspected
/// aliases are suggestions like everything else: nothing enters the codex
/// until the writer approves it.
pub async fn scan_file(app: &std::sync::Arc<App>, rel: &str) -> Result<ScanOutcome> {
    let (rel_path, _) = app.path(rel)?;
    let content = app.read(&rel_path)?;
    let entities = app.db.with(codex::list_entities)?;
    let known: Vec<String> = entities
        .iter()
        .map(|e| if e.aliases.is_empty() { e.name.clone() } else { format!("{} (also: {})", e.name, e.aliases.join(", ")) })
        .collect();

    let prompt = format!(
        "Known entries: {}\n\nScene text:\n{}",
        if known.is_empty() { "(none)".to_string() } else { known.join("; ") },
        crate::agents::scene_text(&content)
    );
    let extraction: Extraction =
        crate::agents::one_shot_typed(app, Task::Discovery, EXTRACTION_INSTRUCTION, &prompt).await?;

    let mut aliases = 0usize;
    let mut found = Vec::new();
    for item in extraction.entities {
        let name = item.name.trim().to_string();
        if name.is_empty() || entities.iter().any(|e| e.answers_to(&name)) {
            continue;
        }
        let alias_target = item.alias_of.as_deref().and_then(|a| entities.iter().find(|e| e.answers_to(a)));
        let kind = item.kind.unwrap_or_default();
        let summary = match alias_target {
            Some(t) => {
                aliases += 1;
                format!("Possibly another name for {}.", t.name)
            }
            None => item.summary.unwrap_or_default(),
        };
        found.push(codex::Candidate {
            name,
            kind_guess: if codex::KINDS.contains(&kind.as_str()) { kind } else { String::new() },
            source: "llm".into(),
            summary,
            context: String::new(),
            line: 0,
        });
    }
    let rel = rel_path.as_str().to_string();
    let new_candidates = app.db.tx(|tx| codex::record_candidates(tx, &rel, &found))?;
    Ok(ScanOutcome { new_candidates, aliases_added: aliases })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_route_to_their_tier_unless_overridden() {
        let mut cfg = AiConfig { fast_model: "quick".into(), deep_model: "careful".into(), ..Default::default() };
        assert_eq!(cfg.model_for(Task::Ledger), "quick");
        assert_eq!(cfg.model_for(Task::Continuity), "careful");
        cfg.overrides.insert("continuity".into(), "special".into());
        cfg.overrides.insert("ledger".into(), "  ".into());
        assert_eq!(cfg.model_for(Task::Continuity), "special");
        assert_eq!(cfg.model_for(Task::Ledger), "quick", "blank overrides fall back to the tier");
    }

    #[test]
    fn prices_convert_to_per_million() {
        assert_eq!(per_million(&Value::String("0.000003".into())), Some(3.0));
        assert_eq!(per_million(&Value::Null), None);
    }
}
