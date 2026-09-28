//! The project database at `<project>/.chronicler/db`.
//!
//! One long-lived connection per backend process, guarded by a mutex. Callers
//! borrow it through [`Db::with`] / [`Db::tx`] closures, which are synchronous
//! by construction: a guard can never be held across an `.await`.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Transaction};
use std::path::Path;
use std::time::Duration;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if needed) the project database and bring its schema
    /// up to date.
    pub fn open(root: &Path) -> Result<Db> {
        let dir = root.join(".chronicler");
        std::fs::create_dir_all(&dir).context("creating .chronicler directory")?;
        let path = dir.join("db");
        let conn = Connection::open(&path).context("opening project db")?;
        match schema_version(&conn)? {
            Some(0) | Some(SCHEMA_VERSION) => Self::init(conn),
            other => {
                // Another schema: keep it aside and start fresh.
                drop(conn);
                let old = other.map_or("unversioned".to_string(), |v| format!("v{v}"));
                let aside = dir.join(format!("db.{old}.bak"));
                std::fs::rename(&path, &aside).context("setting the old project db aside")?;
                for ext in ["-wal", "-shm"] {
                    let side = dir.join(format!("db{ext}"));
                    if side.exists() {
                        let _ = std::fs::rename(&side, dir.join(format!("db.{old}.bak{ext}")));
                    }
                }
                tracing::warn!("project db was {old}; set aside at {} and rebuilt", aside.display());
                Self::init(Connection::open(&path).context("opening project db")?)
            }
        }
    }

    /// A throwaway database, for tests.
    pub fn open_in_memory() -> Result<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Db> {
        conn.busy_timeout(Duration::from_secs(10))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )
        .context("configuring project db")?;
        if schema_version(&conn)? == Some(0) {
            create_schema(&conn)?;
        }
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    /// Run `f` with the connection.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock();
        f(&conn)
    }

    /// Run `f` inside a transaction; commits on `Ok`, rolls back on `Err`.
    pub fn tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| get_setting(c, key))
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| set_setting(c, key, value))
    }
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .context("reading setting")
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .context("writing setting")?;
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The schema. There are no migrations: a database from another schema
/// version is set aside (renamed, not deleted) and a fresh one is built —
/// everything derived from the text rebuilds itself.
const SCHEMA_VERSION: i64 = 12;

const SCHEMA: &str = "
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE entities (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    kind    TEXT NOT NULL DEFAULT 'character',
    summary TEXT NOT NULL DEFAULT '',
    body    TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
);
CREATE TABLE mentions (
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    file      TEXT NOT NULL,
    line      INTEGER NOT NULL,
    PRIMARY KEY (entity_id, file, line)
);
CREATE INDEX mentions_file ON mentions(file);
CREATE TABLE candidates (
    name       TEXT PRIMARY KEY,
    kind_guess TEXT NOT NULL DEFAULT '',
    count      INTEGER NOT NULL DEFAULT 0,
    files      TEXT NOT NULL DEFAULT '[]',
    contexts   TEXT NOT NULL DEFAULT '[]',
    source     TEXT NOT NULL DEFAULT 'ner',
    summary    TEXT NOT NULL DEFAULT '',
    updated    INTEGER NOT NULL
);
CREATE TABLE dismissed (
    name TEXT PRIMARY KEY
);
CREATE TABLE dictionary (
    word TEXT PRIMARY KEY
);
CREATE TABLE suppressions (
    rule_id TEXT NOT NULL,
    file    TEXT NOT NULL,
    text    TEXT NOT NULL,
    PRIMARY KEY (rule_id, file, text)
);
CREATE TABLE writing_days (
    date   TEXT PRIMARY KEY,
    start  INTEGER NOT NULL,
    latest INTEGER NOT NULL
);
CREATE TABLE scene_meta (
    file       TEXT PRIMARY KEY,
    synopsis   TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT '',
    pov        INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    location   INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    story_time TEXT NOT NULL DEFAULT '',
    target     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE threads (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    color    TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE scene_threads (
    file      TEXT NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    PRIMARY KEY (file, thread_id)
);
CREATE TABLE embeddings (
    file       TEXT NOT NULL,
    chunk      INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line   INTEGER NOT NULL,
    text       TEXT NOT NULL,
    vector     BLOB NOT NULL,
    PRIMARY KEY (file, chunk)
);
CREATE TABLE assistant_findings (
    id      INTEGER PRIMARY KEY,
    file    TEXT NOT NULL,
    line    INTEGER NOT NULL,
    quote   TEXT NOT NULL,
    kind    TEXT NOT NULL,
    message TEXT NOT NULL,
    created INTEGER NOT NULL
);
CREATE INDEX findings_file ON assistant_findings(file);
CREATE TABLE scene_facts (
    file      TEXT PRIMARY KEY,
    hash      TEXT NOT NULL,
    facts     TEXT NOT NULL,
    extracted INTEGER NOT NULL
);
CREATE TABLE relations (
    id      INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    label   TEXT NOT NULL,
    source  TEXT NOT NULL DEFAULT 'human',
    created INTEGER NOT NULL
);
";

/// The schema version of a database: 0 for an empty one, `None` for one
/// with tables but no version stamp.
fn schema_version(conn: &Connection) -> Result<Option<i64>> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let tables: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'", [], |r| r.get(0))?;
    Ok(if version == 0 && tables > 0 { None } else { Some(version) })
}

fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!("BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"))
        .context("creating the project db schema")
}

