//! The story's structure beyond the text: scene details (point of view,
//! location, story time, word target), plot threads, what the reader knows
//! by a given scene, and the writer's margin notes as a to-do list.

use crate::agents::{Fact, entities_in, ledger_by_scene};
use crate::app::App;
use crate::codex;
use crate::fsx::RelPath;
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use ts_rs::TS;

// ---------- Scene details ----------

/// Everything about a scene that isn't its text.
#[derive(Serialize, TS, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SceneDetails {
    pub file: String,
    pub synopsis: String,
    /// idea | draft | revised | final | ""
    pub status: String,
    /// Codex entity whose point of view the scene is in.
    pub pov: Option<i64>,
    /// Codex entity (a place) where it happens.
    pub location: Option<i64>,
    /// When it happens in the story, in the writer's words ("Day 3, dusk").
    pub story_time: String,
    /// Word target (0 = none).
    pub target: u32,
    /// Plot thread ids.
    pub threads: Vec<i64>,
}

pub fn all_details(conn: &Connection) -> Result<Vec<SceneDetails>> {
    let mut threads: HashMap<String, Vec<i64>> = HashMap::new();
    for row in conn
        .prepare("SELECT file, thread_id FROM scene_threads ORDER BY thread_id")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
    {
        let (file, id) = row?;
        threads.entry(file).or_default().push(id);
    }
    let mut out: Vec<SceneDetails> = conn
        .prepare("SELECT file, synopsis, status, pov, location, story_time, target FROM scene_meta ORDER BY file")?
        .query_map([], |r| {
            Ok(SceneDetails {
                file: r.get(0)?,
                synopsis: r.get(1)?,
                status: r.get(2)?,
                pov: r.get(3)?,
                location: r.get(4)?,
                story_time: r.get(5)?,
                target: r.get::<_, i64>(6)?.max(0) as u32,
                threads: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let known: HashSet<String> = out.iter().map(|d| d.file.clone()).collect();
    for d in out.iter_mut() {
        d.threads = threads.remove(&d.file).unwrap_or_default();
    }
    // Threads set on scenes with no other details yet.
    for (file, ids) in threads {
        if !known.contains(&file) {
            out.push(SceneDetails { file, threads: ids, ..Default::default() });
        }
    }
    Ok(out)
}

/// Partial update of one scene's details. `pov`/`location` of 0 clear them.
#[allow(clippy::too_many_arguments)]
pub fn set_details(
    conn: &Connection,
    rel: &str,
    synopsis: Option<&str>,
    status: Option<&str>,
    pov: Option<i64>,
    location: Option<i64>,
    story_time: Option<&str>,
    target: Option<u32>,
    threads: Option<&[i64]>,
) -> Result<()> {
    let clear = |v: Option<i64>| v.map(|id| if id <= 0 { None } else { Some(id) });
    conn.execute(
        "INSERT INTO scene_meta (file) VALUES (?1) ON CONFLICT(file) DO NOTHING",
        [rel],
    )?;
    if let Some(s) = synopsis {
        conn.execute("UPDATE scene_meta SET synopsis = ?2 WHERE file = ?1", rusqlite::params![rel, s])?;
    }
    if let Some(s) = status {
        conn.execute("UPDATE scene_meta SET status = ?2 WHERE file = ?1", rusqlite::params![rel, s])?;
    }
    if let Some(p) = clear(pov) {
        conn.execute("UPDATE scene_meta SET pov = ?2 WHERE file = ?1", rusqlite::params![rel, p])?;
    }
    if let Some(l) = clear(location) {
        conn.execute("UPDATE scene_meta SET location = ?2 WHERE file = ?1", rusqlite::params![rel, l])?;
    }
    if let Some(t) = story_time {
        conn.execute("UPDATE scene_meta SET story_time = ?2 WHERE file = ?1", rusqlite::params![rel, t.trim()])?;
    }
    if let Some(t) = target {
        conn.execute("UPDATE scene_meta SET target = ?2 WHERE file = ?1", rusqlite::params![rel, t])?;
    }
    if let Some(ids) = threads {
        conn.execute("DELETE FROM scene_threads WHERE file = ?1", [rel])?;
        for id in ids {
            conn.execute(
                "INSERT OR IGNORE INTO scene_threads (file, thread_id) SELECT ?1, id FROM threads WHERE id = ?2",
                rusqlite::params![rel, id],
            )?;
        }
    }
    Ok(())
}

/// Scene details in words, per scene ("point of view: Maren; at the
/// Harbour; Day 3, dusk; threads: The Letter"), for agent prompts.
pub fn detail_labels(app: &App) -> HashMap<String, String> {
    let Ok((details, entities, threads)) = app.db.with(|c| Ok((all_details(c)?, codex::list_entities(c)?, threads(c)?))) else {
        return HashMap::new();
    };
    let name = |id: Option<i64>| id.and_then(|id| entities.iter().find(|e| e.id == id)).map(|e| e.name.clone());
    details
        .into_iter()
        .filter_map(|d| {
            let mut parts = Vec::new();
            if let Some(p) = name(d.pov) {
                parts.push(format!("point of view: {p}"));
            }
            if let Some(l) = name(d.location) {
                parts.push(format!("at {l}"));
            }
            if !d.story_time.trim().is_empty() {
                parts.push(format!("story time: {}", d.story_time.trim()));
            }
            let names: Vec<&str> = d.threads.iter().filter_map(|t| threads.iter().find(|x| x.id == *t)).map(|t| t.name.as_str()).collect();
            if !names.is_empty() {
                parts.push(format!("threads: {}", names.join(", ")));
            }
            (!parts.is_empty()).then(|| (d.file, parts.join("; ")))
        })
        .collect()
}

// ---------- Plot threads ----------

#[derive(Serialize, TS, Clone, Debug)]
pub struct Thread {
    pub id: i64,
    pub name: String,
    /// A token name (e.g. "accent", "ai") or "" for the default.
    pub color: String,
    pub position: i64,
}

pub fn threads(conn: &Connection) -> Result<Vec<Thread>> {
    Ok(conn
        .prepare("SELECT id, name, color, position FROM threads ORDER BY position, id")?
        .query_map([], |r| Ok(Thread { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, position: r.get(3)? }))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn create_thread(conn: &Connection, name: &str, color: &str) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        bail!(crate::rpc::invalid("A thread needs a name"));
    }
    let next: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM threads", [], |r| r.get(0))?;
    conn.execute("INSERT INTO threads (name, color, position) VALUES (?1, ?2, ?3)", rusqlite::params![name, color, next])?;
    Ok(conn.last_insert_rowid())
}

pub fn update_thread(conn: &Connection, id: i64, name: Option<&str>, color: Option<&str>, position: Option<i64>) -> Result<()> {
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        conn.execute("UPDATE threads SET name = ?2 WHERE id = ?1", rusqlite::params![id, n])?;
    }
    if let Some(c) = color {
        conn.execute("UPDATE threads SET color = ?2 WHERE id = ?1", rusqlite::params![id, c])?;
    }
    if let Some(p) = position {
        conn.execute("UPDATE threads SET position = ?2 WHERE id = ?1", rusqlite::params![id, p])?;
    }
    Ok(())
}

pub fn delete_thread(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM scene_threads WHERE thread_id = ?1", [id])?;
    conn.execute("DELETE FROM threads WHERE id = ?1", [id])?;
    Ok(())
}

// ---------- What the reader knows ----------

/// One thing the reader has been told, and where.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnownFact {
    pub fact: String,
    /// The scene that established it.
    pub scene: String,
    /// "narrated" or "claimed" (a character's word, possibly false).
    pub basis: String,
}

#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnownEntity {
    pub id: i64,
    pub name: String,
    pub kind: String,
    /// Latest first.
    pub facts: Vec<KnownFact>,
}

#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReaderKnowledge {
    /// Codex entries the reader meets for the first time here.
    pub introduced: Vec<KnownEntity>,
    /// Entries in this scene the reader already knows, with what they know.
    pub known: Vec<KnownEntity>,
    /// Scenes before this one whose facts haven't been noted yet (so the
    /// picture may be incomplete).
    pub unread_scenes: usize,
}

