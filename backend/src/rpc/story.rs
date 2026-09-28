//! Plot threads, what the reader knows, and margin notes.

use super::NoParams;
use super::codex::IdParams;
use super::docs::PathParams;
use crate::app::App;
use crate::fsx::RelPath;
use crate::story::{self, Note, ReaderKnowledge, Thread};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct ThreadList {
    pub threads: Vec<Thread>,
}

pub fn threads(app: &App, _: NoParams) -> Result<ThreadList> {
    Ok(ThreadList { threads: app.db.with(story::threads)? })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadCreateParams {
    pub name: String,
    /// A colour token name; omit for the default.
    pub color: Option<String>,
}

pub fn thread_create(app: &App, p: ThreadCreateParams) -> Result<super::codex::IdResult> {
    let id = app.db.with(|c| story::create_thread(c, &p.name, p.color.as_deref().unwrap_or("")))?;
    Ok(super::codex::IdResult { id })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ThreadUpdateParams {
    pub id: i64,
    pub name: Option<String>,
    pub color: Option<String>,
    pub position: Option<i64>,
}

pub fn thread_update(app: &App, p: ThreadUpdateParams) -> Result<()> {
    app.db.with(|c| story::update_thread(c, p.id, p.name.as_deref(), p.color.as_deref(), p.position))
}

pub fn thread_delete(app: &App, p: IdParams) -> Result<()> {
    app.db.tx(|tx| story::delete_thread(tx, p.id))
}

pub fn reader_knowledge(app: &App, p: PathParams) -> Result<ReaderKnowledge> {
    story::reader_knowledge(app, &RelPath::parse(&p.path)?)
}

#[derive(Serialize, TS)]
pub struct NoteList {
    pub notes: Vec<Note>,
}

pub fn notes(app: &App, _: NoParams) -> Result<NoteList> {
    Ok(NoteList { notes: story::all_notes(app) })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NoteResolveParams {
    pub path: String,
    /// 1-based line the note starts on (as listed).
    pub line: usize,
    /// The note's text (as listed), to find it even if lines shifted.
    pub text: String,
}

/// Remove a margin note from the scene's text on disk.
pub fn note_resolve(app: &App, p: NoteResolveParams) -> Result<()> {
    let rel = RelPath::parse(&p.path)?;
    let content = app.read(&rel)?;
    let Some(updated) = story::resolve_note(&content, p.line, &p.text) else {
        bail!(super::invalid("That note isn't in the scene any more"));
    };
    app.write(&rel, &updated)
}

// ---------- Splitting and merging scenes ----------

/// A manuscript scene that exists: (rel, parent folder, file name).
fn scene_parts(app: &App, path: &str) -> Result<(RelPath, String, String)> {
    let (rel, abs) = app.path(path)?;
    if !rel.as_str().ends_with(".md") || crate::fsx::is_research_path(rel.as_str()) || !abs.is_file() {
        return Err(super::invalid(format!("“{rel}” isn't a scene")));
    }
    let (parent, name) = rel.as_str().rsplit_once('/').unwrap_or(("", rel.as_str()));
    let (parent, name) = (parent.to_string(), name.to_string());
    Ok((rel, parent, name))
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SplitParams {
    pub path: String,
    /// What stays in this scene.
    pub before: String,
    /// What becomes the new scene, placed right after it.
    pub after: String,
    /// The new scene's name (without .md); omitted, "<this scene> (2)".
    pub name: Option<String>,
}

#[derive(Serialize, TS)]
pub struct SplitResult {
    /// The new scene.
    pub path: String,
}

/// Split a scene in two. The new one follows it in the binder and inherits
/// its point of view, place, story time, status and threads.
pub fn split(app: &App, p: SplitParams) -> Result<SplitResult> {
    let (rel, parent, name) = scene_parts(app, &p.path)?;
    if p.before.trim().is_empty() || p.after.trim().is_empty() {
        return Err(super::invalid("Put the cursor where the new scene should begin — inside the text, not at either end"));
    }
    let stem = name.trim_end_matches(".md");
    let wanted = p.name.as_deref().map(|n| n.trim().trim_end_matches(".md").replace('/', "-")).filter(|n| !n.is_empty());
    let new_name = match wanted {
        Some(n) => {
            let file = format!("{n}.md");
            if app.root.join(join(&parent, &file)).exists() {
                return Err(super::invalid(format!("“{n}” already exists here")));
            }
            file
        }
        None => (2..)
            .map(|i| format!("{stem} ({i}).md"))
            .find(|f| !app.root.join(join(&parent, f)).exists())
            .expect("a free name"),
    };
    let new_rel = RelPath::document(&join(&parent, &new_name))?;

    let mut names: Vec<String> = crate::book::folder_order(app, &parent).into_iter().map(|(n, _)| n).collect();
    let at = names.iter().position(|n| *n == name).map_or(names.len(), |i| i + 1);
    names.insert(at, new_name);

    app.write(&rel, &format!("{}\n", p.before.trim_end()))?;
    app.write(&new_rel, &format!("{}\n", p.after.trim_start_matches(['\n', '\r']).trim_end()))?;
    crate::book::set_folder_order(app, &parent, names)?;

    app.db.tx(|tx| {
        let from = story::all_details(tx)?.into_iter().find(|d| d.file == rel.as_str()).unwrap_or_default();
        story::set_details(
            tx,
            new_rel.as_str(),
            None,
            Some(&from.status),
            from.pov,
            from.location,
            Some(&from.story_time),
            None,
            Some(&from.threads),
        )
    })?;
    Ok(SplitResult { path: new_rel.as_str().to_string() })
}

#[derive(Serialize, TS)]
pub struct MergeResult {
    /// The scene that was folded in (now gone).
    pub merged: String,
}

/// Fold the next scene in the same chapter onto the end of this one. The
/// merged scene keeps both scenes' threads and their word targets added
/// up; the other file goes to the trash (and stays in History).
pub fn merge(app: &App, p: PathParams) -> Result<MergeResult> {
    let (rel, parent, name) = scene_parts(app, &p.path)?;
    let entries = crate::book::folder_order(app, &parent);
    let next = entries
        .iter()
        .skip_while(|(n, _)| *n != name)
        .skip(1)
        .find(|(n, dir)| !dir && n.ends_with(".md"))
        .map(|(n, _)| n.clone())
        .ok_or_else(|| super::invalid(format!("“{}” is the last scene in its chapter", crate::book::display_name(&name))))?;
    let next_rel = RelPath::document(&join(&parent, &next))?;

    let (a, b) = (app.read(&rel)?, app.read(&next_rel)?);
    app.write(&rel, &format!("{}\n\n{}\n", a.trim_end(), b.trim_start_matches(['\n', '\r']).trim_end()))?;

    app.db.tx(|tx| {
        let all = story::all_details(tx)?;
        let get = |f: &str| all.iter().find(|d| d.file == f).cloned().unwrap_or_default();
        let (da, db) = (get(rel.as_str()), get(next_rel.as_str()));
        let mut threads = da.threads.clone();
        threads.extend(db.threads.iter().filter(|t| !da.threads.contains(t)));
        let target = if da.target > 0 && db.target > 0 { Some(da.target + db.target) } else { None };
        story::set_details(tx, rel.as_str(), None, None, None, None, None, target, Some(&threads))
    })?;

    super::docs::delete(app, PathParams { path: next_rel.as_str().to_string() })?;
    let names: Vec<String> = entries.into_iter().map(|(n, _)| n).filter(|n| *n != next).collect();
    crate::book::set_folder_order(app, &parent, names)?;
    Ok(MergeResult { merged: next_rel.as_str().to_string() })
}
