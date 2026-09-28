//! Project history, stored in a non-colocated Jujutsu repo at `<project>/.jj`.
//!
//! The working-copy change (@) is the writer's working draft: every save is
//! captured into it, so its evolog is the save log. Locking in describes the
//! draft and starts a fresh one on top. Any change can be renamed later.
//!
//! The writer's own jj config never leaks in (signing, pagers, templates).

use anyhow::{Context, bail};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use ts_rs::TS;

type AnyResult<T> = anyhow::Result<T>;

const LIST_LIMIT: &str = "200";

/// Below this word-level similarity, a changed paragraph is shown as removed
/// and replaced rather than edited in place.
const REWRITE_SIMILARITY: f32 = 0.5;

/// The project's history repo. One jj invocation at a time: capture runs
/// off the indexer while RPCs arrive, and racing operations would fork the
/// operation log.
pub struct Repo {
    root: PathBuf,
    lock: Mutex<()>,
}

impl Repo {
    pub fn new(root: &Path) -> Repo {
        Repo {
            root: root.to_path_buf(),
            lock: Mutex::new(()),
        }
    }

    fn jj(&self, args: &[&str]) -> AnyResult<String> {
        run_jj_bytes(&self.root, &self.lock, args).map(|b| String::from_utf8_lossy(&b).to_string())
    }

    fn jj_bytes(&self, args: &[&str]) -> AnyResult<Vec<u8>> {
        run_jj_bytes(&self.root, &self.lock, args)
    }

    fn has_repo(&self) -> bool {
        self.root.join(".jj").join("repo").exists()
    }

    fn ensure_repo(&self) -> AnyResult<()> {
        if !self.has_repo() {
            self.jj(&["git", "init", "--no-colocate"])
                .context("initializing project history")?;
        }
        Ok(())
    }
}

/// Run jj in the project root with a fixed identity and no user config.
fn run_jj_bytes(root: &Path, lock: &Mutex<()>, args: &[&str]) -> AnyResult<Vec<u8>> {
    let _guard = lock.lock();
    let out = std::process::Command::new("jj")
        .current_dir(root)
        .env("JJ_CONFIG", "/dev/null")
        .args(["--no-pager", "--color=never"])
        .args([
            "--config",
            "user.name=Chronicler",
            "--config",
            "user.email=history@chronicler.local",
        ])
        // App state (db, build output) churns constantly and isn't the manuscript.
        .args([
            "--config",
            r#"snapshot.auto-track='~(root:".chronicler" | glob:"**/.DS_Store")'"#,
        ])
        .args(args)
        .output()
        .context("running jj (is Jujutsu installed?)")?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
}

/// Change ids (k–z) and commit ids (hex) are alphanumeric, and `@` is the
/// working draft; reject anything else before it reaches a revset.
fn check_rev(rev: &str) -> AnyResult<()> {
    if rev != "@" && (rev.is_empty() || !rev.chars().all(|c| c.is_ascii_alphanumeric())) {
        return Err(crate::rpc::invalid("Invalid revision"));
    }
    Ok(())
}

/// A fileset matching exactly one project-relative path.
fn file_pattern(rel_path: &str) -> String {
    format!(
        "root-file:\"{}\"",
        rel_path.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

// ---------- Wire types ----------

/// One change (a locked-in version, or the working draft).
#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub change_id: String,
    pub commit_id: String,
    pub parent_id: String,
    /// The working draft.
    pub current: bool,
    pub empty: bool,
    /// Unix seconds.
    pub created: i64,
    pub updated: i64,
    pub files: Vec<String>,
    pub description: String,
}

#[derive(Serialize, TS, Debug)]
pub struct ChangeList {
    pub changes: Vec<Change>,
}

/// One save inside a change.
#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvologEntry {
    pub commit_id: String,
    pub predecessor_id: String,
    pub timestamp: i64,
    pub files: Vec<String>,
}

#[derive(Serialize, TS, Debug)]
pub struct Evolog {
    pub entries: Vec<EvologEntry>,
}

#[derive(Serialize, TS, Debug)]
pub struct LockIn {
    pub locked: bool,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SegmentTag {
    Equal,
    Insert,
    Delete,
}

#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParagraphTag {
    Equal,
    Insert,
    Delete,
    /// A rewritten paragraph: segments mark the inserted and deleted words.
    Modify,
}