const FACTS_PER_ENTITY: usize = 8;

/// What a reader has been told, by the start of `rel`, about the codex
/// entries that appear in it — straight from the fact ledger, no AI call.
pub fn reader_knowledge(app: &App, rel: &RelPath) -> Result<ReaderKnowledge> {
    let order = crate::book::reading_order(app);
    let idx = order.iter().position(|o| o == rel.as_str()).unwrap_or(order.len());
    let earlier: HashSet<&str> = order[..idx].iter().map(String::as_str).collect();
    let content = app.read(rel)?;
    let entities = app.db.with(codex::list_entities)?;
    let present = entities_in(&entities, &content);
    let (by_scene, mentions) = app.db.with(|c| {
        let mut mentioned: HashMap<i64, HashSet<String>> = HashMap::new();
        for row in c.prepare("SELECT entity_id, file FROM mentions")?.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, file) = row?;
            mentioned.entry(id).or_default().insert(file);
        }
        Ok((ledger_by_scene(c)?, mentioned))
    })?;

    let mut introduced = Vec::new();
    let mut known = Vec::new();
    for e in present {
        let seen_before = mentions.get(&e.id).is_some_and(|files| files.iter().any(|f| earlier.contains(f.as_str())));
        let names: Vec<String> = e.names().map(str::to_lowercase).collect();
        let about = |f: &Fact| {
            f.subjects.iter().any(|s| names.contains(&s.to_lowercase()))
                || names.iter().any(|n| f.fact.to_lowercase().contains(n.as_str()))
        };
        let mut facts = Vec::new();
        for scene in order[..idx].iter().rev() {
            for f in by_scene.get(scene).into_iter().flatten().rev().filter(|f| about(f)) {
                if facts.len() < FACTS_PER_ENTITY {
                    facts.push(KnownFact { fact: f.fact.clone(), scene: scene.clone(), basis: f.basis.clone() });
                }
            }
        }
        let entry = KnownEntity { id: e.id, name: e.name.clone(), kind: e.kind.clone(), facts };
        if seen_before { known.push(entry) } else { introduced.push(entry) }
    }
    let unread_scenes = order[..idx].iter().filter(|s| !by_scene.contains_key(*s)).count();
    Ok(ReaderKnowledge { introduced, known, unread_scenes })
}

