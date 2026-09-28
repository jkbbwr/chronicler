//! Version history (jj).

use super::codex::OptionalPathParams;
use crate::app::App;
use crate::fsx::RelPath;
use crate::history::{ChangeList, Diff, Evolog, LockIn};
use anyhow::Result;
use serde::Deserialize;
use ts_rs::TS;

pub fn changes(app: &App, p: OptionalPathParams) -> Result<ChangeList> {
    let rel = p.rel()?;
    app.history.changes(rel.as_ref().map(RelPath::as_str))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChangeIdParams {
    pub change_id: String,
}

pub fn evolog(app: &App, p: ChangeIdParams) -> Result<Evolog> {
    app.history.evolog(&p.change_id)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DescribeParams {
    pub change_id: String,
    pub message: String,
}

pub fn describe(app: &App, p: DescribeParams) -> Result<()> {
    app.history.describe(&p.change_id, &p.message)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct LockInParams {
    /// The name for the locked-in change (required).
    pub message: String,
}

pub fn lock_in(app: &App, p: LockInParams) -> Result<LockIn> {
    app.history.lock_in(&p.message)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct RestoreParams {
    /// A change id, commit id, or "@".
    pub rev: String,
    /// One file; omit to restore the whole project.
    pub path: Option<String>,
}

pub fn restore(app: &App, p: RestoreParams) -> Result<()> {
    let rel = p
        .path
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(RelPath::parse)
        .transpose()?;
    app.history
        .restore(&p.rev, rel.as_ref().map(RelPath::as_str))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct DiffParams {
    pub from: String,
    pub to: String,
    /// One file; omit for every changed file.
    pub path: Option<String>,
}

pub fn diff(app: &App, p: DiffParams) -> Result<Diff> {
    let rel = p
        .path
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(RelPath::parse)
        .transpose()?;
    app.history
        .diff(&p.from, &p.to, rel.as_ref().map(RelPath::as_str))
}
