//! Renaming a codex entry through the manuscript: find every place the old
//! name is written, preview it, and rewrite the chosen ones.
//!
//! Matching is whole-word and case-sensitive on the name, plus its ALL-CAPS
//! form ("MAREN" → "MARIN") and its plural ("the Marens'" → "the Marins'").
//! Possessives ("Maren's") need nothing special: the apostrophe already ends
//! the word. Never inside another word ("Marengo").

use crate::app::App;
use crate::codex;
use crate::fsx::{RelPath, is_research_path};
use crate::rpc::invalid;
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use ts_rs::TS;

/// One match of the old name: `text[start..end]` becomes `replacement`.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

fn alnum_at(text: &str, i: usize) -> bool {
    text[i..].chars().next().is_some_and(char::is_alphanumeric)
}

fn alnum_before(text: &str, i: usize) -> bool {
    text[..i].chars().next_back().is_some_and(char::is_alphanumeric)
}

/// Every whole-word occurrence of `from` in `text`, with what it becomes.
pub fn find(text: &str, from: &str, to: &str) -> Vec<Hit> {
    let mut variants = vec![(from.to_string(), to.to_string(), 's')];
    let upper = from.to_uppercase();
    if upper != from {
        variants.push((upper, to.to_uppercase(), 'S'));
    }
    let mut hits = Vec::new();
    for (f, t, plural) in &variants {
        for (start, _) in text.match_indices(f.as_str()) {
            if alnum_before(text, start) {
                continue;
            }
            let end = start + f.len();
            if !alnum_at(text, end) {
                hits.push(Hit { start, end, replacement: t.clone() });
            } else if text[end..].starts_with(*plural) && !alnum_at(text, end + 1) {
                // "the Marens" / "the Marens'" — the family, still the name.
                hits.push(Hit { start, end: end + 1, replacement: format!("{t}{plural}") });
            }
        }
    }
    hits.sort_by_key(|h| h.start);
    hits.dedup_by(|b, a| b.start < a.end);
    hits
}

/// Rewrite the hits whose start is in `only` (all of them when `None`).
pub fn apply(text: &str, hits: &[Hit], only: Option<&HashSet<usize>>) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut n = 0;
    for h in hits {
        if only.is_some_and(|s| !s.contains(&h.start)) {
            continue;
        }
        out.push_str(&text[at..h.start]);
        out.push_str(&h.replacement);
        at = h.end;
        n += 1;
    }
    out.push_str(&text[at..]);
    (out, n)
}

// ---------- Preview ----------

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenameOccurrence {
    /// Byte offset in the file; send it back to choose this occurrence.
    pub start: usize,
    /// 1-based.
    pub line: usize,
    /// 0-based, in UTF-16 units (editor columns).
    pub column: usize,
    /// The text as written ("Maren", "MAREN", "Marens").
    pub found: String,
    pub replacement: String,
    /// The rest of the line around it, trimmed to a readable snippet.
    pub before: String,
    pub after: String,
}

#[derive(Serialize, TS, Debug)]
pub struct RenameScene {
    pub path: String,
    pub occurrences: Vec<RenameOccurrence>,
}

/// Codex text or a scene synopsis that mentions the old name.
#[derive(Serialize, TS, Debug)]
pub struct RenameNote {
    /// entry | synopsis
    pub kind: String,
    /// The codex entry's name, or the scene's path.
    pub name: String,
    pub count: usize,
}

#[derive(Serialize, TS, Debug)]
pub struct RenamePreview {
    /// Scenes in reading order (front and back matter last).
    pub scenes: Vec<RenameScene>,
    pub total: usize,
    pub notes: Vec<RenameNote>,
}

const SNIPPET: usize = 60;

fn snippet_before(s: &str) -> String {
    let s = s.trim_start();
    let n = s.chars().count();
    if n <= SNIPPET {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - SNIPPET).collect();
    let tail = tail.split_once(' ').map_or(tail.as_str(), |(_, rest)| rest);
    format!("…{tail}")
}

fn snippet_after(s: &str) -> String {
    let s = s.trim_end();
    if s.chars().count() <= SNIPPET {
        return s.to_string();
    }
    let head: String = s.chars().take(SNIPPET).collect();
    let head = head.rsplit_once(' ').map_or(head.as_str(), |(keep, _)| keep);
    format!("{head}…")
}

