//! Read aloud: settings, speech models, voices and speech. The connection
//! (provider, key, address) is the one in Settings → AI.

use super::NoParams;
use crate::app::App;
use crate::tts::{self, TtsConfig};
use anyhow::Result;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TtsConfigView {
    /// The speech model in use ("" when the provider has no default and none was chosen).
    pub model: String,
    /// The chosen voice ("" = the model's first).
    pub voice: String,
    /// Narration speed (1.0 = natural).
    pub speed: f64,
}

pub fn config(app: &App, _: NoParams) -> Result<TtsConfigView> {
    let c = tts::config(app);
    let provider = crate::ai::config(app).provider;
    Ok(TtsConfigView { model: c.model(provider).to_string(), voice: c.voice, speed: c.speed })
}

/// Partial update: omitted fields keep their values. Changing the model
/// clears the voice (voices belong to a model) unless one is given too.
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TtsConfigSetParams {
    pub model: Option<String>,
    pub voice: Option<String>,
    pub speed: Option<f64>,
}

pub fn config_set(app: &App, p: TtsConfigSetParams) -> Result<()> {
    let cur = tts::config(app);
    if let Some(s) = p.speed
        && !(s.is_finite() && (0.25..=4.0).contains(&s))
    {
        return Err(super::invalid("Speed must be between 0.25 and 4"));
    }
    let switched = p.model.as_ref().is_some_and(|m| *m != cur.model);
    tts::save_config(
        app,
        TtsConfig {
            voice: p.voice.unwrap_or(if switched { String::new() } else { cur.voice }),
            model: p.model.unwrap_or(cur.model),
            speed: p.speed.unwrap_or(cur.speed),
        },
    )
}

#[derive(Serialize, TS)]
pub struct SpeechModelList {
    pub models: Vec<tts::SpeechModel>,
}

pub async fn models(app: Arc<App>, _: NoParams) -> Result<SpeechModelList> {
    Ok(SpeechModelList { models: tts::models(&app).await? })
}

#[derive(Serialize, TS)]
pub struct TtsVoiceList {
    pub voices: Vec<tts::TtsVoice>,
}

pub async fn voices(app: Arc<App>, _: NoParams) -> Result<TtsVoiceList> {
    Ok(TtsVoiceList { voices: tts::voices(&app).await? })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SpeakParams {
    /// Plain text (markdown already stripped), ideally one paragraph.
    pub text: String,
    /// A voice other than the configured one (previews).
    pub voice: Option<String>,
}

#[derive(Serialize, TS)]
pub struct SpeakResult {
    /// Base64-encoded audio.
    pub audio: String,
    /// Its type: audio/mpeg or audio/wav.
    pub mime: String,
    /// Characters read.
    pub chars: usize,
    /// Served from the project's cache (no provider call, no cost).
    pub cached: bool,
}

pub async fn speak(app: Arc<App>, p: SpeakParams) -> Result<SpeakResult> {
    let s = tts::speak(&app, &p.text, p.voice.as_deref()).await?;
    Ok(SpeakResult {
        audio: base64::engine::general_purpose::STANDARD.encode(&s.audio),
        mime: s.mime.to_string(),
        chars: s.chars,
        cached: s.cached,
    })
}
