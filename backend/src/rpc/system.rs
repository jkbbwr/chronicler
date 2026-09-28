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

/// Outside programs Chronicler relies on, with their versions (`None`
/// when they can't be run) and where the writer said they are ("" = PATH).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Tools {
    /// jj — version history.
    pub jj: Option<String>,
    /// typst — compiling the manuscript.
    pub typst: Option<String>,
    pub jj_path: String,
    pub typst_path: String,
}

pub fn tools(_: &App, _: NoParams) -> Result<Tools> {
    use crate::tools::{Tool, paths, version};
    let p = paths();
    Ok(Tools { jj: version(Tool::Jj), typst: version(Tool::Typst), jj_path: p.jj, typst_path: p.typst })
}

/// Point Chronicler at a program ("" = look on PATH again).
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ToolPathParams {
    pub tool: crate::tools::Tool,
    pub path: String,
}

pub fn tools_set(app: &App, p: ToolPathParams) -> Result<Tools> {
    use crate::tools::{Tool, paths, set_paths};
    let mut all = paths();
    let path = p.path.trim().to_string();
    match p.tool {
        Tool::Jj => all.jj = path,
        Tool::Typst => all.typst = path,
    }
    set_paths(all)?;
    tools(app, NoParams::default())
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