// ---------- Path-keyed rows: rename / delete upkeep ----------
//
// Every table that stores a project-relative path. Paths are compared
// exactly (`=` is binary); folder moves cover children via a `prefix/`
// match computed with SQLite's character-based `length`/`substr`, so
// non-ASCII names are safe.

/// Tables whose `file` column is part of a uniqueness constraint; rows at the
/// destination are cleared first so a move can never collide.
const PATH_TABLES: [&str; 7] = [
    "scene_threads",
    "mentions",
    "suppressions",
    "scene_meta",
    "embeddings",
    "assistant_findings",
    "scene_facts",
];

fn under(file: &str, path: &str) -> bool {
    file == path
        || file
            .strip_prefix(path)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Re-key every row for `from` (a file, or a folder and everything under
/// it) to `to`.
pub fn move_path_rows(tx: &Transaction, from: &str, to: &str) -> Result<()> {
    if from == to {
        return Ok(());
    }
    let from_prefix = format!("{from}/");
    let to_prefix = format!("{to}/");
    for table in PATH_TABLES {
        tx.execute(
            &format!("DELETE FROM {table} WHERE file = ?1 OR substr(file, 1, length(?2)) = ?2"),
            [to, to_prefix.as_str()],
        )?;
        tx.execute(
            &format!(
                "UPDATE {table} SET file = ?3 || substr(file, length(?1) + 1)
                 WHERE file = ?1 OR substr(file, 1, length(?2)) = ?2"
            ),
            [from, from_prefix.as_str(), to],
        )?;
    }
    rewrite_candidates(tx, |file| {
        if under(file, from) {
            Some(Some(format!("{to}{}", &file[from.len()..])))
        } else {
            None
        }
    })
}

/// Drop every row for `path` (a file, or a folder and everything under it).
pub fn delete_path_rows(tx: &Transaction, path: &str) -> Result<()> {
    let prefix = format!("{path}/");
    for table in PATH_TABLES {
        tx.execute(
            &format!("DELETE FROM {table} WHERE file = ?1 OR substr(file, 1, length(?2)) = ?2"),
            [path, prefix.as_str()],
        )?;
    }
    rewrite_candidates(tx, |file| under(file, path).then_some(None))
}

/// Candidates keep their files and contexts as JSON; `map` returns
/// `None` to leave a path alone, `Some(None)` to drop it, `Some(Some(p))` to
/// re-key it. A candidate left with no files is removed.
fn rewrite_candidates(
    tx: &Transaction,
    map: impl Fn(&str) -> Option<Option<String>>,
) -> Result<()> {
    use crate::codex::CandidateContext;
    let rows: Vec<(String, String, String)> = tx
        .prepare("SELECT name, files, contexts FROM candidates")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, files_json, contexts_json) in rows {
        let files: Vec<String> = serde_json::from_str(&files_json).unwrap_or_default();
        let contexts: Vec<CandidateContext> = crate::codex::parse_contexts(&contexts_json);
        if !files.iter().any(|f| map(f).is_some())
            && !contexts.iter().any(|c| map(&c.file).is_some())
        {
            continue;
        }
        let mut new_files: Vec<String> = Vec::new();
        for f in files {
            let mapped = match map(&f) {
                None => Some(f),
                Some(m) => m,
            };
            if let Some(m) = mapped
                && !new_files.contains(&m)
            {
                new_files.push(m);
            }
        }
        let new_contexts: Vec<CandidateContext> = contexts
            .into_iter()
            .filter_map(|mut c| match map(&c.file) {
                None => Some(c),
                Some(None) => None,
                Some(Some(p)) => {
                    c.file = p;
                    Some(c)
                }
            })
            .collect();
        if new_files.is_empty() {
            tx.execute("DELETE FROM candidates WHERE name = ?1", [&name])?;
        } else {
            tx.execute(
                "UPDATE candidates SET files = ?2, contexts = ?3, count = ?4 WHERE name = ?1",
                rusqlite::params![
                    name,
                    serde_json::to_string(&new_files)?,
                    serde_json::to_string(&new_contexts)?,
                    new_files.len() as i64
                ],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(db: &Db, sql: &str) -> i64 {
        db.with(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .unwrap()
    }

    fn seed(db: &Db, file: &str) {
        db.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO entities (id, name, created, updated) VALUES (1, 'Mira', 0, 0)",
                [],
            )?;
            c.execute("INSERT INTO mentions (entity_id, file, line) VALUES (1, ?1, 1)", [file])?;
            c.execute("INSERT INTO scene_meta (file, synopsis) VALUES (?1, 's')", [file])?;
            c.execute(
                "INSERT INTO assistant_findings (file, line, quote, kind, message, created)
                 VALUES (?1, 1, 'q', 'fact', 'm', 0)",
                [file],
            )?;
            c.execute("INSERT INTO scene_facts (file, hash, facts, extracted) VALUES (?1, 'h', '[]', 0)", [file])?;
            c.execute(
                "INSERT INTO embeddings (file, chunk, start_line, end_line, text, vector) VALUES (?1, 0, 1, 1, 't', x'00')",
                [file],
            )?;
            c.execute("INSERT INTO suppressions (rule_id, file, text) VALUES ('r', ?1, 't')", [file])?;
            c.execute("INSERT OR IGNORE INTO threads (id, name) VALUES (1, 'thread')", [])?;
            c.execute("INSERT INTO scene_threads (file, thread_id) VALUES (?1, 1)", [file])?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn folder_move_rekeys_children_exactly() {
        let db = Db::open_in_memory().unwrap();
        seed(&db, "Été/a_1.md");
        seed(&db, "Été/sub/b.md");
        seed(&db, "ÉtéX/c.md"); // shares a prefix but not the folder
        seed(&db, "été/d.md"); // differs only by case
        db.with(|c| {
            c.execute(
                "INSERT INTO candidates (name, files, contexts, count, updated)
                 VALUES ('Ash', ?1, ?2, 2, 0)",
                [
                    r#"["Été/a_1.md","ÉtéX/c.md"]"#,
                    r#"[{"file":"Été/a_1.md","line":1,"text":"x"}]"#,
                ],
            )?;
            Ok(())
        })
        .unwrap();
        db.tx(|tx| move_path_rows(tx, "Été", "Summer")).unwrap();
        for table in PATH_TABLES {
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE file = 'Summer/a_1.md'")
                ),
                1,
                "{table}"
            );
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE file = 'Summer/sub/b.md'")
                ),
                1,
                "{table}"
            );
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE file = 'ÉtéX/c.md'")
                ),
                1,
                "{table}"
            );
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE file = 'été/d.md'")
                ),
                1,
                "{table}"
            );
            assert_eq!(
                count(
                    &db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE file LIKE 'Été/%'")
                ),
                0,
                "{table}"
            );
        }
        let files: String = db
            .with(|c| Ok(c.query_row("SELECT files FROM candidates", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(files, r#"["Summer/a_1.md","ÉtéX/c.md"]"#);
    }

    #[test]
    fn delete_drops_rows_and_empty_candidates() {
        let db = Db::open_in_memory().unwrap();
        seed(&db, "ch/a.md");
        seed(&db, "chapter/b.md");
        db.with(|c| {
            c.execute(
                "INSERT INTO candidates (name, files, count, updated) VALUES ('Ash', '[\"ch/a.md\"]', 1, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        db.tx(|tx| delete_path_rows(tx, "ch")).unwrap();
        for table in PATH_TABLES {
            assert_eq!(
                count(&db, &format!("SELECT COUNT(*) FROM {table}")),
                1,
                "{table}"
            );
        }
        assert_eq!(count(&db, "SELECT COUNT(*) FROM candidates"), 0);
    }

    #[test]
    fn a_database_from_another_schema_is_set_aside() {
        let dir = std::env::temp_dir().join(format!("chronicler-schema-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".chronicler")).unwrap();
        {
            let c = Connection::open(dir.join(".chronicler").join("db")).unwrap();
            c.execute_batch("CREATE TABLE entities (id INTEGER PRIMARY KEY); PRAGMA user_version = 10;").unwrap();
        }
        let db = Db::open(&dir).unwrap();
        assert_eq!(count(&db, "PRAGMA user_version"), SCHEMA_VERSION);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM threads"), 0);
        assert!(dir.join(".chronicler").join("db.v10.bak").exists(), "the old db is kept, not deleted");
        drop(db);
        // A current db opens as-is.
        let db = Db::open(&dir).unwrap();
        assert_eq!(count(&db, "PRAGMA user_version"), SCHEMA_VERSION);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn move_onto_stale_rows_does_not_collide() {
        let db = Db::open_in_memory().unwrap();
        seed(&db, "a.md");
        seed(&db, "b.md");
        db.tx(|tx| move_path_rows(tx, "a.md", "b.md")).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM scene_meta"), 1);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM scene_meta WHERE file = 'b.md'"),
            1
        );
    }
}
