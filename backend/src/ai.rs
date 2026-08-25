use crate::{codex, db};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::RwLock;

// LLM layer for the rig (assistant) and codex extraction. Two providers,
// both speaking the OpenAI chat-completions shape:
//   - openrouter:    https://openrouter.ai/api/v1 (key required)
//   - openai-compat: any compatible server via base_url (OpenAI, Ollama's
//                    /v1, LM Studio, vLLM, ...); key optional for local.

#[derive(Clone)]
pub struct AiConfig {
    pub provider: String, // "openrouter" | "openai-compat"
    pub model: String,
    pub base_url: String, // required for openai-compat; override for openrouter
    pub embed_model: String, // embeddings model for manuscript RAG
    pub enabled: bool,    // auto-scan after NER finds new names
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            provider: "openrouter".into(),
            model: "openrouter/auto".into(),
            base_url: String::new(),
            embed_model: String::new(),
            enabled: false,
        }
    }
}

/// API key lives only in memory; Electron holds the encrypted copy and
/// re-sends it on backend start.
static STATE: RwLock<(Option<AiConfig>, Option<String>)> = RwLock::new((None, None));

pub fn load_config(root: &Path) -> AiConfig {
    if let Some(cfg) = STATE.read().unwrap().0.clone() {
        return cfg;
    }
    let cfg = db::get_setting(root, "ai")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| AiConfig {
            provider: v["provider"].as_str().unwrap_or("openrouter").to_string(),
            model: v["model"].as_str().unwrap_or("openrouter/auto").to_string(),
            base_url: v["baseUrl"].as_str().unwrap_or("").to_string(),
            embed_model: v["embedModel"].as_str().unwrap_or("").to_string(),
            enabled: v["enabled"].as_bool().unwrap_or(false),
        })
        .unwrap_or_default();
    // Configs from before the provider rework reset to defaults
    let cfg = if matches!(cfg.provider.as_str(), "openrouter" | "openai-compat") {
        cfg
    } else {
        AiConfig::default()
    };
    STATE.write().unwrap().0 = Some(cfg.clone());
    cfg
}

pub fn save_config(root: &Path, cfg: AiConfig) -> Result<()> {
    db::set_setting(
        root,
        "ai",
        &json!({
            "provider": cfg.provider,
            "model": cfg.model,
            "baseUrl": cfg.base_url,
            "embedModel": cfg.embed_model,
            "enabled": cfg.enabled,
        })
        .to_string(),
    )?;
    STATE.write().unwrap().0 = Some(cfg);
    Ok(())
}

pub fn set_key(key: &str) {
    STATE.write().unwrap().1 = if key.is_empty() { None } else { Some(key.to_string()) };
}

pub fn has_key() -> bool {
    STATE.read().unwrap().1.is_some()
}

pub(crate) fn api_key() -> Option<String> {
    STATE.read().unwrap().1.clone()
}

fn key() -> Option<String> {
    api_key()
}

pub fn auto_scan_ready(root: &Path) -> bool {
    let cfg = load_config(root);
    // Local openai-compat servers commonly run keyless
    cfg.enabled && (has_key() || cfg.provider == "openai-compat")
}

/// Resolve the API base (".../v1", no trailing slash) for the configured provider.
fn api_base(cfg: &AiConfig) -> Result<String> {
    let base = match cfg.provider.as_str() {
        "openrouter" => {
            if cfg.base_url.is_empty() { "https://openrouter.ai/api/v1".to_string() } else { cfg.base_url.clone() }
        }
        "openai-compat" => {
            if cfg.base_url.is_empty() {
                bail!("OpenAI-compatible provider needs a base URL (e.g. https://api.openai.com/v1 or http://localhost:11434/v1)");
            }
            cfg.base_url.clone()
        }
        other => bail!("Unknown AI provider: {}", other),
    };
    Ok(base.trim_end_matches('/').to_string())
}

