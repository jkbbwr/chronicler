use crate::db;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;

// Writing statistics: live word counts per file plus a persistent daily
// ledger (words at day start vs now) so "written today" and streak history
// survive restarts. The client supplies its local date string, so day
// boundaries follow the writer's timezone, not UTC.

/// Count prose words: whitespace tokens containing at least one letter or
/// digit, with fenced code and HTML comments excluded.
pub fn count_words(content: &str) -> usize {
    let mut count = 0;
    let mut in_fence = false;
    let mut in_comment = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Cheap comment masking with cross-line state
        let mut token = String::new();
        let mut chars = line.chars().peekable();
        let flush = |t: &mut String, count: &mut usize| {
            if t.chars().any(|c| c.is_alphanumeric()) {
                *count += 1;
            }
            t.clear();
        };
        while let Some(c) = chars.next() {
            if in_comment {
                if c == '-' && chars.peek() == Some(&'-') {
                    chars.next();
                    if chars.peek() == Some(&'>') {
                        chars.next();
                        in_comment = false;
                    }
                }
                continue;
            }
            if c == '<' && chars.peek() == Some(&'!') {
                let rest: String = chars.clone().take(3).collect();
                if rest == "!--" {
                    chars.next();
                    chars.next();
                    chars.next();
                    in_comment = true;
                    flush(&mut token, &mut count);
                    continue;
                }
            }
            if c.is_whitespace() {
                flush(&mut token, &mut count);
            } else {
                token.push(c);
            }
        }
        flush(&mut token, &mut count);
    }
    count
}

/// Compute project stats and roll the daily ledger forward.
/// `today` is the client's local date (e.g. "2026-08-25").
pub fn project_stats(root: &Path, today: &str) -> Result<Value> {
    let mut files = Vec::new();
    let mut total: i64 = 0;
    for rel in crate::list_md_files(root) {
        let Ok(path) = crate::resolve_path(root, &rel) else { continue };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let words = count_words(&content) as i64;
        total += words;
        files.push(json!({ "file": rel, "words": words }));
    }

    let conn = db::open(root)?;
    conn.execute(
        "INSERT INTO writing_days (date, start, latest) VALUES (?1, ?2, ?2)
         ON CONFLICT(date) DO UPDATE SET latest = ?2",
        rusqlite::params![today, total],
    )
    .context("updating writing ledger")?;

    let (start, latest): (i64, i64) = conn.query_row(
        "SELECT start, latest FROM writing_days WHERE date = ?1",
        [today],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    let mut stmt =
        conn.prepare("SELECT date, latest - start FROM writing_days ORDER BY date DESC LIMIT 14")?;
    let history = stmt
        .query_map([], |r| {
            Ok(json!({ "date": r.get::<_, String>(0)?, "written": r.get::<_, i64>(1)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(json!({
        "total": total,
        "files": files,
        "today": { "date": today, "written": latest - start },
        "history": history,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_counting() {
        assert_eq!(count_words("Hello world"), 2);
        assert_eq!(count_words("# A Heading\n\nSome **bold** prose here."), 6);
        assert_eq!(count_words("before <!-- hidden words --> after"), 2);
        assert_eq!(count_words("text\n```\ncode words ignored\n```\nmore"), 2);
        assert_eq!(count_words("— … ***"), 0); // punctuation-only tokens
        assert_eq!(count_words("line one <!-- spans\nstill hidden\n--> back now"), 4);
    }
}