/// A paragraph of a prose diff: `segments` are `[tag, text]` pairs.
#[derive(Serialize, TS, Debug)]
pub struct Paragraph {
    pub tag: ParagraphTag,
    pub segments: Vec<(SegmentTag, String)>,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// jj's status: added | removed | modified | renamed | copied
    pub status: String,
    pub path: String,
    pub old_path: String,
    pub binary: bool,
    pub words_added: usize,
    pub words_removed: usize,
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Serialize, TS, Debug)]
pub struct Diff {
    pub files: Vec<FileDiff>,
}

fn split_paths(s: &str) -> Vec<String> {
    s.split('\u{1e}')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect()
}

impl Repo {
    /// Record the files on disk into the working draft. Called after every
    /// batch of saves.
    pub fn capture(&self) -> AnyResult<()> {
        self.ensure_repo()?;
        self.jj(&["util", "snapshot"])?;
        Ok(())
    }

    /// Changes, newest first. With `rel_path`, only those that touched that
    /// file (the working draft is always included so there's somewhere to
    /// lock in).
    pub fn changes(&self, rel_path: Option<&str>) -> AnyResult<ChangeList> {
        if !self.has_repo() {
            return Ok(ChangeList { changes: vec![] });
        }
        let revset = match rel_path {
            Some(p) => format!("@ | (::@ ~ root()) & files({})", file_pattern(p)),
            None => "::@ ~ root()".to_string(),
        };
        let template = r#"change_id ++ "\x1f" ++ commit_id ++ "\x1f" ++ parents.map(|c| c.commit_id()).join(",") ++ "\x1f" ++ current_working_copy ++ "\x1f" ++ author.timestamp().format("%s") ++ "\x1f" ++ committer.timestamp().format("%s") ++ "\x1f" ++ self.diff().files().map(|f| f.path().display()).join("\x1e") ++ "\x1f" ++ description.first_line() ++ "\n""#;
        let log = self.jj(&[
            "log",
            "-r",
            &revset,
            "--no-graph",
            "-n",
            LIST_LIMIT,
            "-T",
            template,
        ])?;
        let changes = log
            .lines()
            .filter_map(|line| {
                let f: Vec<&str> = line.split('\u{1f}').collect();
                if f.len() < 8 {
                    return None;
                }
                let files = split_paths(f[6]);
                Some(Change {
                    change_id: f[0].into(),
                    commit_id: f[1].into(),
                    parent_id: f[2].split(',').next().unwrap_or("").into(),
                    current: f[3] == "true",
                    empty: files.is_empty(),
                    created: f[4].parse().ok()?,
                    updated: f[5].parse().ok()?,
                    files,
                    description: f[7].into(),
                })
            })
            .collect();
        Ok(ChangeList { changes })
    }

    /// The saves inside one change, newest first. Entries that changed no
    /// files (renames, rebases, the empty start of a draft) are left out.
    pub fn evolog(&self, change_id: &str) -> AnyResult<Evolog> {
        check_rev(change_id)?;
        let template = r#"commit.commit_id() ++ "\x1f" ++ self.predecessors().map(|c| c.commit_id()).join(",") ++ "\x1f" ++ commit.committer().timestamp().format("%s") ++ "\x1f" ++ self.inter_diff().files().map(|f| f.path().display()).join("\x1e") ++ "\n""#;
        let log = self.jj(&[
            "evolog",
            "-r",
            change_id,
            "--no-graph",
            "-n",
            LIST_LIMIT,
            "-T",
            template,
        ])?;
        let entries = log
            .lines()
            .filter_map(|line| {
                let f: Vec<&str> = line.split('\u{1f}').collect();
                if f.len() < 4 {
                    return None;
                }
                let files = split_paths(f[3]);
                if files.is_empty() {
                    return None;
                }
                Some(EvologEntry {
                    commit_id: f[0].into(),
                    predecessor_id: f[1].split(',').next().unwrap_or("").into(),
                    timestamp: f[2].parse().ok()?,
                    files,
                })
            })
            .collect();
        Ok(Evolog { entries })
    }

