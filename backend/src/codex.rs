//! The codex: the project's world bible. Entities (characters, places, items,
//! lore) live in the db; mentions are indexed with aho-corasick; discovery
//! (NER + heuristics + LLM) feeds a candidates inbox the writer reviews.

use crate::app::App;
use crate::db;
use crate::fsx::{Matcher, is_matter_path};
use crate::rpc::invalid;
use aho_corasick::{AhoCorasick, MatchKind};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use ts_rs::TS;

pub const KINDS: [&str; 7] = [
    "character",
    "place",
    "item",
    "faction",
    "creature",
    "event",
    "lore",
];

// ---------- Entities ----------

#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: i64,
    pub name: String,
    /// character | place | item | faction | creature | event | lore
    pub kind: String,
    pub summary: String,
    pub body: String,
    pub aliases: Vec<String>,
    /// Unix seconds.
    pub updated: i64,
    pub mention_count: i64,
}

impl Entity {
    /// Name plus aliases.
    pub fn names(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.name.as_str()).chain(self.aliases.iter().map(String::as_str))
    }

    pub fn answers_to(&self, name: &str) -> bool {
        let q = name.trim().to_lowercase();
        self.names().any(|n| n.to_lowercase() == q)
    }
}

fn check_kind(kind: &str) -> Result<()> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(invalid(format!("Unknown entity kind: {kind}")))
    }
}

fn parse_aliases(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

pub fn list_entities(conn: &Connection) -> Result<Vec<Entity>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.name, e.kind, e.summary, e.body, e.aliases, e.updated,
                (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id)
         FROM entities e ORDER BY e.kind, e.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Entity {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                summary: r.get(3)?,
                body: r.get(4)?,
                aliases: parse_aliases(&r.get::<_, String>(5)?),
                updated: r.get(6)?,
                mention_count: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_entity(conn: &Connection, id: i64) -> Result<Entity> {
    list_entities(conn)?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| invalid(format!("No codex entry with id {id}")))
}

pub fn create_entity(
    conn: &Connection,
    name: &str,
    kind: &str,
    summary: &str,
    aliases: &[String],
) -> Result<i64> {
    check_kind(kind)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("An entity needs a name"));
    }
    conn.execute(
        "INSERT INTO entities (name, kind, summary, aliases, created, updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![
            name,
            kind,
            summary,
            serde_json::to_string(aliases)?,
            db::now()
        ],
    )
    .with_context(|| format!("creating entity '{name}'"))?;
    Ok(conn.last_insert_rowid())
}

/// Fields to change on an entity; `None` leaves a field alone.
#[derive(Default)]
pub struct EntityPatch {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub summary: Option<String>,
    pub body: Option<String>,
    pub aliases: Option<Vec<String>>,
}

impl EntityPatch {
    /// Does this change what the mention index matches?
    pub fn renames(&self) -> bool {
        self.name.is_some() || self.aliases.is_some()
    }
}

