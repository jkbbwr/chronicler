use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

/// Open (creating if needed) the project database at `.chronicler/db`.
/// The db is the project's source of truth for settings and, later,
/// codex/world-bible data and content indexes.
pub fn open(root: &Path) -> Result<Connection> {
    let dir = root.join(".chronicler");
    std::fs::create_dir_all(&dir).context("creating .chronicler directory")?;
    let conn = Connection::open(dir.join("db")).context("opening project db")?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )
    .context("initializing project db schema")?;
    migrate(&conn).context("migrating project db")?;
    Ok(conn)
}

/// Schema, squashed to a single migration while the app is pre-release.
/// The version marker stays at 10 so databases created by earlier dev
/// builds skip cleanly; bump it (and add a new block) for future changes.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 10 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS entities (
                 id      INTEGER PRIMARY KEY,
                 name    TEXT NOT NULL UNIQUE,
                 kind    TEXT NOT NULL DEFAULT 'character',
                 summary TEXT NOT NULL DEFAULT '',
                 body    TEXT NOT NULL DEFAULT '',
                 aliases TEXT NOT NULL DEFAULT '[]',
                 created INTEGER NOT NULL,
                 updated INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS mentions (
                 entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                 file      TEXT NOT NULL,
                 line      INTEGER NOT NULL,
                 PRIMARY KEY (entity_id, file, line)
             );
             CREATE TABLE IF NOT EXISTS candidates (
                 name       TEXT PRIMARY KEY,
                 kind_guess TEXT NOT NULL DEFAULT '',
                 count      INTEGER NOT NULL DEFAULT 0,
                 files      TEXT NOT NULL DEFAULT '[]',
                 contexts   TEXT NOT NULL DEFAULT '[]',
                 source     TEXT NOT NULL DEFAULT 'ner',
                 summary    TEXT NOT NULL DEFAULT '',
                 updated    INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS dismissed (
                 name TEXT PRIMARY KEY
             );
             CREATE TABLE IF NOT EXISTS dictionary (
                 word TEXT PRIMARY KEY
             );
             CREATE TABLE IF NOT EXISTS suppressions (
                 rule_id TEXT NOT NULL,
                 file    TEXT NOT NULL,
                 text    TEXT NOT NULL,
                 PRIMARY KEY (rule_id, file, text)
             );
             CREATE TABLE IF NOT EXISTS writing_days (
                 date   TEXT PRIMARY KEY,
                 start  INTEGER NOT NULL,
                 latest INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS scene_meta (
                 file     TEXT PRIMARY KEY,
                 synopsis TEXT NOT NULL DEFAULT '',
                 status   TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS embeddings (
                 file       TEXT NOT NULL,
                 chunk      INTEGER NOT NULL,
                 start_line INTEGER NOT NULL,
                 end_line   INTEGER NOT NULL,
                 text       TEXT NOT NULL,
                 vector     BLOB NOT NULL,
                 PRIMARY KEY (file, chunk)
             );
             CREATE TABLE IF NOT EXISTS assistant_findings (
                 id      INTEGER PRIMARY KEY,
                 file    TEXT NOT NULL,
                 line    INTEGER NOT NULL,
                 quote   TEXT NOT NULL,
                 kind    TEXT NOT NULL,
                 message TEXT NOT NULL,
                 created INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS scene_facts (
                 file      TEXT PRIMARY KEY,
                 hash      TEXT NOT NULL,
                 facts     TEXT NOT NULL,
                 extracted INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS relations (
                 id      INTEGER PRIMARY KEY,
                 from_id INTEGER NOT NULL,
                 to_id   INTEGER NOT NULL,
                 label   TEXT NOT NULL,
                 source  TEXT NOT NULL DEFAULT 'human',
                 created INTEGER NOT NULL
             );
             PRAGMA user_version = 10;",
        )?;
    }
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn get_setting(root: &Path, key: &str) -> Result<Option<String>> {
    let conn = open(root)?;
    match conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0)) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e).context("reading setting"),
    }
}

pub fn set_setting(root: &Path, key: &str, value: &str) -> Result<()> {
    let conn = open(root)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .context("writing setting")?;
    Ok(())
}
