use crate::{codex, db};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::RwLock;

// Provider-pluggable LLM layer for codex extraction. Providers speak their
// native HTTP APIs; the extraction contract is shared: given prose and the
// list of already-known entities, return NEW entities as strict JSON.

#[derive(Clone)]
pub struct AiConfig {
    pub provider: String, // "anthropic" | "openai" | "ollama"
    pub model: String,
    pub base_url: String, // empty = provider default
    pub enabled: bool,    // auto-scan after NER finds new names
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            provider: "anthropic".into(),
            model: "claude-opus-5".into(),
            base_url: String::new(),
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
            provider: v["provider"].as_str().unwrap_or("anthropic").to_string(),
            model: v["model"].as_str().unwrap_or("claude-opus-5").to_string(),
            base_url: v["baseUrl"].as_str().unwrap_or("").to_string(),
            enabled: v["enabled"].as_bool().unwrap_or(false),
        })
        .unwrap_or_default();
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

fn key() -> Option<String> {
    STATE.read().unwrap().1.clone()
}

pub fn auto_scan_ready(root: &Path) -> bool {
    let cfg = load_config(root);
    cfg.enabled && (cfg.provider == "ollama" || has_key())
}

const EXTRACTION_INSTRUCTION: &str = "You are an entity extractor for a fiction writer's world bible. \
From the scene text, extract entities of these kinds: character, place, item, faction, creature, event, lore. \
Only include entities NOT present in the known-entities list. If a name in the text is clearly a nickname or \
variant of a known entity, report it with \"aliasOf\" set to that known entity's exact name instead of a kind. \
Respond with ONLY a JSON array, no prose, no code fences: \
[{\"name\": \"...\", \"kind\": \"character\", \"summary\": \"one sentence\"}, {\"name\": \"...\", \"aliasOf\": \"Known Name\"}]. \
Return [] if there is nothing new.";

fn build_prompt(content: &str, known: &[String]) -> String {
    let text: String = content.chars().take(24_000).collect();
    format!(
        "Known entities (do not re-report): {}\n\nScene text:\n{}",
        if known.is_empty() { "(none)".to_string() } else { known.join(", ") },
        text
    )
}

async fn complete(cfg: &AiConfig, system: &str, user: &str) -> Result<String> {
    let client = reqwest::Client::new();
    match cfg.provider.as_str() {
        "anthropic" => {
            let base = if cfg.base_url.is_empty() { "https://api.anthropic.com" } else { &cfg.base_url };
            let key = key().context("no API key set for Anthropic")?;
            let resp = client
                .post(format!("{}/v1/messages", base))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": cfg.model,
                    "max_tokens": 16000,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                }))
                .send()
                .await
                .context("calling Anthropic API")?;
            let status = resp.status();
            let body: Value = resp.json().await.context("reading Anthropic response")?;
            if !status.is_success() {
                bail!("Anthropic API error ({}): {}", status, body["error"]["message"].as_str().unwrap_or("unknown"));
            }
            if body["stop_reason"] == "refusal" {
                bail!("Anthropic API declined the request (refusal)");
            }
            let text: String = body["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b["type"] == "text")
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            Ok(text)
        }
        "openai" => {
            let base = if cfg.base_url.is_empty() { "https://api.openai.com" } else { &cfg.base_url };
            let key = key().context("no API key set for OpenAI")?;
            let resp = client
                .post(format!("{}/v1/chat/completions", base))
                .bearer_auth(key)
                .json(&json!({
                    "model": cfg.model,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user },
                    ],
                }))
                .send()
                .await
                .context("calling OpenAI API")?;
            let status = resp.status();
            let body: Value = resp.json().await.context("reading OpenAI response")?;
            if !status.is_success() {
                bail!("OpenAI API error ({}): {}", status, body["error"]["message"].as_str().unwrap_or("unknown"));
            }
            Ok(body["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
        }
        "ollama" => {
            let base = if cfg.base_url.is_empty() { "http://localhost:11434" } else { &cfg.base_url };
            let resp = client
                .post(format!("{}/api/chat", base))
                .json(&json!({
                    "model": cfg.model,
                    "stream": false,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user },
                    ],
                }))
                .send()
                .await
                .context("calling Ollama — is it running?")?;
            let body: Value = resp.json().await.context("reading Ollama response")?;
            if let Some(err) = body["error"].as_str() {
                bail!("Ollama error: {}", err);
            }
            Ok(body["message"]["content"].as_str().unwrap_or("").to_string())
        }
        other => bail!("Unknown AI provider: {}", other),
    }
}

/// Strip code fences and parse the extraction JSON array.
fn parse_extraction(text: &str) -> Result<Vec<Value>> {
    let trimmed = text.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix("```").unwrap_or(trimmed).trim();
    let start = trimmed.find('[').context("no JSON array in model response")?;
    let end = trimmed.rfind(']').context("unterminated JSON array in model response")?;
    let arr: Value = serde_json::from_str(&trimmed[start..=end]).context("parsing extraction JSON")?;
    Ok(arr.as_array().cloned().unwrap_or_default())
}

/// LLM-extract entities from one file into the candidates inbox.
/// Alias suggestions ("aliasOf") are applied directly as aliases when the
/// referenced entity exists, since the model had the known list in hand.
pub async fn scan_file(root: &Path, rel: &str) -> Result<(usize, usize)> {
    let cfg = load_config(root);
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

    let text = complete(&cfg, EXTRACTION_INSTRUCTION, &build_prompt(&content, &known)).await?;
    let extracted = parse_extraction(&text)?;

    let mut aliases_added = 0;
    let mut found = Vec::new();
    for item in &extracted {
        let Some(name) = item["name"].as_str().filter(|n| !n.trim().is_empty()) else { continue };
        if let Some(alias_of) = item["aliasOf"].as_str() {
            if let Some(&id) = by_name.get(&alias_of.to_lowercase()) {
                codex::add_alias(root, id, name)?;
                aliases_added += 1;
                continue;
            }
        }
        let kind = item["kind"].as_str().unwrap_or("");
        found.push(codex::Candidate {
            name: name.trim().to_string(),
            kind_guess: if codex::KINDS.contains(&kind) { kind.to_string() } else { String::new() },
            source: "llm".into(),
            summary: item["summary"].as_str().unwrap_or("").to_string(),
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
