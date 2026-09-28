//! Project file plumbing: validated relative paths, atomic writes, the
//! manuscript walker, and text matching shared by search, replace and the
//! agent's grep tool.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::ops::{ControlFlow, Range};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use ts_rs::TS;

use crate::rpc::invalid;

// ---------- Relative paths ----------

/// A validated project-relative path: normalized to forward slashes, no `.`
/// or `..` components, never the project root itself. The normalized string
/// is what the database keys on.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RelPath(String);

/// App-data files the frontend reads and writes directly (binder order,
/// project metadata): `.chronicler/<name>.json`, one level deep.
fn is_app_data(parts: &[&str]) -> bool {
    matches!(parts, [".chronicler", name] if name.ends_with(".json") && !name.starts_with('.'))
}

impl RelPath {
    fn parts(raw: &str) -> Result<Vec<&str>> {
        let p = Path::new(raw);
        if p.is_absolute() || raw.starts_with('/') || raw.starts_with('\\') {
            return Err(invalid("Absolute paths are not allowed"));
        }
        let mut parts: Vec<&str> = Vec::new();
        for comp in p.components() {
            match comp {
                Component::Normal(os) => parts.push(
                    os.to_str()
                        .ok_or_else(|| invalid("Path is not valid UTF-8"))?,
                ),
                Component::CurDir => {}
                Component::ParentDir => return Err(invalid("Path escapes project root")),
                Component::RootDir | Component::Prefix(_) => {
                    return Err(invalid("Absolute paths are not allowed"));
                }
            }
        }
        if parts.is_empty() {
            return Err(invalid(
                "A path is required (the project root itself is not allowed)",
            ));
        }
        Ok(parts)
    }

    /// A manuscript path: anything in the binder. Hidden (dot-prefixed)
    /// components — `.chronicler`, `.jj`, temp files — are refused, so no
    /// mutation can reach app state or history.
    pub fn parse(raw: &str) -> Result<RelPath> {
        let parts = Self::parts(raw)?;
        if parts.iter().any(|p| p.starts_with('.')) {
            return Err(invalid(format!(
                "Hidden files and folders are off limits: {raw}"
            )));
        }
        Ok(RelPath(parts.join("/")))
    }

    /// A document the frontend may read or save: a manuscript path, or an
    /// app-data file (`.chronicler/order.json`, `.chronicler/project.json`).
    pub fn document(raw: &str) -> Result<RelPath> {
        let parts = Self::parts(raw)?;
        if parts.iter().any(|p| p.starts_with('.')) && !is_app_data(&parts) {
            return Err(invalid(format!(
                "Hidden files and folders are off limits: {raw}"
            )));
        }
        Ok(RelPath(parts.join("/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn to_path(&self, root: &Path) -> PathBuf {
        root.join(&self.0)
    }

    pub fn is_markdown(&self) -> bool {
        self.0.ends_with(".md")
    }
}

impl std::fmt::Display for RelPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Front/Back Matter folders hold prelims and end pages: compiled specially,
/// invisible to the agent pipelines.
pub fn is_matter_path(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    lower.starts_with("front matter/") || lower.starts_with("back matter/")
}

/// The top-level research folder: images, PDFs, clippings, notes. Not
/// manuscript — never walked, compiled, counted, checked or indexed.
pub const RESEARCH_DIR: &str = "Research";

/// Is `rel` the research folder or anything inside it? Case-insensitive,
/// like the matter folders (macOS folders usually are).
pub fn is_research_path(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    lower == "research" || lower.starts_with("research/")
}

// ---------- Atomic writes ----------

/// Per-path write serialization. Two saves of one file land in order and
/// never interleave; saves of different files don't contend.
#[derive(Default)]
pub struct WriteLocks {
    map: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl WriteLocks {
    pub fn lock(&self, path: &Path) -> parking_lot::ArcMutexGuard<parking_lot::RawMutex, ()> {
        let m = self
            .map
            .lock()
            .entry(path.to_path_buf())
            .or_default()
            .clone();
        m.lock_arc()
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write via a uniquely named temp file + rename, so a crash mid-write can't
/// truncate the target and concurrent writers can't clobber each other's
/// temp file.
pub fn atomic_write(locks: &WriteLocks, path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let file_name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid file name")
    })?;
    let _guard = locks.lock(path);
    // Dot-prefixed so the walker and the watcher pipeline ignore it.
    let tmp = path.with_file_name(format!(
        ".{}.{}-{}.tmp",
        file_name,
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// ---------- Walking the manuscript ----------

/// One binder entry.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Project-relative path, forward slashes.
    pub path: String,
    pub is_dir: bool,
}

/// Every folder and `.md` file under `root`, depth-first, names sorted
/// within each folder. Hidden entries and the research folder are skipped;
/// symlinked folders are not followed.
pub fn walk(root: &Path) -> Vec<FileEntry> {
    let mut out = Vec::new();
    walk_into(root, "", &mut out);
    out
}

fn walk_into(dir: &Path, prefix: &str, out: &mut Vec<FileEntry>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') || (prefix.is_empty() && is_research_path(name)) {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            out.push(FileEntry {
                path: rel.clone(),
                is_dir: true,
            });
            walk_into(&path, &rel, out);
        } else if (ft.is_file() || (ft.is_symlink() && path.is_file()))
            && path.extension().is_some_and(|e| e == "md")
        {
            out.push(FileEntry {
                path: rel,
                is_dir: false,
            });
        }
    }
}

/// Every `.md` file in the project, in binder (reading) order.
pub fn list_md_files(root: &Path) -> Vec<String> {
    walk(root)
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| e.path)
        .collect()
}

/// `.md` files under a folder (or the file itself).
/// Nothing under the research folder counts.
pub fn md_files_under(root: &Path, rel: &str) -> Vec<String> {
    if is_research_path(rel) {
        return vec![];
    }
    let abs = root.join(rel);
    if abs.is_dir() {
        let mut out = Vec::new();
        walk_into(&abs, rel, &mut out);
        out.into_iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.path)
            .collect()
    } else if rel.ends_with(".md") && abs.is_file() {
        vec![rel.to_string()]
    } else {
        vec![]
    }
}