    /// Name (or rename) any change.
    pub fn describe(&self, change_id: &str, message: &str) -> AnyResult<()> {
        check_rev(change_id)?;
        self.jj(&["describe", "-r", change_id, "-m", message])
            .context("naming change")?;
        Ok(())
    }

    /// Name the working draft and start a fresh one on top of it.
    pub fn lock_in(&self, message: &str) -> AnyResult<LockIn> {
        if message.trim().is_empty() {
            return Err(crate::rpc::invalid("A locked-in change needs a name"));
        }
        self.ensure_repo()?;
        if self
            .jj(&["log", "-r", "@", "--no-graph", "-T", "empty"])?
            .trim()
            == "true"
        {
            return Ok(LockIn {
                locked: false,
                reason: Some("No changes since the last lock-in".into()),
            });
        }
        self.jj(&["describe", "-r", "@", "-m", message])
            .context("locking in change")?;
        self.jj(&["new"]).context("starting a new draft")?;
        Ok(LockIn {
            locked: true,
            reason: None,
        })
    }

    /// Restore one file, or the whole project, to its state at `rev` (a
    /// change or any evolog entry). The restore itself lands in the draft.
    pub fn restore(&self, rev: &str, rel_path: Option<&str>) -> AnyResult<()> {
        check_rev(rev)?;
        let mut args = vec!["restore", "--from", rev];
        let pattern;
        if let Some(p) = rel_path {
            pattern = file_pattern(p);
            args.extend(["--", pattern.as_str()]);
        }
        self.jj(&args).context("restoring")?;
        Ok(())
    }

    /// File contents at a revision, or None if it isn't there or isn't text.
    fn file_at(&self, rev: &str, rel_path: &str) -> Option<String> {
        let bytes = self
            .jj_bytes(&["file", "show", "-r", rev, "--", &file_pattern(rel_path)])
            .ok()?;
        String::from_utf8(bytes).ok()
    }

    /// What changed between two revisions, file by file. `from`/`to` are
    /// commit ids, change ids, or `@` (the working draft).
    pub fn diff(&self, from: &str, to: &str, rel_path: Option<&str>) -> AnyResult<Diff> {
        check_rev(from)?;
        check_rev(to)?;
        let template = r#"status ++ "\x1f" ++ source.path().display() ++ "\x1f" ++ target.path().display() ++ "\n""#;
        let mut args = vec!["diff", "--from", from, "--to", to, "-T", template];
        let pattern;
        if let Some(p) = rel_path {
            pattern = file_pattern(p);
            args.extend(["--", pattern.as_str()]);
        }
        let listing = self.jj(&args).context("comparing versions")?;
        let mut files = Vec::new();
        for line in listing.lines() {
            let f: Vec<&str> = line.split('\u{1f}').collect();
            if f.len() < 3 {
                continue;
            }
            let (status, source, target) = (f[0], f[1], f[2]);
            let old = if status == "added" {
                Some(String::new())
            } else {
                self.file_at(from, source)
            };
            let new = if status == "removed" {
                Some(String::new())
            } else {
                self.file_at(to, target)
            };
            let (paragraphs, words_added, words_removed, binary) = match (old, new) {
                (Some(o), Some(n)) => {
                    let (p, a, r) = diff_text(&o, &n);
                    (p, a, r, false)
                }
                _ => (Vec::new(), 0, 0, true),
            };
            files.push(FileDiff {
                status: status.into(),
                path: target.into(),
                old_path: source.into(),
                binary,
                words_added,
                words_removed,
                paragraphs,
            });
        }
        Ok(Diff { files })
    }
}

fn count_words(s: &str) -> usize {
    s.split_whitespace().count()
}

fn segment_tag(tag: similar::ChangeTag) -> SegmentTag {
    match tag {
        similar::ChangeTag::Equal => SegmentTag::Equal,
        similar::ChangeTag::Insert => SegmentTag::Insert,
        similar::ChangeTag::Delete => SegmentTag::Delete,
    }
}

/// Word counts accumulated while diffing.
#[derive(Default)]
struct Tally {
    added: usize,
    removed: usize,
    paragraphs: Vec<Paragraph>,
}