fn auth_key(cfg: &AiConfig) -> Result<Option<String>> {
    match key() {
        Some(k) => Ok(Some(k)),
        None if cfg.provider == "openai-compat" => Ok(None), // local servers
        None => bail!("No API key set — add one in Settings → AI"),
    }
}

/// List model ids from the provider's /models endpoint.
pub async fn list_models(cfg: &AiConfig) -> Result<Vec<String>> {
    let base = api_base(cfg)?;
    let mut req = reqwest::Client::new().get(format!("{}/models", base));
    if let Some(k) = auth_key(cfg)? {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.with_context(|| format!("calling {}/models", base))?;
    let status = resp.status();
    let body: Value = resp.json().await.context("reading model list")?;
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().unwrap_or("unknown error");
        bail!("AI provider error ({}): {}", status, msg);
    }
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .map(|models| models.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

/// Cheap round trip to prove the config works. Returns the model's reply.
pub async fn test_connection(root: &Path) -> Result<String> {
    crate::agents::one_shot(root, "You are a connection test.", "Reply with the single word: ok")
        .await
}

const EXTRACTION_INSTRUCTION: &str = "You are an entity extractor for a fiction writer's world \
bible. From the scene text, extract entities of these kinds: character, place, item, faction, \
creature, event, lore. Only include entities NOT present in the known-entities list. If a name in \
the text is clearly a nickname or variant of a known entity, set alias_of to that known entity's \
exact name instead of a kind. Return nothing when there is nothing new.";

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct Extraction {
    entities: Vec<ExtractedEntity>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct ExtractedEntity {
    name: String,
    /// character | place | item | faction | creature | event | lore. Omit when alias_of is set.
    kind: Option<String>,
    /// One sentence.
    summary: Option<String>,
    /// Exact name of the known entity this is a nickname or variant of.
    alias_of: Option<String>,
}

fn build_prompt(content: &str, known: &[String]) -> String {
    let text: String = content.chars().take(24_000).collect();
    format!(
        "Known entities (do not re-report): {}\n\nScene text:\n{}",
        if known.is_empty() { "(none)".to_string() } else { known.join(", ") },
        text
    )
}

/// LLM-extract entities from one file into the candidates inbox.
/// Alias suggestions ("aliasOf") are applied directly as aliases when the
/// referenced entity exists, since the model had the known list in hand.
pub async fn scan_file(root: &Path, rel: &str) -> Result<(usize, usize)> {
    let path = crate::resolve_path(root, rel)?;
    let content = std::fs::read_to_string(&path).with_context(|| format!("reading {}", rel))?;

    let entities = codex::list_entities(root)?;
    let known: Vec<String> = entities["entities"]
        .as_array()
        .map(|es| es.iter().filter_map(|e| e["name"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    let by_name: std::collections::HashMap<String, i64> = entities["entities"]
        .as_array()
        .map(|es| {
            es.iter()
                .filter_map(|e| Some((e["name"].as_str()?.to_lowercase(), e["id"].as_i64()?)))
                .collect()
        })
        .unwrap_or_default();

    let extraction: Extraction = crate::agents::one_shot_typed(
        root,
        EXTRACTION_INSTRUCTION,
        &build_prompt(&content, &known),
    )
    .await?;

    let mut aliases_added = 0;
    let mut found = Vec::new();
    for item in extraction.entities {
        let name = item.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        if let Some(alias_of) = &item.alias_of {
            if let Some(&id) = by_name.get(&alias_of.to_lowercase()) {
                codex::add_alias(root, id, &name)?;
                aliases_added += 1;
                continue;
            }
        }
        let kind = item.kind.unwrap_or_default();
        found.push(codex::Candidate {
            name,
            kind_guess: if codex::KINDS.contains(&kind.as_str()) { kind } else { String::new() },
            source: "llm".into(),
            summary: item.summary.unwrap_or_default(),
            context: String::new(),
            line: 0,
        });
    }
    let new = codex::record_candidates(root, rel, &found)?;
    if aliases_added > 0 {
        codex::reindex_mentions(root, None)?;
    }
    Ok((new, aliases_added))
}