pub fn read_text(root: &Path, rel: &RelPath) -> Result<String> {
    std::fs::read_to_string(rel.to_path(root)).with_context(|| format!("reading {rel}"))
}

// ---------- Text matching ----------

/// A plain-text needle, matched exactly or case-insensitively. Case folding
/// is per character with byte offsets into the original text, so scripts
/// whose lowercase form changes length still splice correctly.
pub struct Matcher {
    exact: String,
    folded: Vec<char>,
    case_sensitive: bool,
}

impl Matcher {
    pub fn new(query: &str, case_sensitive: bool) -> Result<Matcher> {
        if query.is_empty() {
            return Err(invalid("Search text is empty"));
        }
        Ok(Matcher {
            exact: query.to_string(),
            folded: query.chars().flat_map(char::to_lowercase).collect(),
            case_sensitive,
        })
    }

    fn match_at(&self, hay: &str, start: usize) -> Option<usize> {
        let mut k = 0;
        for (off, c) in hay[start..].char_indices() {
            for f in c.to_lowercase() {
                if k >= self.folded.len() || self.folded[k] != f {
                    return None;
                }
                k += 1;
            }
            if k == self.folded.len() {
                return Some(start + off + c.len_utf8());
            }
        }
        None
    }

    /// Non-overlapping matches as byte ranges into `hay`.
    pub fn find_all(&self, hay: &str) -> Vec<Range<usize>> {
        if self.case_sensitive {
            return hay
                .match_indices(&self.exact)
                .map(|(i, m)| i..i + m.len())
                .collect();
        }
        let mut out = Vec::new();
        let mut pos = 0;
        while pos < hay.len() {
            match self.match_at(hay, pos) {
                Some(end) => {
                    out.push(pos..end);
                    pos = end;
                }
                None => {
                    pos += hay[pos..].chars().next().map_or(1, char::len_utf8);
                }
            }
        }
        out
    }

    pub fn is_match(&self, hay: &str) -> bool {
        if self.case_sensitive {
            hay.contains(&self.exact)
        } else {
            hay.char_indices()
                .any(|(i, _)| self.match_at(hay, i).is_some())
        }
    }
}

/// Visit every matching line of every manuscript file: `(file, 1-based
/// line, line text)`. Stop early by returning `ControlFlow::Break`.
pub fn grep(
    root: &Path,
    matcher: &Matcher,
    mut on_hit: impl FnMut(&str, usize, &str) -> ControlFlow<()>,
) {
    for rel in list_md_files(root) {
        let Ok(content) = std::fs::read_to_string(root.join(&rel)) else {
            continue;
        };
        for (i, line) in content.lines().enumerate() {
            if matcher.is_match(line) && on_hit(&rel, i + 1, line).is_break() {
                return;
            }
        }
    }
}