pub fn update_entity(conn: &Connection, id: i64, patch: &EntityPatch) -> Result<()> {
    if let Some(kind) = &patch.kind {
        check_kind(kind)?;
    }
    let exists: bool = conn
        .query_row("SELECT 1 FROM entities WHERE id = ?1", [id], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if !exists {
        return Err(invalid(format!("No codex entry with id {id}")));
    }
    let aliases = patch
        .aliases
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    conn.execute(
        "UPDATE entities SET
             name    = COALESCE(?2, name),
             kind    = COALESCE(?3, kind),
             summary = COALESCE(?4, summary),
             body    = COALESCE(?5, body),
             aliases = COALESCE(?6, aliases),
             updated = ?7
         WHERE id = ?1",
        rusqlite::params![
            id,
            patch.name.as_deref().map(str::trim),
            patch.kind,
            patch.summary,
            patch.body,
            aliases,
            db::now()
        ],
    )?;
    Ok(())
}

pub fn delete_entity(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM mentions WHERE entity_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM relations WHERE from_id = ?1 OR to_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM entities WHERE id = ?1", [id])?;
    Ok(())
}

/// Append an alias to an existing entity (e.g. a nickname from the inbox).
pub fn add_alias(conn: &Connection, id: i64, alias: &str) -> Result<()> {
    let current: String = conn
        .query_row("SELECT aliases FROM entities WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| invalid(format!("No codex entry with id {id}")))?;
    let mut list = parse_aliases(&current);
    let alias = alias.trim();
    if alias.is_empty() {
        return Err(invalid("Alias is empty"));
    }
    if !list
        .iter()
        .any(|a| a.to_lowercase() == alias.to_lowercase())
    {
        list.push(alias.to_string());
    }
    conn.execute(
        "UPDATE entities SET aliases = ?1, updated = ?2 WHERE id = ?3",
        rusqlite::params![serde_json::to_string(&list)?, db::now(), id],
    )?;
    Ok(())
}

/// All searchable names: (pattern, entity_id).
fn all_names(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT id, name, aliases FROM entities")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut names = Vec::new();
    for row in rows {
        let (id, name, aliases) = row?;
        for n in std::iter::once(name).chain(parse_aliases(&aliases)) {
            if !n.trim().is_empty() {
                names.push((n, id));
            }
        }
    }
    Ok(names)
}

fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let before_ok = !text[..start]
        .chars()
        .next_back()
        .is_some_and(char::is_alphanumeric);
    let after_ok = !text[end..]
        .chars()
        .next()
        .is_some_and(char::is_alphanumeric);
    before_ok && after_ok
}

// ---------- Mentions ----------

#[derive(Serialize, TS, Clone, Debug)]
pub struct Mention {
    pub file: String,
    /// 1-based.
    pub line: i64,
}

/// Rebuild the mentions index for the given files (or every .md when
/// `None`). Files are read without holding the database; the rows for the
/// whole batch are replaced in one transaction.
pub fn reindex_mentions(app: &App, files: Option<&[String]>) -> Result<usize> {
    let names = app.db.with(all_names)?;
    let file_list: Vec<String> = match files {
        Some(f) => f.to_vec(),
        None => app.md_files(),
    };

    let mut found: Vec<(String, BTreeSet<(i64, usize)>)> = Vec::new();
    if !names.is_empty() {
        let patterns: Vec<&str> = names.iter().map(|(n, _)| n.as_str()).collect();
        let ac = AhoCorasick::builder()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::LeftmostLongest)
            .build(&patterns)
            .context("building mention automaton")?;
        for rel in &file_list {
            let Ok(content) = std::fs::read_to_string(app.root.join(rel)) else {
                continue;
            };
            let mut seen = BTreeSet::new();
            for (line_no, line) in content.lines().enumerate() {
                for m in ac.find_iter(line) {
                    if is_word_boundary(line, m.start(), m.end()) {
                        seen.insert((names[m.pattern().as_usize()].1, line_no + 1));
                    }
                }
            }
            found.push((rel.clone(), seen));
        }
    }

    app.db.tx(|tx| {
        match files {
            None => {
                tx.execute("DELETE FROM mentions", [])?;
            }
            Some(files) => {
                let mut del = tx.prepare("DELETE FROM mentions WHERE file = ?1")?;
                for f in files {
                    del.execute([f])?;
                }
            }
        }
        let mut ins = tx.prepare(
            "INSERT OR IGNORE INTO mentions (entity_id, file, line)
             SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM entities WHERE id = ?1)",
        )?;
        let mut total = 0;
        for (rel, seen) in &found {
            for (entity_id, line) in seen {
                total += ins.execute(rusqlite::params![entity_id, rel, *line as i64])?;
            }
        }
        Ok(total)
    })
}