impl Tally {
    /// A whole paragraph kept, inserted, or deleted.
    fn whole(&mut self, tag: SegmentTag, text: &str) {
        if text.trim().is_empty() {
            return; // blank separator lines carry no prose
        }
        let ptag = match tag {
            SegmentTag::Insert => {
                self.added += count_words(text);
                ParagraphTag::Insert
            }
            SegmentTag::Delete => {
                self.removed += count_words(text);
                ParagraphTag::Delete
            }
            SegmentTag::Equal => ParagraphTag::Equal,
        };
        self.paragraphs.push(Paragraph {
            tag: ptag,
            segments: vec![(tag, text.to_string())],
        });
    }
}

/// Prose diff of one file, track-changes style. Paragraphs (lines) are
/// compared; a rewritten paragraph becomes one `modify` paragraph whose
/// segments mark the inserted and deleted words.
fn diff_text(old: &str, new: &str) -> (Vec<Paragraph>, usize, usize) {
    use similar::{DiffOp, TextDiff};
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let diff = TextDiff::configure()
        .algorithm(similar::Algorithm::Patience)
        .diff_slices(&old_lines, &new_lines);
    let mut t = Tally::default();
    for op in diff.ops() {
        match *op {
            DiffOp::Equal { old_index, len, .. } => {
                for line in &old_lines[old_index..old_index + len] {
                    t.whole(SegmentTag::Equal, line);
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                for line in &old_lines[old_index..old_index + old_len] {
                    t.whole(SegmentTag::Delete, line);
                }
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for line in &new_lines[new_index..new_index + new_len] {
                    t.whole(SegmentTag::Insert, line);
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                // Pair rewritten paragraphs in order; leftovers are whole
                // deletions or insertions. A pair that shares too little is
                // really a cut plus a new paragraph, and word-diffing it
                // would read as noise.
                let pairs = old_len.min(new_len);
                for i in 0..pairs {
                    let (o, n) = (old_lines[old_index + i], new_lines[new_index + i]);
                    let words = TextDiff::configure()
                        .algorithm(similar::Algorithm::Patience)
                        .diff_words(o, n);
                    if words.ratio() < REWRITE_SIMILARITY {
                        t.whole(SegmentTag::Delete, o);
                        t.whole(SegmentTag::Insert, n);
                        continue;
                    }
                    let mut segments: Vec<(SegmentTag, String)> = Vec::new();
                    for change in words.iter_all_changes() {
                        let tag = segment_tag(change.tag());
                        let text = change.value();
                        match tag {
                            SegmentTag::Insert => t.added += count_words(text),
                            SegmentTag::Delete => t.removed += count_words(text),
                            SegmentTag::Equal => {}
                        }
                        // Merge runs so the frontend gets few, readable spans.
                        match segments.last_mut() {
                            Some((last, s)) if *last == tag => s.push_str(text),
                            _ => segments.push((tag, text.to_string())),
                        }
                    }
                    t.paragraphs.push(Paragraph {
                        tag: ParagraphTag::Modify,
                        segments,
                    });
                }
                for line in &old_lines[old_index + pairs..old_index + old_len] {
                    t.whole(SegmentTag::Delete, line);
                }
                for line in &new_lines[new_index + pairs..new_index + new_len] {
                    t.whole(SegmentTag::Insert, line);
                }
            }
        }
    }
    (t.paragraphs, t.added, t.removed)
}

#[cfg(test)]
mod tests {
    use super::diff_text;

    fn tags(old: &str, new: &str) -> Vec<String> {
        diff_text(old, new)
            .0
            .iter()
            .map(|p| {
                serde_json::to_value(p.tag)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn light_edit_is_tracked_in_place() {
        let (paras, added, removed) = diff_text(
            "The fog came in off the water.\n",
            "The fog rolled in off the water.\n",
        );
        assert_eq!(paras.len(), 1);
        assert_eq!(paras[0].tag, super::ParagraphTag::Modify);
        assert_eq!((added, removed), (1, 1));
    }

    #[test]
    fn unrelated_replacement_is_cut_and_insert() {
        assert_eq!(
            tags(
                "The widow sold eels from a barrel near the steps.\n",
                "She counted the rings in silence.\n"
            ),
            vec!["delete", "insert"]
        );
    }

    #[test]
    fn blank_lines_are_not_paragraphs() {
        assert_eq!(tags("a\n\nb\n", "a\n\n\nb\n"), vec!["equal", "equal"]);
    }
}
