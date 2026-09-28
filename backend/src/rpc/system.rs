use super::{NoParams, required};
use crate::app::App;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn ping(_: &App, _: NoParams) -> Result<String> {
    Ok("pong".into())
}

#[derive(Serialize, TS)]
pub struct SystemInfo {
    pub version: String,
    pub status: String,
    /// Absolute project root.
    pub root: String,
}

pub fn info(app: &App, _: NoParams) -> Result<SystemInfo> {
    Ok(SystemInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        status: "ready".into(),
        root: app.root.display().to_string(),
    })
}

/// Outside programs Chronicler relies on, with their versions; `None` when
/// not installed (or not on PATH).
#[derive(Serialize, TS)]
#[ts(optional_fields)]
pub struct Tools {
    /// jj — version history.
    pub jj: Option<String>,
    /// typst — compiling the manuscript.
    pub typst: Option<String>,
}

fn version_of(program: &str) -> Option<String> {
    let out = std::process::Command::new(program).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // "jj 0.41.0-413f…" / "typst 0.14.0 (b33de9de)" → "0.41.0" / "0.14.0"
    let v = text.split_whitespace().nth(1)?;
    out.status.success().then(|| v.split('-').next().unwrap_or(v).to_string())
}

pub fn tools(_: &App, _: NoParams) -> Result<Tools> {
    Ok(Tools { jj: version_of("jj"), typst: version_of("typst") })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingGetParams {
    pub key: String,
}

#[derive(Serialize, TS)]
pub struct SettingValue {
    pub value: Option<String>,
}

pub fn setting_get(app: &App, p: SettingGetParams) -> Result<SettingValue> {
    Ok(SettingValue {
        value: app.db.get_setting(required("key", &p.key)?)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SettingSetParams {
    pub key: String,
    pub value: String,
}

pub fn setting_set(app: &App, p: SettingSetParams) -> Result<()> {
    app.db.set_setting(required("key", &p.key)?, &p.value)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct StatsParams {
    /// The client's local date, e.g. "2026-08-25".
    pub today: String,
}

pub fn stats(app: &App, p: StatsParams) -> Result<crate::stats::ProjectStats> {
    crate::stats::project_stats(app, required("today", &p.today)?)
}