fn occurrences(text: &str, hits: &[Hit]) -> Vec<RenameOccurrence> {
    let mut line_starts = vec![0];
    line_starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
    hits.iter()
        .map(|h| {
            let line_idx = line_starts.partition_point(|&s| s <= h.start) - 1;
            let ls = line_starts[line_idx];
            let le = text[ls..].find('\n').map_or(text.len(), |i| ls + i);
            let line_text = text[ls..le].trim_end_matches('\r');
            let end = h.end.min(ls + line_text.len());
            RenameOccurrence {
                start: h.start,
                line: line_idx + 1,
                column: text[ls..h.start].encode_utf16().count(),
                found: text[h.start..h.end].to_string(),
                replacement: h.replacement.clone(),
                before: snippet_before(&text[ls..h.start]),
                after: snippet_after(&text[end..ls + line_text.len()]),
            }
        })
        .collect()
}

/// Manuscript files a rename may touch: every scene in reading order, then
/// front and back matter. Research and app data are never included.
fn files(app: &App) -> Vec<String> {
    let mut order = crate::book::reading_order(app);
    let seen: HashSet<String> = order.iter().cloned().collect();
    order.extend(app.md_files().into_iter().filter(|f| !seen.contains(f)));
    order.retain(|f| !is_research_path(f));
    order
}

fn check_names(from: &str, to: &str) -> Result<()> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err(invalid("Both the old and the new name are needed"));
    }
    if from == to {
        return Err(invalid("The new name is the same as the old one"));
    }
    Ok(())
}

/// Codex entries (summary + notes) and scene synopses that mention `from`,
/// with their rewritten text.
fn note_rewrites(conn: &Connection, from: &str, to: &str) -> Result<Vec<(RenameNote, NoteEdit)>> {
    let mut out = Vec::new();
    for e in codex::list_entities(conn)? {
        let s = find(&e.summary, from, to);
        let b = find(&e.body, from, to);
        if s.len() + b.len() > 0 {
            out.push((
                RenameNote { kind: "entry".into(), name: e.name.clone(), count: s.len() + b.len() },
                NoteEdit::Entry { id: e.id, summary: apply(&e.summary, &s, None).0, body: apply(&e.body, &b, None).0 },
            ));
        }
    }
    for d in crate::story::all_details(conn)? {
        let hits = find(&d.synopsis, from, to);
        if !hits.is_empty() {
            out.push((
                RenameNote { kind: "synopsis".into(), name: d.file.clone(), count: hits.len() },
                NoteEdit::Synopsis { file: d.file, text: apply(&d.synopsis, &hits, None).0 },
            ));
        }
    }
    Ok(out)
}

enum NoteEdit {
    Entry { id: i64, summary: String, body: String },
    Synopsis { file: String, text: String },
}

/// The entry must exist and the new name mustn't belong to another entry.
fn check_entry(conn: &Connection, id: i64, to: &str) -> Result<codex::Entity> {
    let entries = codex::list_entities(conn)?;
    let to = to.trim();
    if let Some(other) = entries.iter().find(|e| e.id != id && e.name.to_lowercase() == to.to_lowercase()) {
        return Err(invalid(format!("Another codex entry is already called “{}”", other.name)));
    }
    entries
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| invalid(format!("No codex entry with id {id}")))
}

pub fn preview(app: &App, id: i64, from: &str, to: &str) -> Result<RenamePreview> {
    check_names(from, to)?;
    app.db.with(|c| check_entry(c, id, to))?;
    let mut scenes = Vec::new();
    let mut total = 0;
    for path in files(app) {
        let Ok(text) = std::fs::read_to_string(app.root.join(&path)) else { continue };
        let hits = find(&text, from, to);
        if hits.is_empty() {
            continue;
        }
        total += hits.len();
        scenes.push(RenameScene { path, occurrences: occurrences(&text, &hits) });
    }
    let notes = app
        .db
        .with(|c| note_rewrites(c, from, to))?
        .into_iter()
        .map(|(m, _)| m)
        .collect();
    Ok(RenamePreview { scenes, total, notes })
}

// ---------- Apply ----------

#[derive(Deserialize, TS, Debug)]
#[serde(deny_unknown_fields)]
pub struct RenameChoice {
    pub path: String,
    /// `start` offsets from the preview.
    pub starts: Vec<usize>,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub files_changed: usize,
    pub replaced: usize,
    pub notes_changed: usize,
}

