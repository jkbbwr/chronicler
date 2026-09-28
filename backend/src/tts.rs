//! Read aloud: text-to-speech through the same AI provider as everything
//! else (OpenRouter, or a local OpenAI-compatible server such as
//! Kokoro-FastAPI): POST {base}/audio/speech with the AI key. App-wide
//! voice settings, and a per-project audio cache so re-listening to
//! unchanged prose is free.

use crate::ai::{self, ModelInfo, Provider};
use crate::app::App;
use anyhow::{Context, Result, bail};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Gemini 3.8 Flash TTS: natural long-form narration at $0.50/M in, $9/M out.
pub const DEFAULT_OPENROUTER_MODEL: &str = "google/gemini-3.8-flash-tts";

/// Persisted read-aloud settings (app-wide).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TtsConfig {
    /// Speech model id ("" = the provider's default, where it has one).
    pub model: String,
    /// Voice id ("" = the model's first voice).
    pub voice: String,
    /// Narration speed (1.0 = natural; only some models honour it).
    pub speed: f64,
}

impl Default for TtsConfig {
    fn default() -> Self {
        TtsConfig { model: String::new(), voice: String::new(), speed: 1.0 }
    }
}

impl TtsConfig {
    pub fn model(&self, provider: Provider) -> &str {
        match self.model.trim() {
            "" if provider == Provider::OpenRouter => DEFAULT_OPENROUTER_MODEL,
            m => m,
        }
    }

    pub fn effective_speed(&self) -> f64 {
        if self.speed.is_finite() { self.speed.clamp(0.25, 4.0) } else { 1.0 }
    }
}

/// A voice the writer can pick.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct TtsVoice {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// A short sample hosted by the provider.
    pub preview_url: Option<String>,
}

/// A speech model and the voices it offers.
#[derive(Serialize, TS, Clone, Debug)]
pub struct SpeechModel {
    #[serde(flatten)]
    #[ts(flatten)]
    pub info: ModelInfo,
    pub voices: Vec<String>,
}

/// Config (cached), the speech model list, and a lock serialising cache
/// writes/eviction.
#[derive(Default)]
pub struct TtsState {
    config: RwLock<Option<TtsConfig>>,
    models: RwLock<Vec<SpeechModel>>,
    /// Models that turned out to produce only raw PCM.
    pcm_models: RwLock<std::collections::HashSet<String>>,
    cache: Mutex<()>,
}

fn config_file() -> PathBuf {
    ai::config_dir().join("tts.json")
}

pub fn config(app: &App) -> TtsConfig {
    if let Some(cfg) = app.tts.config.read().clone() {
        return cfg;
    }
    let cfg = std::fs::read_to_string(config_file())
        .ok()
        .and_then(|s| serde_json::from_str::<TtsConfig>(&s).ok())
        .unwrap_or_default();
    *app.tts.config.write() = Some(cfg.clone());
    cfg
}

