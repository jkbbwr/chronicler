//! Research: the non-manuscript folder of notes, clippings, images and PDFs.
//! Rename and delete go through `project/rename` / `project/delete`.

use super::docs::PathParams;
use super::{NoParams, required};
use crate::app::App;
use crate::research::{self, ResearchItem};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct ResearchList {
    /// Notes, clippings, images, PDFs, other — each by name.
    pub items: Vec<ResearchItem>,
}

pub fn list(app: &App, _: NoParams) -> Result<ResearchList> {
    Ok(ResearchList {
        items: research::list(app)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ResearchNoteParams {
    /// The note's title; also its file name (made unique).
    pub name: String,
}

#[derive(Serialize, TS)]
pub struct ResearchPath {
    /// Project-relative path of the new file.
    pub path: String,
}

pub fn new_note(app: &App, p: ResearchNoteParams) -> Result<ResearchPath> {
    let rel = research::new_note(app, required("name", &p.name)?)?;
    Ok(ResearchPath {
        path: rel.as_str().to_string(),
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ResearchClipParams {
    /// An http(s) address.
    pub url: String,
}

#[derive(Serialize, TS)]
pub struct ResearchClipResult {
    /// `Research/Clippings/<title>.md`.
    pub path: String,
    pub title: String,
}

pub async fn clip(app: Arc<App>, p: ResearchClipParams) -> Result<ResearchClipResult> {
    let (rel, title) = research::clip(&app, required("url", &p.url)?).await?;
    Ok(ResearchClipResult {
        path: rel.as_str().to_string(),
        title,
    })
}

#[derive(Serialize, TS)]
pub struct ResearchText {
    pub text: String,
}

/// The text of a note or clipping (not images, PDFs or other files).
pub fn read(app: &App, p: PathParams) -> Result<ResearchText> {
    Ok(ResearchText {
        text: research::read_text(app, &p.path)?,
    })
}