pub struct Rename<'a> {
    pub id: i64,
    pub from: &'a str,
    pub to: &'a str,
    pub chosen: &'a [RenameChoice],
    pub keep_alias: bool,
    pub update_notes: bool,
}

/// Rename the entry (its name, or the alias `from`), then rewrite the chosen
/// occurrences on disk. Saved files flow into history like any other save.
pub fn run(app: &App, r: Rename) -> Result<RenameResult> {
    check_names(r.from, r.to)?;
    let to = r.to.trim();

    // Validate every path before touching anything.
    let allowed: HashSet<String> = files(app).into_iter().collect();
    let mut by_file: BTreeMap<String, HashSet<usize>> = BTreeMap::new();
    for c in r.chosen {
        let rel = RelPath::parse(&c.path)?;
        if !allowed.contains(rel.as_str()) {
            return Err(invalid(format!("“{}” isn't part of the manuscript", c.path)));
        }
        by_file.entry(rel.as_str().to_string()).or_default().extend(&c.starts);
    }

    let notes_changed = app.db.tx(|tx| {
        let e = check_entry(tx, r.id, to)?;
        let mut patch = codex::EntityPatch::default();
        let mut aliases = e.aliases.clone();
        if e.name == r.from {
            patch.name = Some(to.to_string());
        } else if let Some(a) = aliases.iter_mut().find(|a| a.as_str() == r.from) {
            *a = to.to_string();
        } else {
            return Err(invalid(format!("“{}” isn't a name of {}", r.from, e.name)));
        }
        if r.keep_alias && !aliases.iter().any(|a| a == r.from) {
            aliases.push(r.from.to_string());
        }
        if patch.name.is_some() {
            aliases.retain(|a| a != to); // the old alias is now the name
        }
        let mut unique = HashSet::new();
        aliases.retain(|a| unique.insert(a.clone()));
        patch.aliases = Some(aliases);
        codex::update_entity(tx, r.id, &patch)?;

        if !r.update_notes {
            return Ok(0);
        }
        let edits = note_rewrites(tx, r.from, to)?;
        for (_, edit) in &edits {
            match edit {
                NoteEdit::Entry { id, summary, body } => {
                    tx.execute(
                        "UPDATE entities SET summary = ?2, body = ?3, updated = ?4 WHERE id = ?1",
                        rusqlite::params![id, summary, body, crate::db::now()],
                    )?;
                }
                NoteEdit::Synopsis { file, text } => {
                    tx.execute(
                        "UPDATE scene_meta SET synopsis = ?2 WHERE file = ?1",
                        rusqlite::params![file, text],
                    )?;
                }
            }
        }
        Ok(edits.len())
    })?;

    let mut result = RenameResult { files_changed: 0, replaced: 0, notes_changed };
    for (path, starts) in &by_file {
        let rel = RelPath::parse(path)?;
        let Ok(text) = app.read(&rel) else { continue };
        let hits = find(&text, r.from, to);
        let (new_text, n) = apply(&text, &hits, Some(starts));
        if n > 0 {
            app.write(&rel, &new_text)?;
            result.files_changed += 1;
            result.replaced += n;
        }
    }
    codex::reindex_mentions(app, None)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rename(text: &str, from: &str, to: &str) -> String {
        apply(text, &find(text, from, to), None).0
    }

    #[test]
    fn whole_words_caps_possessives_plurals() {
        assert_eq!(
            rename("Maren's coat. MAREN! The Marens' house, Marengo, maren.", "Maren", "Marin"),
            "Marin's coat. MARIN! The Marins' house, Marengo, maren."
        );
        assert_eq!(rename("Maren’s, Marenx, xMaren", "Maren", "Marin"), "Marin’s, Marenx, xMaren");
        assert_eq!(rename("Lord Vesh and LORD VESH", "Lord Vesh", "Lady Vesh"), "Lady Vesh and LADY VESH");
        // An all-caps name has one form.
        assert_eq!(rename("NASA", "NASA", "ESA"), "ESA");
    }

    #[test]
    fn snippets_are_trimmed_to_the_line() {
        let text = "First line.\r\nA long run of words before the name so that it must be trimmed, then Maren arrived at last.\n";
        let o = occurrences(text, &find(text, "Maren", "Marin"));
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].line, 2);
        assert!(o[0].before.starts_with('…'));
        assert!(o[0].before.ends_with("then "));
        assert_eq!(o[0].after, " arrived at last.");
        assert_eq!(o[0].found, "Maren");
    }
}
