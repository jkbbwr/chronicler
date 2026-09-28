//! Documents, the binder tree, search/replace, and scene metadata.

use super::{NoParams, invalid};
use crate::app::App;
use crate::fsx::{self, FileEntry, Matcher, RelPath};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::ops::ControlFlow;
use std::path::Path;
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PathParams {
    /// Project-relative path.
    pub path: String,
}

#[derive(Serialize, TS)]
pub struct DocumentContent {
    pub content: String,
}

/// Read a manuscript file, or an app-data file such as
/// `.chronicler/order.json`.
pub fn read(app: &App, p: PathParams) -> Result<DocumentContent> {
    let rel = RelPath::document(&p.path)?;
    Ok(DocumentContent {
        content: app.read(&rel)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SaveParams {
    pub path: String,
    pub content: String,
}

pub fn save(app: &App, p: SaveParams) -> Result<()> {
    let rel = RelPath::document(&p.path)?;
    if rel.as_str().starts_with('.') {
        std::fs::create_dir_all(app.root.join(".chronicler"))?;
    }
    app.write(&rel, &p.content)
}

#[derive(Serialize, TS)]
pub struct FileList {
    /// Folders first, then files, each alphabetical by path.
    pub files: Vec<FileEntry>,
}

pub fn list_files(app: &App, _: NoParams) -> Result<FileList> {
    let mut files = fsx::walk(&app.root);
    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.path.cmp(&b.path)));
    Ok(FileList { files })
}

pub fn create_folder(app: &App, p: PathParams) -> Result<()> {
    let (rel, abs) = app.path(&p.path)?;
    std::fs::create_dir_all(&abs).with_context(|| format!("creating {rel}"))?;
    Ok(())
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RenameParams {
    pub from: String,
    pub to: String,
}

/// Rename or move a file or folder. Refuses to overwrite anything (a
/// case-only rename of the same file is fine); every path-keyed index
/// follows the move.
pub fn rename(app: &App, p: RenameParams) -> Result<()> {
    let (from, from_abs) = app.path(&p.from)?;
    let (to, to_abs) = app.path(&p.to)?;
    if from == to {
        return Ok(());
    }
    if std::fs::symlink_metadata(&from_abs).is_err() {
        return Err(invalid(format!("“{from}” doesn't exist")));
    }
    if to.as_str().starts_with(&format!("{from}/")) {
        return Err(invalid(format!("Can't move “{from}” inside itself")));
    }
    if std::fs::symlink_metadata(&to_abs).is_ok() && !same_file(&from_abs, &to_abs) {
        return Err(invalid(format!("“{to}” already exists")));
    }
    std::fs::rename(&from_abs, &to_abs).with_context(|| format!("renaming {from} to {to}"))?;
    app.db
        .tx(|tx| crate::db::move_path_rows(tx, from.as_str(), to.as_str()))
}

/// Move a file or folder to the OS trash (recoverable), then drop its rows
/// from every index.
pub fn delete(app: &App, p: PathParams) -> Result<()> {
    let (rel, abs) = app.path(&p.path)?;
    if std::fs::symlink_metadata(&abs).is_err() {
        return Err(invalid(format!("“{rel}” doesn't exist")));
    }
    move_to_trash(&abs).with_context(|| format!("deleting {rel}"))?;
    app.db
        .tx(|tx| crate::db::delete_path_rows(tx, rel.as_str()))
}

fn move_to_trash(abs: &Path) -> Result<()> {
    // Test suites must not fill the developer's real Trash.
    if std::env::var_os("CHRONICLER_DELETE_PERMANENTLY").is_some() {
        if abs.is_dir() {
            std::fs::remove_dir_all(abs)?;
        } else {
            std::fs::remove_file(abs)?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        // NSFileManager: no Finder scripting, no permission prompt.
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(abs)?;
    }
    #[cfg(not(target_os = "macos"))]
    trash::delete(abs)?;
    Ok(())
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SearchParams {
    pub query: String,
    /// Default false.
    pub match_case: Option<bool>,
}

#[derive(Serialize, TS)]
pub struct SearchHit {
    pub file: String,
    /// 1-based.
    pub line: usize,
    /// The trimmed line, at most 200 characters.
    pub text: String,
}

#[derive(Serialize, TS)]
pub struct SearchResults {
    /// At most 200.
    pub results: Vec<SearchHit>,
}

const MAX_SEARCH_RESULTS: usize = 200;

pub fn search(app: &App, p: SearchParams) -> Result<SearchResults> {
    let matcher = Matcher::new(&p.query, p.match_case.unwrap_or(false))?;
    let mut results = Vec::new();
    fsx::grep(&app.root, &matcher, |file, line, text| {
        results.push(SearchHit {
            file: file.to_string(),
            line,
            text: text.trim().chars().take(200).collect(),
        });
        if results.len() >= MAX_SEARCH_RESULTS {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    });
    Ok(SearchResults { results })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ReplaceParams {
    pub query: String,
    pub replacement: String,
    pub match_case: Option<bool>,
    /// Limit to one file…
    pub file: Option<String>,
    /// …and optionally one 1-based line in it.
    pub line: Option<usize>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: usize,
    pub occurrences: usize,
}

/// Replace occurrences of `query` across the project, one file, or one
/// line. Line endings are preserved.
pub fn replace(app: &App, p: ReplaceParams) -> Result<ReplaceResult> {
    let matcher = Matcher::new(&p.query, p.match_case.unwrap_or(false))?;
    if p.line.is_some() && p.file.is_none() {
        return Err(invalid("`line` needs `file`"));
    }
    let files: Vec<RelPath> = match &p.file {
        Some(f) => vec![RelPath::parse(f)?],
        None => app
            .md_files()
            .iter()
            .filter_map(|f| RelPath::parse(f).ok())
            .collect(),
    };
    let mut result = ReplaceResult {
        files_changed: 0,
        occurrences: 0,
    };
    for rel in &files {
        let Ok(content) = app.read(rel) else { continue };
        let (new_content, n) = fsx::replace_in_text(&content, &matcher, &p.replacement, p.line);
        if n > 0 {
            app.write(rel, &new_content)?;
            result.files_changed += 1;
            result.occurrences += n;
        }
    }
    Ok(result)
}

#[derive(Serialize, TS)]
pub struct SceneMetaList {
    pub meta: Vec<crate::story::SceneDetails>,
}

pub fn meta_all(app: &App, _: NoParams) -> Result<SceneMetaList> {
    Ok(SceneMetaList { meta: app.db.with(crate::story::all_details)? })
}

/// Partial update of a scene's details: omitted fields keep their values.
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct MetaSetParams {
    pub path: String,
    pub synopsis: Option<String>,
    /// idea | draft | revised | final | ""
    pub status: Option<String>,
    /// Codex entity id for the point-of-view character; 0 clears.
    pub pov: Option<i64>,
    /// Codex entity id for the location; 0 clears.
    pub location: Option<i64>,
    pub story_time: Option<String>,
    /// Word target; 0 clears.
    pub target: Option<u32>,
    /// Plot thread ids (replaces the scene's set).
    pub threads: Option<Vec<i64>>,
}

pub fn meta_set(app: &App, p: MetaSetParams) -> Result<()> {
    let rel = RelPath::parse(&p.path)?;
    app.db.tx(|tx| {
        crate::story::set_details(
            tx,
            rel.as_str(),
            p.synopsis.as_deref(),
            p.status.as_deref(),
            p.pov,
            p.location,
            p.story_time.as_deref(),
            p.target,
            p.threads.as_deref(),
        )
    })
}
