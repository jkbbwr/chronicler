use super::NoParams;
use crate::app::App;
use crate::journal::{self, JournalEntry};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct JournalWriteParams {
    pub path: String,
    /// The unsaved buffer.
    pub content: String,
}

pub fn write(app: &App, p: JournalWriteParams) -> Result<()> {
    journal::write(app, &p.path, &p.content)
}

#[derive(Serialize, TS)]
pub struct JournalEntries {
    /// Oldest first.
    pub entries: Vec<JournalEntry>,
}

pub fn read(app: &App, _: NoParams) -> Result<JournalEntries> {
    Ok(JournalEntries {
        entries: journal::read(app)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct JournalClearParams {
    /// Omit to clear every entry.
    pub path: Option<String>,
}

pub fn clear(app: &App, p: JournalClearParams) -> Result<()> {
    journal::clear(app, p.path.as_deref())
}