pub fn save_config(app: &App, cfg: TtsConfig) -> Result<()> {
    let dir = ai::config_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let tmp = dir.join(".tts.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&cfg)?)?;
    std::fs::rename(&tmp, config_file())?;
    *app.tts.config.write() = Some(cfg);
    Ok(())
}

/// Base URL and optional bearer key of the AI provider.
fn connection(app: &App) -> Result<(Provider, String, Option<String>)> {
    let cfg = ai::config(app);
    let base = ai::api_base(&cfg)?;
    let key = app.ai.key();
    if key.is_none() && cfg.provider == Provider::OpenRouter {
        bail!("No API key set — add one in Settings → AI");
    }
    Ok((cfg.provider, base, key))
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("starting the HTTP client")
}

/// A provider's error in plain language.
fn provider_error(status: reqwest::StatusCode, body: &[u8]) -> anyhow::Error {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let message = v["error"]["message"]
        .as_str()
        .or_else(|| v["detail"].as_str())
        .map(String::from)
        .unwrap_or_else(|| String::from_utf8_lossy(body).chars().take(200).collect());
    let lower = message.to_lowercase();
    if status.as_u16() == 402 || lower.contains("credits") || lower.contains("quota") {
        return anyhow::anyhow!("The AI provider is out of credits for now");
    }
    match status.as_u16() {
        401 | 403 => anyhow::anyhow!("The AI provider rejected the key — check it in Settings → AI"),
        429 => anyhow::anyhow!("The AI provider is rate-limiting requests — wait a moment and try again"),
        404 if lower.contains("voice") => anyhow::anyhow!("That voice isn't available — pick another in Settings → Read aloud"),
        400 | 404 | 422 => anyhow::anyhow!("The speech request was refused: {message}"),
        s if s >= 500 => anyhow::anyhow!("The AI provider is having trouble ({status}) — try again shortly"),
        _ => anyhow::anyhow!("Speech error ({status}): {message}"),
    }
}

async fn send(req: reqwest::RequestBuilder, what: &str) -> Result<Vec<u8>> {
    let resp = req.send().await.map_err(|e| anyhow::anyhow!("Couldn't reach the AI provider ({what}): {e}"))?;
    let status = resp.status();
    let body = resp.bytes().await.with_context(|| format!("reading {what}"))?.to_vec();
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    Ok(body)
}

fn get(http: &reqwest::Client, url: &str, key: &Option<String>) -> reqwest::RequestBuilder {
    let req = http.get(url);
    match key {
        Some(k) => req.bearer_auth(k),
        None => req,
    }
}

// ---------- Models and voices ----------

/// Speech models: OpenRouter lists them (with prices and voices); a local
/// server just lists everything it serves.
pub async fn models(app: &App) -> Result<Vec<SpeechModel>> {
    let (provider, base, key) = connection(app)?;
    let http = client()?;
    let url = match provider {
        Provider::OpenRouter => format!("{base}/models?output_modalities=speech"),
        Provider::OpenAiCompat => format!("{base}/models"),
    };
    let body: Value = serde_json::from_slice(&send(get(&http, &url, &key), "the speech models").await?)
        .context("reading the speech models")?;
    let mut out: Vec<SpeechModel> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            Some(SpeechModel {
                info: ModelInfo {
                    id: m["id"].as_str()?.to_string(),
                    name: m["name"].as_str().map(String::from),
                    context_length: None,
                    input_price: ai::per_million(&m["pricing"]["prompt"]),
                    output_price: ai::per_million(&m["pricing"]["completion"]).filter(|p| *p > 0.0),
                },
                voices: m["supported_voices"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.info.id.cmp(&b.info.id));
    *app.tts.models.write() = out.clone();
    Ok(out)
}

/// Voices for the configured model: from the model list, or a local
/// server's `/audio/voices` (Kokoro-FastAPI's shape).
pub async fn voices(app: &App) -> Result<Vec<TtsVoice>> {
    let (provider, base, key) = connection(app)?;
    let model = config(app).model(provider).to_string();
    let known = |app: &App| app.tts.models.read().iter().find(|m| m.info.id == model).map(|m| m.voices.clone());
    let mut ids = known(app);
    if ids.is_none() {
        models(app).await?;
        ids = known(app);
    }
    let mut ids = ids.unwrap_or_default();
    if ids.is_empty() && provider == Provider::OpenAiCompat {
        let http = client()?;
        if let Ok(bytes) = send(get(&http, &format!("{base}/audio/voices"), &key), "the voice list").await {
            let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            ids = v["voices"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().or_else(|| v["id"].as_str()).map(String::from))
                .collect();
        }
    }
    Ok(ids.into_iter().map(|id| TtsVoice { name: id.clone(), id, description: None, preview_url: None }).collect())
}

/// The voice to use: chosen, else the model's first.
async fn resolve_voice(app: &App, cfg: &TtsConfig) -> Result<String> {
    if !cfg.voice.trim().is_empty() {
        return Ok(cfg.voice.trim().to_string());
    }
    voices(app)
        .await?
        .into_iter()
        .next()
        .map(|v| v.id)
        .ok_or_else(|| anyhow::anyhow!("Choose a voice in Settings → Read aloud"))
}

// ---------- Speech ----------

/// Longest piece sent in one request.
pub const CHUNK_CHARS: usize = 4000;
/// Longest text accepted in one call.
pub const MAX_CHARS: usize = 20_000;
/// Cache cap per project.
pub const CACHE_CAP_BYTES: u64 = 300 * 1024 * 1024;

pub struct Speech {
    pub audio: Vec<u8>,
    pub mime: &'static str,
    pub chars: usize,
    pub cached: bool,
}

/// Synthesize `text` (mp3), from the project's cache when this exact text
/// was already read with the same settings.
/// `voice` overrides the configured voice (for previews in Settings).
pub async fn speak(app: &std::sync::Arc<App>, text: &str, voice: Option<&str>) -> Result<Speech> {
    let text = text.trim();
    if text.is_empty() {
        return Err(crate::rpc::invalid("Nothing to read aloud"));
    }
    let chars = text.chars().count();
    if chars > MAX_CHARS {
        return Err(crate::rpc::invalid(format!(
            "That passage is too long to read aloud in one go ({chars} characters; the limit is {MAX_CHARS})"
        )));
    }
    let (provider, base, key) = connection(app)?;
    let mut cfg = config(app);
    if let Some(v) = voice.map(str::trim).filter(|v| !v.is_empty()) {
        cfg.voice = v.to_string();
    }
    let model = cfg.model(provider).to_string();
    if model.is_empty() {
        bail!("Choose a speech model in Settings → Read aloud");
    }
    let voice = resolve_voice(app, &cfg).await?;
    let stem = cache_key(&base, &model, &voice, cfg.effective_speed(), text);
    let dir = cache_dir(&app.root);
    for ext in ["mp3", "wav"] {
        let path = dir.join(format!("{stem}.{ext}"));
        if let Ok(audio) = std::fs::read(&path) {
            // Touch it so eviction treats it as recently used.
            if let Ok(f) = std::fs::File::options().append(true).open(&path) {
                let _ = f.set_modified(std::time::SystemTime::now());
            }
            return Ok(Speech { audio, mime: mime_for(ext), chars, cached: true });
        }
    }

    let http = client()?;
    let mut pcm = app.tts.pcm_models.read().contains(&model) || model.contains("gemini");
    let mut audio = Vec::new();
    let mut rate = PCM_RATE;
    for piece in split_text(text, CHUNK_CHARS) {
        let clip = loop {
            let mut body = json!({ "model": model, "voice": voice, "input": piece, "response_format": if pcm { "pcm" } else { "mp3" } });
            let speed = cfg.effective_speed();
            if (speed - 1.0).abs() > f64::EPSILON {
                body["speed"] = json!(speed);
            }
            let mut req = http.post(format!("{base}/audio/speech")).json(&body);
            if let Some(k) = &key {
                req = req.bearer_auth(k);
            }
            let resp = req.send().await.map_err(|e| anyhow::anyhow!("Couldn't reach the AI provider (speech): {e}"))?;
            let status = resp.status();
            let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let bytes = resp.bytes().await.context("reading speech")?.to_vec();
            if status.is_success() {
                if let Some(r) = pcm_rate(&ctype) {
                    rate = r;
                }
                break bytes;
            }
            // Some models (Gemini) only produce raw PCM: switch once and remember.
            if !pcm && status.as_u16() == 400 && String::from_utf8_lossy(&bytes).to_lowercase().contains("pcm") {
                pcm = true;
                app.tts.pcm_models.write().insert(model.clone());
                continue;
            }
            return Err(provider_error(status, &bytes));
        };
        if clip.is_empty() {
            bail!("The AI provider returned no audio");
        }
        audio.extend(clip);
    }
    let ext = if pcm { "wav" } else { "mp3" };
    if pcm {
        audio = wav(trim_silence(&audio, rate), rate);
    }

    let path = dir.join(format!("{stem}.{ext}"));
    let stored = audio.clone();
    app.blocking(move |app| {
        let _guard = app.tts.cache.lock();
        store(&path, &stored)?;
        evict(path.parent().unwrap(), CACHE_CAP_BYTES);
        Ok(())
    })
    .await
    .unwrap_or_else(|e| tracing::warn!("read-aloud cache: {e:#}"));
    Ok(Speech { audio, mime: mime_for(ext), chars, cached: false })
}

/// Raw PCM is 16-bit little-endian mono; Gemini speaks at 24 kHz.
const PCM_RATE: u32 = 24_000;

/// `audio/pcm;rate=24000` → 24000.
fn pcm_rate(content_type: &str) -> Option<u32> {
    content_type
        .split(';')
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| matches!(k.trim(), "rate" | "sample_rate" | "samplerate"))
        .and_then(|(_, v)| v.trim().parse().ok())
}

fn mime_for(ext: &str) -> &'static str {
    if ext == "wav" { "audio/wav" } else { "audio/mpeg" }
}

/// Silence kept before and after the voice, so paragraphs flow with a
/// natural pause instead of the half second of padding models add.
const KEEP_LEAD_MS: usize = 40;
const KEEP_TRAIL_MS: usize = 160;

/// Trim leading/trailing near-silence from 16-bit mono PCM.
pub fn trim_silence(pcm: &[u8], rate: u32) -> &[u8] {
    let samples = pcm.len() / 2;
    let amp = |i: usize| i16::from_le_bytes([pcm[2 * i], pcm[2 * i + 1]]).unsigned_abs();
    let peak = (0..samples).map(amp).max().unwrap_or(0);
    // Quiet relative to this clip, with a floor for hiss.
    let threshold = (peak / 30).max(300);
    let (Some(first), Some(last)) = ((0..samples).find(|&i| amp(i) > threshold), (0..samples).rev().find(|&i| amp(i) > threshold))
    else {
        return pcm;
    };
    let per_ms = rate as usize / 1000;
    let start = first.saturating_sub(KEEP_LEAD_MS * per_ms);
    let end = (last + 1 + KEEP_TRAIL_MS * per_ms).min(samples);
    &pcm[2 * start..2 * end]
}

/// Wrap raw 16-bit mono PCM in a WAV header so any player takes it.
pub fn wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut out = Vec::with_capacity(pcm.len() + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Pieces of at most `max` characters, broken after a sentence where
/// possible, else at a space, else anywhere.
pub fn split_text(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while rest.chars().count() > max {
        // Byte offset just past the `max`th character.
        let limit = rest.char_indices().nth(max).map(|(i, _)| i).unwrap_or(rest.len());
        let window = &rest[..limit];
        let sentence = window
            .char_indices()
            .filter(|&(i, c)| {
                matches!(c, '.' | '!' | '?' | '…' | '"' | '”' | '’')
                    && window[i + c.len_utf8()..].starts_with(char::is_whitespace)
            })
            .map(|(i, c)| i + c.len_utf8())
            .next_back();
        let cut = sentence
            .filter(|&i| i > limit / 3)
            .or_else(|| window.rfind(char::is_whitespace).filter(|&i| i > 0))
            .unwrap_or(limit);
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

fn cache_dir(root: &Path) -> PathBuf {
    root.join(".chronicler").join("tts-cache")
}

/// Everything that changes the audio.
pub fn cache_key(base: &str, model: &str, voice: &str, speed: f64, text: &str) -> String {
    let mut h = Sha256::new();
    for part in [base, model, voice, &format!("{speed:.3}"), text] {
        h.update(part.as_bytes());
        h.update([0u8]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn store(path: &Path, audio: &[u8]) -> Result<()> {
    let dir = path.parent().context("cache path")?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.tmp", std::process::id()));
    std::fs::write(&tmp, audio)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Delete the least recently used clips until the cache is under `cap`
/// (with some headroom, so this doesn't run on every write).
pub fn evict(dir: &Path, cap: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "mp3" || x == "wav"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= cap {
        return;
    }
    let target = cap / 10 * 9;
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= target {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_at_sentences_then_spaces() {
        let text = "One two three. Four five six. Seven eight nine.";
        let parts = split_text(text, 20);
        assert_eq!(parts, vec!["One two three.", "Four five six.", "Seven eight nine."]);
        assert!(parts.iter().all(|p| p.chars().count() <= 20));
        let words = split_text("aaaa bbbb cccc dddd", 10);
        assert_eq!(words, vec!["aaaa bbbb", "cccc dddd"]);
        let solid = split_text("abcdefghij", 4);
        assert_eq!(solid, vec!["abcd", "efgh", "ij"]);
        assert_eq!(split_text("short", 4000), vec!["short"]);
        // Multi-byte characters never split mid-char.
        let accents = split_text("éééé éééé", 5);
        assert_eq!(accents, vec!["éééé", "éééé"]);
    }

    #[test]
    fn cache_key_tracks_what_changes_the_audio() {
        let k = cache_key("b", "m", "v", 1.0, "Hello.");
        assert_eq!(k, cache_key("b", "m", "v", 1.0, "Hello."));
        assert_ne!(k, cache_key("b", "m", "v", 1.0, "Hello!"));
        assert_ne!(k, cache_key("b", "m", "other", 1.0, "Hello."));
        assert_ne!(k, cache_key("b", "m2", "v", 1.0, "Hello."));
        assert_ne!(k, cache_key("b", "m", "v", 1.1, "Hello."));
        assert_ne!(k, cache_key("local", "m", "v", 1.0, "Hello."));
    }

    #[test]
    fn eviction_drops_the_oldest_first() {
        let dir = std::env::temp_dir().join(format!("chronicler-tts-evict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let now = std::time::SystemTime::now();
        for (i, name) in ["old", "mid", "new"].iter().enumerate() {
            let p = dir.join(format!("{name}.mp3"));
            std::fs::write(&p, vec![0u8; 100]).unwrap();
            let f = std::fs::File::options().append(true).open(&p).unwrap();
            f.set_modified(now - std::time::Duration::from_secs(100 - i as u64 * 10)).unwrap();
        }
        evict(&dir, 250);
        assert!(!dir.join("old.mp3").exists());
        assert!(dir.join("mid.mp3").exists() && dir.join("new.mp3").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pcm_becomes_a_playable_wav() {
        assert_eq!(pcm_rate("audio/pcm; rate=16000"), Some(16000));
        assert_eq!(pcm_rate("audio/pcm"), None);
        let w = wav(&[1, 2, 3, 4], 24_000);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 24_000);
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 4);
        assert_eq!(&w[44..], &[1, 2, 3, 4]);
    }

    #[test]
    fn trims_padding_but_keeps_a_natural_pause() {
        let rate = 1000; // 1 sample per ms keeps the arithmetic readable
        let mut samples = vec![0i16; 500]; // 500 ms of silence
        samples.extend(std::iter::repeat_n(8000i16, 100)); // the voice
        samples.extend(vec![0i16; 500]);
        let pcm: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let out = trim_silence(&pcm, rate);
        assert_eq!(out.len() / 2, KEEP_LEAD_MS + 100 + KEEP_TRAIL_MS);
        // All silence: left alone.
        let quiet = vec![0u8; 400];
        assert_eq!(trim_silence(&quiet, rate).len(), 400);
    }

    #[test]
    fn plain_language_errors() {
        let e = provider_error(reqwest::StatusCode::UNAUTHORIZED, br#"{"error":{"message":"No auth"}}"#);
        assert_eq!(e.to_string(), "The AI provider rejected the key — check it in Settings → AI");
        let e = provider_error(reqwest::StatusCode::PAYMENT_REQUIRED, br#"{"error":{"message":"Insufficient credits"}}"#);
        assert!(e.to_string().contains("out of credits"), "{e}");
    }
}
