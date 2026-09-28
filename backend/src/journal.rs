//! The hot-exit journal: unsaved editor buffers, kept under
//! `.chronicler/journal/` so a crash or quit never loses typing. One JSON
//! file per document, named by a hash of its path.

use crate::app::App;
use crate::fsx::{RelPath, atomic_write};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub path: String,
    pub content: String,
    /// Unix milliseconds.
    pub saved_at: i64,
}

fn dir(app: &App) -> PathBuf {
    app.root.join(".chronicler").join("journal")
}

/// Stable file name for a path (FNV-1a; collisions are resolved by the
/// `path` stored inside).
fn file_for(app: &App, path: &str) -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    dir(app).join(format!("{h:016x}.json"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn write(app: &App, path: &str, content: &str) -> Result<()> {
    let rel = RelPath::document(path)?;
    std::fs::create_dir_all(dir(app)).context("creating journal dir")?;
    let entry = JournalEntry {
        path: rel.as_str().to_string(),
        content: content.to_string(),
        saved_at: now_ms(),
    };
    atomic_write(
        &app.writes,
        &file_for(app, rel.as_str()),
        &serde_json::to_string(&entry)?,
    )
    .context("writing journal entry")
}

/// Every journal entry, oldest first. Unreadable entries are skipped.
pub fn read(app: &App) -> Result<Vec<JournalEntry>> {
    let Ok(entries) = std::fs::read_dir(dir(app)) else {
        return Ok(vec![]);
    };
    let mut out: Vec<JournalEntry> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect();
    out.sort_by_key(|e| e.saved_at);
    Ok(out)
}

/// Drop one document's entry, or all of them.
pub fn clear(app: &App, path: Option<&str>) -> Result<()> {
    match path {
        Some(p) => {
            let rel = RelPath::document(p)?;
            match std::fs::remove_file(file_for(app, rel.as_str())) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            }
        }
        None => match std::fs::remove_dir_all(dir(app)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_roundtrip() {
        let dir = std::env::temp_dir().join(format!("chronicler-journal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (app, _q) = App::open(&dir, crate::app::Output::discard()).unwrap();
        write(&app, "ch1/a.md", "draft one").unwrap();
        write(&app, "./ch1/a.md", "draft two").unwrap();
        write(&app, "b.md", "other").unwrap();
        let entries = read(&app).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(
            entries
                .iter()
                .any(|e| e.path == "ch1/a.md" && e.content == "draft two")
        );
        clear(&app, Some("ch1/a.md")).unwrap();
        assert_eq!(read(&app).unwrap().len(), 1);
        clear(&app, None).unwrap();
        assert!(read(&app).unwrap().is_empty());
        assert!(write(&app, "../x.md", "no").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