/// Replace matches in `content`, optionally only on one 1-based line.
/// Line endings (LF or CRLF) and a trailing newline are preserved exactly.
pub fn replace_in_text(
    content: &str,
    matcher: &Matcher,
    replacement: &str,
    only_line: Option<usize>,
) -> (String, usize) {
    let mut out = String::with_capacity(content.len());
    let mut count = 0;
    for (i, raw) in content.split_inclusive('\n').enumerate() {
        let body_len = raw
            .strip_suffix("\r\n")
            .or_else(|| raw.strip_suffix('\n'))
            .unwrap_or(raw)
            .len();
        let (body, ending) = raw.split_at(body_len);
        if only_line.is_some_and(|l| l != i + 1) {
            out.push_str(raw);
            continue;
        }
        let mut last = 0;
        for m in matcher.find_all(body) {
            out.push_str(&body[last..m.start]);
            out.push_str(replacement);
            last = m.end;
            count += 1;
        }
        out.push_str(&body[last..]);
        out.push_str(ending);
    }
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relpath_rules() {
        assert_eq!(RelPath::parse("a/./b.md").unwrap().as_str(), "a/b.md");
        for bad in [
            ".",
            "",
            "./",
            "..",
            "a/../../x",
            "/etc",
            ".chronicler/db",
            ".jj",
            "a/.git/x",
            ".chronicler/order.json",
        ] {
            assert!(RelPath::parse(bad).is_err(), "{bad} should be rejected");
        }
        assert_eq!(
            RelPath::document("./.chronicler/order.json")
                .unwrap()
                .as_str(),
            ".chronicler/order.json"
        );
        for bad in [
            ".chronicler",
            ".chronicler/db",
            ".chronicler/journal/x.json",
            ".jj/repo",
            ".",
        ] {
            assert!(RelPath::document(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn research_is_never_walked() {
        assert!(is_research_path("Research"));
        assert!(is_research_path("research/Clippings/a.md"));
        assert!(!is_research_path("Researchers.md"));
        assert!(!is_research_path("Ch 1/Research/x.md"));
        let dir = std::env::temp_dir().join(format!("chronicler-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in ["Research/note.md", "Research/Clippings/c.md", "Ch 1/s.md"] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        let paths: Vec<String> = walk(&dir).into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["Ch 1", "Ch 1/s.md"]);
        assert!(md_files_under(&dir, "Research").is_empty());
        assert!(md_files_under(&dir, "Research/note.md").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn case_insensitive_splices_by_original_offsets() {
        // 'İ' lowercases to two chars; offsets must come from the original.
        let m = Matcher::new("i̇stanbul", false).unwrap();
        let (out, n) = replace_in_text("İSTANBUL and İstanbul\n", &m, "X", None);
        assert_eq!((out.as_str(), n), ("X and X\n", 2));

        let m = Matcher::new("dragon", false).unwrap();
        let (out, n) = replace_in_text(
            "The Dragon — ÉDRAGON dragon\r\nnext dragon",
            &m,
            "wyrm",
            None,
        );
        assert_eq!(out, "The wyrm — Éwyrm wyrm\r\nnext wyrm");
        assert_eq!(n, 4);
    }

    #[test]
    fn replace_scoped_to_one_line_keeps_crlf() {
        let m = Matcher::new("a", true).unwrap();
        let (out, n) = replace_in_text("a\r\na\r\n", &m, "b", Some(2));
        assert_eq!((out.as_str(), n), ("a\r\nb\r\n", 1));
    }

    #[test]
    fn concurrent_atomic_writes_never_corrupt() {
        let dir = std::env::temp_dir().join(format!("chronicler-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scene.md");
        let locks = Arc::new(WriteLocks::default());
        let contents: Vec<String> = (0..16).map(|i| format!("{i}").repeat(10_000 + i)).collect();
        std::thread::scope(|s| {
            for c in &contents {
                let (locks, path) = (locks.clone(), path.clone());
                s.spawn(move || {
                    for _ in 0..10 {
                        atomic_write(&locks, &path, c).unwrap();
                    }
                });
            }
        });
        let final_content = std::fs::read_to_string(&path).unwrap();
        assert!(
            contents.contains(&final_content),
            "file content is a mix of writes"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
