//! The codex, its discovery inbox, relations, and index maintenance.

use super::{NoParams, invalid, required};
use crate::app::App;
use crate::codex::{self, CandidateRow, Entity, EntityPatch, Mention, Promoted};
use crate::fsx::RelPath;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct IdParams {
    pub id: i64,
}

#[derive(Serialize, TS)]
pub struct IdResult {
    pub id: i64,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NameParams {
    pub name: String,
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct OptionalPathParams {
    /// One file; omit for the whole project.
    pub path: Option<String>,
}

impl OptionalPathParams {
    /// The requested file, or every manuscript file.
    pub fn files(&self, app: &App) -> Result<Vec<String>> {
        Ok(match self.path.as_deref().filter(|p| !p.is_empty()) {
            // Research isn't manuscript: never checked, indexed or scanned.
            Some(p) if crate::fsx::is_research_path(p) => vec![],
            Some(p) => vec![RelPath::parse(p)?.as_str().to_string()],
            None => app.md_files(),
        })
    }

    pub fn rel(&self) -> Result<Option<RelPath>> {
        self.path
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(RelPath::parse)
            .transpose()
    }
}

#[derive(Serialize, TS)]
pub struct EntityList {
    pub entities: Vec<Entity>,
}

pub fn list(app: &App, _: NoParams) -> Result<EntityList> {
    Ok(EntityList {
        entities: app.db.with(codex::list_entities)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct EntityCreateParams {
    pub name: String,
    /// Default "character".
    pub kind: Option<String>,
    pub summary: Option<String>,
    pub aliases: Option<Vec<String>>,
}

pub fn create(app: &App, p: EntityCreateParams) -> Result<IdResult> {
    let id = app.db.with(|c| {
        codex::create_entity(
            c,
            &p.name,
            p.kind.as_deref().unwrap_or("character"),
            p.summary.as_deref().unwrap_or(""),
            &p.aliases.unwrap_or_default(),
        )
    })?;
    codex::reindex_mentions(app, None)?;
    Ok(IdResult { id })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct EntityUpdateParams {
    pub id: i64,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub aliases: Option<Vec<String>>,
}

pub fn update(app: &App, p: EntityUpdateParams) -> Result<()> {
    let patch = EntityPatch {
        name: p.name,
        kind: p.kind,
        summary: p.summary,
        body: p.body,
        aliases: p.aliases,
    };
    app.db.with(|c| codex::update_entity(c, p.id, &patch))?;
    // Renames and alias edits change what the mention automaton matches.
    if patch.renames() {
        codex::reindex_mentions(app, None)?;
    }
    Ok(())
}

pub fn delete(app: &App, p: IdParams) -> Result<()> {
    app.db.tx(|tx| codex::delete_entity(tx, p.id))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AddAliasParams {
    pub id: i64,
    pub alias: String,
}

pub fn add_alias(app: &App, p: AddAliasParams) -> Result<()> {
    app.db.with(|c| codex::add_alias(c, p.id, &p.alias))?;
    codex::reindex_mentions(app, None)?;
    Ok(())
}

#[derive(Serialize, TS)]
pub struct MentionList {
    pub mentions: Vec<Mention>,
}

pub fn mentions(app: &App, p: IdParams) -> Result<MentionList> {
    Ok(MentionList {
        mentions: app.db.with(|c| codex::entity_mentions(c, p.id))?,
    })
}

#[derive(Serialize, TS)]
pub struct CandidateList {
    pub candidates: Vec<CandidateRow>,
}

pub fn candidates(app: &App, _: NoParams) -> Result<CandidateList> {
    Ok(CandidateList {
        candidates: app.db.with(codex::list_candidates)?,
    })
}

pub fn dismiss(app: &App, p: NameParams) -> Result<()> {
    let name = required("name", &p.name)?;
    app.db.tx(|tx| codex::dismiss_candidate(tx, name))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct PromoteParams {
    pub name: String,
    /// For a new entity; default "character".
    pub kind: Option<String>,
    pub summary: Option<String>,
    /// Add the name as an alias of this entity instead.
    pub as_alias_of: Option<i64>,
}

pub fn promote(app: &App, p: PromoteParams) -> Result<Promoted> {
    let name = required("name", &p.name)?;
    let result = app.db.tx(|tx| {
        codex::promote_candidate(
            tx,
            name,
            p.kind.as_deref().unwrap_or("character"),
            p.summary.as_deref().unwrap_or(""),
            p.as_alias_of,
        )
    })?;
    codex::reindex_mentions(app, None)?;
    Ok(result)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(optional_fields)]
pub struct CodexSuggestParams {
    pub name: String,
    /// Where the selection was made.
    pub file: Option<String>,
    pub context: Option<String>,
    /// 1-based.
    pub line: Option<usize>,
}

#[derive(Serialize, TS)]
pub struct CodexSuggestResult {
    /// False when the name was already known, dismissed, or queued.
    pub added: bool,
}

/// Manual "promote to codex" from an editor selection: lands in the inbox
/// as a manual-source candidate.
pub fn suggest(app: &App, p: CodexSuggestParams) -> Result<CodexSuggestResult> {
    let name = required("name", &p.name)?;
    let file = match p.file.as_deref().filter(|f| !f.is_empty()) {
        Some(f) => RelPath::parse(f)?.as_str().to_string(),
        None => String::new(),
    };
    let candidate = codex::Candidate {
        name: name.to_string(),
        kind_guess: String::new(),
        source: "manual".into(),
        summary: String::new(),
        context: p.context.unwrap_or_default().chars().take(160).collect(),
        line: p.line.unwrap_or(0),
    };
    let new = app
        .db
        .tx(|tx| codex::record_candidates(tx, &file, &[candidate]))?;
    Ok(CodexSuggestResult { added: new > 0 })
}

#[derive(Serialize, TS)]
pub struct ReindexResult {
    pub mentions: usize,
}

pub fn reindex(app: &App, _: NoParams) -> Result<ReindexResult> {
    Ok(ReindexResult {
        mentions: codex::reindex_mentions(app, None)?,
    })
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub new_candidates: usize,
    pub scanned: usize,
}

pub fn scan(app: &App, p: OptionalPathParams) -> Result<ScanResult> {
    if !app.ner.is_ready() {
        return Err(invalid(
            "NER model not downloaded yet — fetch it from the Codex panel first",
        ));
    }
    let files = p.files(app)?;
    let new = codex::discover_files(app, &files)?;
    Ok(ScanResult {
        new_candidates: new,
        scanned: files.len(),
    })
}

pub fn graph(app: &App, _: NoParams) -> Result<codex::Graph> {
    app.db.with(codex::graph)
}

#[derive(Serialize, TS)]
pub struct RebuildResult {
    pub mentions: usize,
    pub candidates: usize,
    pub files: usize,
}

/// Nuke every derived index (mentions, discovery candidates) and rebuild
/// from the files on disk. User data — entities, dismissals, dictionary,
/// suppressions, scene metadata — is untouched.
pub fn rebuild(app: &App, _: NoParams) -> Result<RebuildResult> {
    app.db.tx(|tx| {
        tx.execute("DELETE FROM candidates", [])?;
        Ok(())
    })?;
    let mentions = codex::reindex_mentions(app, None)?;
    let files = app.md_files();
    let candidates = codex::discover_files(app, &files)?;
    Ok(RebuildResult {
        mentions,
        candidates,
        files: files.len(),
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RelationAddParams {
    pub from: i64,
    pub to: i64,
    pub label: String,
}

pub fn relation_add(app: &App, p: RelationAddParams) -> Result<IdResult> {
    let id = app
        .db
        .with(|c| codex::relation_add(c, p.from, p.to, &p.label, "human"))?;
    Ok(IdResult { id })
}

pub fn relation_delete(app: &App, p: IdParams) -> Result<()> {
    app.db.with(|c| codex::relation_delete(c, p.id))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RenamePreviewParams {
    pub id: i64,
    /// The entry's current name, or one of its other names.
    pub from: String,
    pub to: String,
}

/// Where the old name is written, scene by scene, before renaming.
pub fn rename_preview(app: &App, p: RenamePreviewParams) -> Result<crate::rename::RenamePreview> {
    crate::rename::preview(app, p.id, &p.from, &p.to)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RenameApplyParams {
    pub id: i64,
    pub from: String,
    pub to: String,
    /// Occurrences to rewrite; omit or leave empty to rename in the codex only.
    pub chosen: Option<Vec<crate::rename::RenameChoice>>,
    /// Keep the old name as another name for the entry.
    pub keep_alias: Option<bool>,
    /// Also rewrite codex entries and scene synopses.
    pub update_notes: Option<bool>,
}

pub fn rename_apply(app: &App, p: RenameApplyParams) -> Result<crate::rename::RenameResult> {
    crate::rename::run(
        app,
        crate::rename::Rename {
            id: p.id,
            from: &p.from,
            to: &p.to,
            chosen: p.chosen.as_deref().unwrap_or_default(),
            keep_alias: p.keep_alias.unwrap_or(false),
            update_notes: p.update_notes.unwrap_or(false),
        },
    )
}
