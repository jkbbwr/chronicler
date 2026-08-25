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
         );
         PRAGMA user_version = 1;",
    )
    .context("initializing project db schema")?;
    Ok(conn)
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