pub fn entity_mentions(conn: &Connection, entity_id: i64) -> Result<Vec<Mention>> {
    let mut stmt =
        conn.prepare("SELECT file, line FROM mentions WHERE entity_id = ?1 ORDER BY file, line")?;
    let rows = stmt
        .query_map([entity_id], |r| {
            Ok(Mention {
                file: r.get(0)?,
                line: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ---------- Candidates (discovery inbox) ----------

/// A freshly discovered name, before it is merged into the inbox.
pub struct Candidate {
    pub name: String,
    pub kind_guess: String,
    /// ner | llm | manual | hygiene
    pub source: String,
    pub summary: String,
    pub context: String,
    /// 1-based line of the context within its file (0 = unknown).
    pub line: usize,
}

/// Where a candidate was seen.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
pub struct CandidateContext {
    pub file: String,
    pub line: i64,
    pub text: String,
}

/// Parse stored contexts, skipping legacy text-only entries.
pub fn parse_contexts(json: &str) -> Vec<CandidateContext> {
    serde_json::from_str::<Vec<Value>>(json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect()
}

#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    pub name: String,
    pub kind_guess: String,
    /// Number of files the name was seen in.
    pub count: i64,
    pub files: Vec<String>,
    pub contexts: Vec<CandidateContext>,
    pub source: String,
    pub summary: String,
}

const CONNECTORS: [&str; 5] = ["of", "the", "and", "a", "an"];

/// Normalize a discovered span: strip edge punctuation/quotes and dangling
/// connector words ("Siege of" -> "Siege").
pub fn clean_candidate_name(raw: &str) -> String {
    let mut name = raw
        .trim()
        .trim_matches(|ch: char| {
            ",.;:!?\"'\u{201c}\u{201d}\u{2018}\u{2019}()\u{2014}\u{2013}*_`".contains(ch)
        })
        .trim();
    'strip: loop {
        for w in CONNECTORS {
            // Connector words are ASCII, so their byte length is exact and
            // the cut point is a char boundary whenever the bytes match.
            let cut = w.len() + 1;
            if name.len() > cut && name.is_char_boundary(name.len() - cut) {
                let (head, tail) = name.split_at(name.len() - cut);
                if tail.starts_with(' ') && tail[1..].eq_ignore_ascii_case(w) {
                    name = head.trim_end();
                    continue 'strip;
                }
            }
        }
        break;
    }
    name.to_string()
}

/// Merge freshly discovered candidates for one file into the inbox.
/// Returns the number of *new* names.
pub fn record_candidates(conn: &Connection, file: &str, found: &[Candidate]) -> Result<usize> {
    let known: BTreeSet<String> = all_names(conn)?
        .iter()
        .map(|(n, _)| n.to_lowercase())
        .collect();
    let mut new_names = 0;

    for c in found {
        let name = clean_candidate_name(&c.name);
        if name.chars().count() < 2 || known.contains(&name.to_lowercase()) {
            continue;
        }
        let dismissed = conn
            .query_row(
                "SELECT 1 FROM dismissed WHERE name = ?1 COLLATE NOCASE",
                [&name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if dismissed {
            continue;
        }

        let existing: Option<(String, String, String, String)> = conn
            .query_row(
                "SELECT files, contexts, kind_guess, summary FROM candidates WHERE name = ?1 COLLATE NOCASE",
                [&name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let context = CandidateContext {
            file: file.to_string(),
            line: c.line as i64,
            text: c.context.clone(),
        };

        match existing {
            Some((files, contexts, kind_guess, summary)) => {
                let mut files: Vec<String> = serde_json::from_str(&files).unwrap_or_default();
                if !files.iter().any(|f| f == file) {
                    files.push(file.to_string());
                }
                let mut contexts = parse_contexts(&contexts);
                let dup = contexts.iter().any(|v| v.text == c.context);
                if contexts.len() < 3 && !c.context.is_empty() && !dup {
                    contexts.push(context);
                }
                // LLM-sourced fields outrank NER guesses
                let kind =
                    if (c.source == "llm" && !c.kind_guess.is_empty()) || kind_guess.is_empty() {
                        c.kind_guess.clone()
                    } else {
                        kind_guess
                    };
                let summary = if c.summary.is_empty() {
                    summary
                } else {
                    c.summary.clone()
                };
                conn.execute(
                    "UPDATE candidates SET count = ?1, files = ?2, contexts = ?3, kind_guess = ?4,
                     source = ?5, summary = ?6, updated = ?7 WHERE name = ?8 COLLATE NOCASE",
                    rusqlite::params![
                        files.len() as i64,
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
                let contexts = if c.context.is_empty() {
                    vec![]
                } else {
                    vec![context]
                };
                conn.execute(
                    "INSERT INTO candidates (name, kind_guess, count, files, contexts, source, summary, updated)
                     VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        name,
                        c.kind_guess,
                        serde_json::to_string(&[file])?,
                        serde_json::to_string(&contexts)?,
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

/// Is `short` a whole-word, case-insensitive substring of `long`?
/// ("Gate" in "Iron Gate")
fn is_word_subset(short: &str, long: &str) -> bool {
    if short.chars().count() >= long.chars().count() {
        return false;
    }
    let Ok(m) = Matcher::new(short, false) else {
        return false;
    };
    m.find_all(long)
        .into_iter()
        .any(|r| is_word_boundary(long, r.start, r.end))
}

pub fn list_candidates(conn: &Connection) -> Result<Vec<CandidateRow>> {
    let mut stmt = conn.prepare(
        "SELECT name, kind_guess, count, files, contexts, source, summary FROM candidates
         ORDER BY count DESC, name COLLATE NOCASE LIMIT 100",
    )?;
    let rows: Vec<CandidateRow> = stmt
        .query_map([], |r| {
            Ok(CandidateRow {
                name: r.get(0)?,
                kind_guess: r.get(1)?,
                count: r.get(2)?,
                files: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                contexts: parse_contexts(&r.get::<_, String>(4)?),
                source: r.get(5)?,
                summary: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    // Suppress fragments: a candidate that is a whole-word subset of another
    // with an equal-or-higher count is tagging noise ("Gate" under "Iron
    // Gate"). A short form that OUTCOUNTS its superset ("Veyra" over "Veyra
    // Ashcombe") is a genuinely used name and stays.
    let counts: Vec<(String, i64)> = rows.iter().map(|r| (r.name.clone(), r.count)).collect();
    Ok(rows
        .into_iter()
        .filter(|r| {
            !counts
                .iter()
                .any(|(other, oc)| *oc >= r.count && is_word_subset(&r.name, other))
        })
        .collect())
}

pub fn dismiss_candidate(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO dismissed (name) VALUES (?1)", [name])?;
    conn.execute(
        "DELETE FROM candidates WHERE name = ?1 COLLATE NOCASE",
        [name],
    )?;
    Ok(())
}

/// The outcome of promoting a candidate.
#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Promoted {
    /// A new entity with this id.
    Created(i64),
    /// Added as an alias of this entity.
    AliasedTo(i64),
}

/// Promote a candidate: either a new entity, or an alias on an existing one.
pub fn promote_candidate(
    conn: &Connection,
    name: &str,
    kind: &str,
    summary: &str,
    as_alias_of: Option<i64>,
) -> Result<Promoted> {
    let result = match as_alias_of {
        Some(entity_id) => {
            add_alias(conn, entity_id, name)?;
            Promoted::AliasedTo(entity_id)
        }
        None => Promoted::Created(create_entity(conn, name, kind, summary, &[])?),
    };
    conn.execute(
        "DELETE FROM candidates WHERE name = ?1 COLLATE NOCASE",
        [name],
    )?;
    Ok(result)
}

/// Run NER discovery over files, feeding the candidates inbox. Returns the
/// number of newly seen names.
pub fn discover_files(app: &App, files: &[String]) -> Result<usize> {
    if !app.ner.is_ready() {
        return Ok(0);
    }
    let mut new_total = 0;
    for rel in files {
        if is_matter_path(rel) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(app.root.join(rel)) else {
            continue;
        };
        let spans = app.ner.extract(&content)?;
        let lines: Vec<&str> = content.lines().collect();
        let candidates: Vec<Candidate> = spans
            .into_iter()
            .map(|s| Candidate {
                context: lines
                    .get(s.line.saturating_sub(1))
                    .map(|l| l.trim().chars().take(160).collect())
                    .unwrap_or_default(),
                name: s.text,
                kind_guess: s.kind,
                source: "ner".into(),
                summary: String::new(),
                line: s.line,
            })
            .collect();
        new_total += app.db.tx(|tx| record_candidates(tx, rel, &candidates))?;
    }
    Ok(new_total)
}

// ---------- Relationship graph ----------

#[derive(Serialize, TS, Debug)]
pub struct GraphNode {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub mentions: i64,
}

/// Two entities appearing in the same scene(s).
#[derive(Serialize, TS, Debug)]
pub struct CoEdge {
    pub a: i64,
    pub b: i64,
    /// Number of scenes shared.
    pub weight: i64,
}

#[derive(Serialize, TS, Debug)]
pub struct Relation {
    pub id: i64,
    pub from: i64,
    pub to: i64,
    pub label: String,
    /// human | llm
    pub source: String,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub co_edges: Vec<CoEdge>,
    pub relations: Vec<Relation>,
}

/// Everything the graph view needs: nodes, scene co-occurrence edges
/// (computed live from the mention index), and stored relations.
pub fn graph(conn: &Connection) -> Result<Graph> {
    let nodes = conn
        .prepare(
            "SELECT e.id, e.name, e.kind,
                    (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id)
             FROM entities e",
        )?
        .query_map([], |r| {
            Ok(GraphNode {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                mentions: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let co_edges = conn
        .prepare(
            "SELECT a.entity_id, b.entity_id, COUNT(DISTINCT a.file)
             FROM mentions a
             JOIN mentions b ON a.file = b.file AND a.entity_id < b.entity_id
             GROUP BY a.entity_id, b.entity_id",
        )?
        .query_map([], |r| {
            Ok(CoEdge {
                a: r.get(0)?,
                b: r.get(1)?,
                weight: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let relations = conn
        .prepare(
            "SELECT r.id, r.from_id, r.to_id, r.label, r.source
             FROM relations r
             JOIN entities ef ON ef.id = r.from_id
             JOIN entities et ON et.id = r.to_id",
        )?
        .query_map([], |r| {
            Ok(Relation {
                id: r.get(0)?,
                from: r.get(1)?,
                to: r.get(2)?,
                label: r.get(3)?,
                source: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Graph {
        nodes,
        co_edges,
        relations,
    })
}

pub fn relation_add(
    conn: &Connection,
    from_id: i64,
    to_id: i64,
    label: &str,
    source: &str,
) -> Result<i64> {
    let label = label.trim();
    if label.is_empty() {
        return Err(invalid("A relation needs a label"));
    }
    for id in [from_id, to_id] {
        get_entity(conn, id)?;
    }
    conn.execute(
        "INSERT INTO relations (from_id, to_id, label, source, created) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![from_id, to_id, label, source, db::now()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn relation_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM relations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn relations_replace_llm(conn: &Connection, edges: &[(i64, i64, String)]) -> Result<usize> {
    conn.execute("DELETE FROM relations WHERE source = 'llm'", [])?;
    for (from, to, label) in edges {
        conn.execute(
            "INSERT INTO relations (from_id, to_id, label, source, created) VALUES (?1, ?2, ?3, 'llm', ?4)",
            rusqlite::params![from, to, label, db::now()],
        )?;
    }
    Ok(edges.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_names_with_multibyte_text() {
        assert_eq!(clean_candidate_name("Siege of"), "Siege");
        assert_eq!(
            clean_candidate_name("“The Iron Gate of the”"),
            "The Iron Gate"
        );
        // Lowercasing 'İ' changes byte length; the old code sliced mid-char.
        assert_eq!(clean_candidate_name("İstanbul of"), "İstanbul");
        assert_eq!(clean_candidate_name("ẞtraße and"), "ẞtraße");
        assert_eq!(clean_candidate_name("Éowyn"), "Éowyn");
        assert_eq!(clean_candidate_name("the"), "the");
    }

    #[test]
    fn word_subset_is_char_safe() {
        assert!(is_word_subset("Gate", "Iron Gate"));
        assert!(!is_word_subset("Gat", "Iron Gate"));
        assert!(is_word_subset("İstanbul", "Old İstanbul"));
        assert!(is_word_subset("ÉCOLE", "the école"));
        // Multibyte chars before the match used to panic on `from = start + 1`.
        assert!(!is_word_subset("ab", "ééab"));
        assert!(is_word_subset("ab", "éé ab"));
        assert!(is_word_subset("éa", "éab éa"));
    }

    #[test]
    fn candidates_merge_and_rekey() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let cand = |name: &str| Candidate {
            name: name.into(),
            kind_guess: "place".into(),
            source: "ner".into(),
            summary: String::new(),
            context: format!("near {name}"),
            line: 3,
        };
        db.tx(|tx| record_candidates(tx, "ch1.md", &[cand("Ühlenbrück"), cand("Siege of")]))
            .unwrap();
        db.tx(|tx| record_candidates(tx, "ch2.md", &[cand("Ühlenbrück")]))
            .unwrap();
        let rows = db.with(list_candidates).unwrap();
        let u = rows.iter().find(|r| r.name == "Ühlenbrück").unwrap();
        assert_eq!(u.files, vec!["ch1.md", "ch2.md"]);
        assert_eq!(u.count, 2);
        assert!(rows.iter().any(|r| r.name == "Siege"));
    }
}