// ---------- Margin notes ----------

#[derive(Serialize, TS, Clone, Debug)]
pub struct Note {
    pub file: String,
    /// 1-based line where the note starts.
    pub line: usize,
    /// The note, without the comment markers.
    pub text: String,
}

fn note_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"<!--([\s\S]*?)-->").expect("valid regex"))
}

pub fn notes_in(file: &str, content: &str) -> Vec<Note> {
    note_re()
        .captures_iter(content)
        .filter_map(|c| {
            let whole = c.get(0)?;
            let text = c.get(1)?.as_str().trim().to_string();
            (!text.is_empty()).then(|| Note {
                file: file.to_string(),
                line: content[..whole.start()].matches('\n').count() + 1,
                text,
            })
        })
        .collect()
}

/// Every margin note in the manuscript, in reading order.
pub fn all_notes(app: &App) -> Vec<Note> {
    crate::book::reading_order(app)
        .into_iter()
        .filter_map(|rel| {
            let content = std::fs::read_to_string(app.root.join(&rel)).ok()?;
            Some(notes_in(&rel, &content))
        })
        .flatten()
        .collect()
}

/// Remove one note (matched by its text, nearest to `line`) from a scene.
/// A line left empty by the removal goes too. Returns the new text.
pub fn resolve_note(content: &str, line: usize, text: &str) -> Option<String> {
    let target = note_re()
        .captures_iter(content)
        .filter(|c| c.get(1).is_some_and(|m| m.as_str().trim() == text.trim()))
        .filter_map(|c| c.get(0))
        .min_by_key(|m| (content[..m.start()].matches('\n').count() + 1).abs_diff(line))?;
    let (start, end) = (target.start(), target.end());
    let line_start = content[..start].rfind('\n').map_or(0, |i| i + 1);
    let line_end = content[end..].find('\n').map_or(content.len(), |i| end + i);
    let rest_of_line = format!("{}{}", &content[line_start..start], &content[end..line_end]);
    let mut out = String::with_capacity(content.len());
    if rest_of_line.trim().is_empty() {
        // Drop the whole line (and its newline).
        out.push_str(&content[..line_start]);
        let after = if line_end < content.len() { line_end + 1 } else { line_end };
        out.push_str(&content[after..]);
    } else {
        // Keep the prose around it, with exactly one space where one belongs.
        let before = content[..start].trim_end_matches(' ');
        let after = content[end..].trim_start_matches(' ');
        out.push_str(before);
        let joins_words = !before.is_empty()
            && !before.ends_with('\n')
            && !after.is_empty()
            && !after.starts_with(['\n', '.', ',', ';', ':', '!', '?', ')', '”', '’']);
        if joins_words {
            out.push(' ');
        }
        out.push_str(after);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_found_with_their_lines() {
        let text = "Line one.\nShe ran. <!-- slower here? -->\n<!--\nmulti\nline\n-->\nEnd.";
        let notes = notes_in("a.md", text);
        assert_eq!(notes.len(), 2);
        assert_eq!((notes[0].line, notes[0].text.as_str()), (2, "slower here?"));
        assert_eq!((notes[1].line, notes[1].text.as_str()), (3, "multi\nline"));
    }

    #[test]
    fn resolving_removes_the_note_and_tidies() {
        let text = "Line one.\nShe ran. <!-- slower here? -->\n<!-- own line -->\nEnd.";
        assert_eq!(resolve_note(text, 2, "slower here?").unwrap(), "Line one.\nShe ran.\n<!-- own line -->\nEnd.");
        assert_eq!(resolve_note(text, 3, "own line").unwrap(), "Line one.\nShe ran. <!-- slower here? -->\nEnd.");
        assert_eq!(resolve_note("A <!-- x --> B", 1, "x").unwrap(), "A B");
        assert!(resolve_note(text, 2, "not there").is_none());
    }
}
