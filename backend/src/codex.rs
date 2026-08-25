use crate::db;
use aho_corasick::{AhoCorasick, MatchKind};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

// The codex: the project's world bible. Entities (characters, places, items,
// lore) live in the db; mentions are indexed with aho-corasick; discovery
// (NER + heuristics + LLM) feeds a candidates inbox the writer reviews.

pub const KINDS: [&str; 7] =
    ["character", "place", "item", "faction", "creature", "event", "lore"];

// ---------- Entities ----------

pub fn list_entities(root: &Path) -> Result<Value> {
    let conn = db::open(root)?;
    let mut stmt = conn.prepare(
        "SELECT e.id, e.name, e.kind, e.summary, e.body, e.aliases, e.updated,
                (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id) AS mention_count
         FROM entities e ORDER BY e.kind, e.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "summary": r.get::<_, String>(3)?,
                "body": r.get::<_, String>(4)?,
                "aliases": serde_json::from_str::<Value>(&r.get::<_, String>(5)?).unwrap_or(json!([])),
                "updated": r.get::<_, i64>(6)?,
                "mentionCount": r.get::<_, i64>(7)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "entities": rows }))
}

pub fn create_entity(
    root: &Path,
    name: &str,
    kind: &str,
    summary: &str,
    aliases: &[String],
) -> Result<i64> {
    if !KINDS.contains(&kind) {
        bail!("Unknown entity kind: {}", kind);
    }
    let conn = db::open(root)?;
    let now = db::now();
    conn.execute(
        "INSERT INTO entities (name, kind, summary, aliases, created, updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![name.trim(), kind, summary, serde_json::to_string(aliases)?, now],
    )
    .with_context(|| format!("creating entity '{}'", name))?;
    Ok(conn.last_insert_rowid())
}

pub fn update_entity(root: &Path, id: i64, fields: &Value) -> Result<()> {
    let conn = db::open(root)?;
    let now = db::now();
    if let Some(name) = fields["name"].as_str() {
        conn.execute("UPDATE entities SET name = ?1, updated = ?2 WHERE id = ?3", rusqlite::params![name.trim(), now, id])?;
    }
    if let Some(kind) = fields["kind"].as_str() {
        if !KINDS.contains(&kind) {
            bail!("Unknown entity kind: {}", kind);
        }
        conn.execute("UPDATE entities SET kind = ?1, updated = ?2 WHERE id = ?3", rusqlite::params![kind, now, id])?;
    }
    if let Some(summary) = fields["summary"].as_str() {
        conn.execute("UPDATE entities SET summary = ?1, updated = ?2 WHERE id = ?3", rusqlite::params![summary, now, id])?;
    }
    if let Some(body) = fields["body"].as_str() {
        conn.execute("UPDATE entities SET body = ?1, updated = ?2 WHERE id = ?3", rusqlite::params![body, now, id])?;
    }
    if let Some(aliases) = fields["aliases"].as_array() {
        let list: Vec<String> = aliases.iter().filter_map(|a| a.as_str().map(String::from)).collect();
        conn.execute("UPDATE entities SET aliases = ?1, updated = ?2 WHERE id = ?3", rusqlite::params![serde_json::to_string(&list)?, now, id])?;
    }
    Ok(())
}

pub fn delete_entity(root: &Path, id: i64) -> Result<()> {
    let conn = db::open(root)?;
    conn.execute("DELETE FROM mentions WHERE entity_id = ?1", [id])?;
    conn.execute("DELETE FROM entities WHERE id = ?1", [id])?;
    Ok(())
}

/// Append an alias to an existing entity (e.g. a nickname from the inbox).
pub fn add_alias(root: &Path, id: i64, alias: &str) -> Result<()> {
    let conn = db::open(root)?;
    let current: String = conn
        .query_row("SELECT aliases FROM entities WHERE id = ?1", [id], |r| r.get(0))
        .context("entity not found")?;
    let mut list: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
    let alias = alias.trim();
    if !list.iter().any(|a| a.eq_ignore_ascii_case(alias)) {
        list.push(alias.to_string());
    }
    conn.execute(
        "UPDATE entities SET aliases = ?1, updated = ?2 WHERE id = ?3",
        rusqlite::params![serde_json::to_string(&list)?, db::now(), id],
    )?;
    Ok(())
}

/// All searchable names: (pattern, entity_id), longest patterns first.
fn all_names(conn: &rusqlite::Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT id, name, aliases FROM entities")?;
    let mut names = Vec::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    for row in rows {
        let (id, name, aliases) = row?;
        if !name.trim().is_empty() {
            names.push((name, id));
        }
        let aliases: Vec<String> = serde_json::from_str(&aliases).unwrap_or_default();
        for a in aliases {
            if !a.trim().is_empty() {
                names.push((a, id));
            }
        }
    }
    Ok(names)
}

fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let before_ok = start == 0
        || !text[..start].chars().next_back().map(|c| c.is_alphanumeric()).unwrap_or(false);
    let after_ok = end >= text.len()
        || !text[end..].chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false);
    before_ok && after_ok
}

// ---------- Mentions ----------

/// Rebuild the mentions index for the given files (or every .md when None).
pub fn reindex_mentions(root: &Path, files: Option<&[String]>) -> Result<usize> {
    let conn = db::open(root)?;
    let names = all_names(&conn)?;
    if names.is_empty() {
        if files.is_none() {
            conn.execute("DELETE FROM mentions", [])?;
        }
        return Ok(0);
    }

    let patterns: Vec<&str> = names.iter().map(|(n, _)| n.as_str()).collect();
    let ac = AhoCorasick::builder()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::LeftmostLongest)
        .build(&patterns)
        .context("building mention automaton")?;

    let file_list: Vec<String> = match files {
        Some(f) => f.to_vec(),
        None => crate::list_md_files(root),
    };

    let mut total = 0;
    for rel in &file_list {
        let Ok(path) = crate::resolve_path(root, rel) else { continue };
        let Ok(content) = std::fs::read_to_string(&path) else {
            // Deleted file: clear its mentions
            conn.execute("DELETE FROM mentions WHERE file = ?1", [rel])?;
            continue;
        };
        conn.execute("DELETE FROM mentions WHERE file = ?1", [rel])?;
        let mut seen: BTreeSet<(i64, usize)> = BTreeSet::new();
        for (line_no, line) in content.lines().enumerate() {
            for m in ac.find_iter(line) {
                if !is_word_boundary(line, m.start(), m.end()) {
                    continue;
                }
                let entity_id = names[m.pattern().as_usize()].1;
                seen.insert((entity_id, line_no + 1));
            }
        }
        for (entity_id, line) in seen {
            conn.execute(
                "INSERT OR IGNORE INTO mentions (entity_id, file, line) VALUES (?1, ?2, ?3)",
                rusqlite::params![entity_id, rel, line as i64],
            )?;
            total += 1;
        }
    }
    Ok(total)
}

pub fn entity_mentions(root: &Path, entity_id: i64) -> Result<Value> {
    let conn = db::open(root)?;
    let mut stmt =
        conn.prepare("SELECT file, line FROM mentions WHERE entity_id = ?1 ORDER BY file, line")?;
    let rows = stmt
        .query_map([entity_id], |r| {
            Ok(json!({ "file": r.get::<_, String>(0)?, "line": r.get::<_, i64>(1)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({ "mentions": rows }))
}

// ---------- Candidates (discovery inbox) ----------

pub struct Candidate {
    pub name: String,
    pub kind_guess: String,
    pub source: String,
    pub summary: String,
    pub context: String,
    /// 1-based line of the context within `file` (0 = unknown).
    pub line: usize,
}

/// Normalize a discovered span: strip edge punctuation/quotes and dangling
/// connector words ("Siege of" -> "Siege").
pub fn clean_candidate_name(raw: &str) -> String {
    let mut name = raw
        .trim()
        .trim_matches(|ch: char| ",.;:!?\"'\u{201c}\u{201d}\u{2018}\u{2019}()\u{2014}\u{2013}*_`".contains(ch))
        .trim();
    loop {
        let lower = name.to_lowercase();
        let trimmed = ["of", "the", "and", "a", "an"].iter().find_map(|w| {
            lower
                .strip_suffix(&format!(" {}", w))
                .map(|rest| name[..rest.len()].trim_end())
        });
        match trimmed {
            Some(t) if t != name => name = t,
            _ => break,
        }
    }
    name.to_string()
}

/// Merge freshly discovered candidates for one file into the inbox.
/// Returns the number of *new* names (used to gate the auto LLM scan).
pub fn record_candidates(root: &Path, file: &str, found: &[Candidate]) -> Result<usize> {
    let conn = db::open(root)?;
    let names = all_names(&conn)?;
    let known: BTreeSet<String> = names.iter().map(|(n, _)| n.to_lowercase()).collect();
    let mut new_names = 0;

    for c in found {
        let name = clean_candidate_name(&c.name);
        let name = name.as_str();
        if name.len() < 2 || known.contains(&name.to_lowercase()) {
            continue;
        }
        let dismissed: bool = conn
            .query_row("SELECT 1 FROM dismissed WHERE name = ?1 COLLATE NOCASE", [name], |_| Ok(true))
            .unwrap_or(false);
        if dismissed {
            continue;
        }

        let existing: Option<(i64, String, String, String, String)> = conn
            .query_row(
                "SELECT count, files, contexts, kind_guess, summary FROM candidates WHERE name = ?1 COLLATE NOCASE",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok();

        match existing {
            Some((count, files, contexts, kind_guess, summary)) => {
                let mut files: Vec<String> = serde_json::from_str(&files).unwrap_or_default();
                // Count new files, not re-observations — rescans must not inflate
                let count = if files.contains(&file.to_string()) { count } else { count + 1 };
                if !files.contains(&file.to_string()) {
                    files.push(file.to_string());
                }
                let mut contexts: Vec<Value> = serde_json::from_str(&contexts).unwrap_or_default();
                let dup = contexts.iter().any(|v| v["text"] == c.context.as_str() || *v == Value::String(c.context.clone()));
                if contexts.len() < 3 && !c.context.is_empty() && !dup {
                    contexts.push(json!({ "file": file, "line": c.line, "text": c.context }));
                }
                // LLM-sourced fields outrank NER guesses
                let kind = if (c.source == "llm" && !c.kind_guess.is_empty()) || kind_guess.is_empty() { c.kind_guess.clone() } else { kind_guess };
                let summary = if !c.summary.is_empty() { c.summary.clone() } else { summary };
                conn.execute(
                    "UPDATE candidates SET count = ?1, files = ?2, contexts = ?3, kind_guess = ?4, source = ?5, summary = ?6, updated = ?7 WHERE name = ?8 COLLATE NOCASE",
                    rusqlite::params![
                        count,
                        serde_json::to_string(&files)?,
                        serde_json::to_string(&contexts)?,
                        kind,
                        c.source,
                        summary,
                        db::now(),
                        name
                    ],
                )?;
            }
            None => {
                new_names += 1;
                conn.execute(
                    "INSERT INTO candidates (name, kind_guess, count, files, contexts, source, summary, updated)
                     VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        name,
                        c.kind_guess,
                        serde_json::to_string(&[file])?,
                        serde_json::to_string(&[json!({ "file": file, "line": c.line, "text": c.context })])?,
                        c.source,
                        c.summary,
                        db::now()
                    ],
                )?;
            }
        }
    }
    Ok(new_names)
}

/// Is `short` a whole-word substring of `long`? ("Gate" in "Iron Gate")
fn is_word_subset(short: &str, long: &str) -> bool {
    if short.len() >= long.len() {
        return false;
    }
    let (short, long) = (short.to_lowercase(), long.to_lowercase());
    let mut from = 0;
    while let Some(pos) = long[from..].find(&short) {
        let start = from + pos;
        let end = start + short.len();
        if is_word_boundary(&long, start, end) {
            return true;
        }
        from = start + 1;
    }
    false
}

pub fn list_candidates(root: &Path) -> Result<Value> {
    let conn = db::open(root)?;
    let mut stmt = conn.prepare(
        "SELECT name, kind_guess, count, files, contexts, source, summary FROM candidates
         ORDER BY count DESC, name COLLATE NOCASE LIMIT 100",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "kindGuess": r.get::<_, String>(1)?,
                "count": r.get::<_, i64>(2)?,
                "files": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(json!([])),
                "contexts": serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap_or(json!([])),
                "source": r.get::<_, String>(5)?,
                "summary": r.get::<_, String>(6)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Suppress fragments: a candidate that is a whole-word subset of another
    // with an equal-or-higher count is tagging noise ("Gate" under "Iron
    // Gate"). A short form that OUTCOUNTS its superset ("Veyra" over "Veyra
    // Ashcombe") is a genuinely used name and stays.
    let counts: Vec<(String, i64)> = rows
        .iter()
        .filter_map(|r| Some((r["name"].as_str()?.to_string(), r["count"].as_i64()?)))
        .collect();
    let rows: Vec<Value> = rows
        .into_iter()
        .filter(|r| {
            let (name, count) = (r["name"].as_str().unwrap_or(""), r["count"].as_i64().unwrap_or(0));
            !counts
                .iter()
                .any(|(other, oc)| *oc >= count && is_word_subset(name, other))
        })
        .collect();
    Ok(json!({ "candidates": rows }))
}

pub fn dismiss_candidate(root: &Path, name: &str) -> Result<()> {
    let conn = db::open(root)?;
    conn.execute("INSERT OR IGNORE INTO dismissed (name) VALUES (?1)", [name])?;
    conn.execute("DELETE FROM candidates WHERE name = ?1 COLLATE NOCASE", [name])?;
    Ok(())
}

/// Promote a candidate: either a new entity, or an alias on an existing one.
pub fn promote_candidate(
    root: &Path,
    name: &str,
    kind: &str,
    summary: &str,
    as_alias_of: Option<i64>,
) -> Result<Value> {
    let result = match as_alias_of {
        Some(entity_id) => {
            add_alias(root, entity_id, name)?;
            json!({ "aliasedTo": entity_id })
        }
        None => {
            let id = create_entity(root, name, kind, summary, &[])?;
            json!({ "created": id })
        }
    };
    let conn = db::open(root)?;
    conn.execute("DELETE FROM candidates WHERE name = ?1 COLLATE NOCASE", [name])?;
    Ok(result)
}
