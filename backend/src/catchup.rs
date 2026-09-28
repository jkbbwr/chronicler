//! "Catch me up": a read-only briefing for a writer coming back to a scene
//! after a break. Code gathers everything factual — where the text stops,
//! the scene's details, the threads and margin notes around it, when the
//! writer last worked — and one model call writes only the "story so far",
//! from the scenes up to and including this one (never anything later).
//!
//! Like every agent job, it never writes to the manuscript.

use crate::agents::{Fact, ledger_by_scene, one_shot};
use crate::app::App;
use crate::book::{self, display_name};
use crate::fsx::RelPath;
use crate::rpc::invalid;
use crate::story::{self, Note};
use crate::{ai, codex, journal, stats};
use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use ts_rs::TS;

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatchUp {
    pub file: String,
    /// The chapter (folder path, " › "-joined; "" for a loose scene).
    pub chapter: String,
    /// 1-based position in reading order, and the number of scenes.
    pub position: usize,
    pub total: usize,
    /// The model's "story so far" ("" unless `summary` is "ready").
    pub story_so_far: String,
    /// ready | pending (ask again with `summary: true`) | no_ai | failed
    pub summary: String,
    /// Why the summary failed, when it did.
    pub summary_error: String,
    /// Scenes up to here with neither a synopsis nor noted facts, so the
    /// summary had little to go on for them.
    pub missing_synopses: usize,
    pub left_off: LeftOff,
    /// Plot threads running through this chapter.
    pub threads: Vec<CatchUpThread>,
    /// Margin notes still in this chapter's scenes.
    pub notes: Vec<Note>,
    pub last_worked: LastWorked,
}

/// Where the text of the current scene stops.
#[derive(Serialize, TS, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LeftOff {
    /// The scene's last paragraph(s), verbatim (margin notes removed).
    pub excerpt: String,
    /// 1-based lines the excerpt spans.
    pub line: usize,
    pub end_line: usize,
    pub words: usize,
    /// Word target (0 = none).
    pub target: u32,
    pub status: String,
    pub synopsis: String,
    pub pov: Option<String>,
    pub location: Option<String>,
    pub story_time: String,
    /// The scene has edits not yet saved (read from the journal).
    pub unsaved: bool,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatchUpThread {
    pub id: i64,
    pub name: String,
    pub color: String,
    /// This chapter's scenes it runs through, in reading order.
    pub scenes: Vec<String>,
    /// The latest scene up to and including this one that carries it.
    pub last_seen: Option<String>,
}

#[derive(Serialize, TS, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastWorked {
    /// When this scene was last changed (Unix ms; saved or unsaved).
    pub scene_at: Option<i64>,
    /// The scene most recently changed anywhere in the book, and when.
    pub latest_scene: Option<String>,
    pub latest_at: Option<i64>,
    /// The last day with words written (the writer's local date).
    pub last_day: Option<String>,
    pub last_day_words: i64,
}

const SYSTEM: &str = "You brief a novelist who is coming back to their own book after a break: \
where the story stands at the scene they are about to work on.\n\
\n\
Write two to four short paragraphs of plain prose, present tense. Compress the early book hard; \
give the current chapter and the last few scenes more room; end with the situation exactly where \
the current scene's text stops. Use the characters' names.\n\
\n\
Rules:\n\
- Use only what you are given. Never invent events and never guess what comes next.\n\
- A synopsis is the writer's plan for a scene; the scene's text is what is actually written. \
Where they differ, the text wins.\n\
- No advice, no praise, no suggestions for the text, no headings, no lists.\n\
- Output only the briefing.";

/// Scenes just before this one that get their text, not just a synopsis line.
const RECENT: usize = 3;
/// At most this many earlier scenes of the chapter get the fuller treatment.
const CHAPTER_MAX: usize = 8;
/// Text sent for a recent scene with no synopsis, and for the current scene.
const RECENT_CHARS: usize = 6_000;
const CURRENT_CHARS: usize = 12_000;
/// One line per earlier scene, and a cap on all of them together.
const LINE_CHARS: usize = 300;
const EARLIER_CHARS: usize = 12_000;
/// Facts standing in for a missing synopsis.
const FACTS_PER_SCENE: usize = 4;

fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn cache_key(rel: &str) -> String {
    format!("catch_up:{rel}")
}

fn chapter_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Margin notes out: they're the writer's asides, not the story.
fn without_notes(content: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"<!--[\s\S]*?-->").expect("valid regex")).replace_all(content, "").into_owned()
}

/// A scene's text for the prompt, bounded; long scenes keep a little of the
/// start and most of the end (what leads into what follows).
fn excerpt(content: &str, max: usize) -> String {
    let text = without_notes(content);
    let text = text.trim();
    let n = text.chars().count();
    if n <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max / 4).collect();
    let tail: String = text.chars().skip(n - (max - max / 4)).collect();
    format!("{head}\n\n[… cut for length …]\n\n{tail}")
}

/// The last paragraph(s) of prose: headings, scene breaks and notes skipped;
/// short endings pull in the paragraph before (up to three). Returns the
/// text and the 1-based lines it spans.
fn last_paragraphs(content: &str) -> (String, usize, usize) {
    let mut paras: Vec<(usize, usize, String)> = Vec::new();
    let mut cur: Option<(usize, usize, Vec<String>)> = None;
    let mut in_comment = false;
    let close = |cur: &mut Option<(usize, usize, Vec<String>)>, paras: &mut Vec<(usize, usize, String)>| {
        if let Some((a, b, lines)) = cur.take() {
            paras.push((a, b, lines.join("\n")));
        }
    };
    for (i, raw) in content.lines().enumerate() {
        // Strip notes, tracking ones that span lines.
        let mut line = String::new();
        let mut rest = raw;
        loop {
            if in_comment {
                match rest.find("-->") {
                    Some(end) => {
                        rest = &rest[end + 3..];
                        in_comment = false;
                    }
                    None => break,
                }
            } else {
                match rest.find("<!--") {
                    Some(start) => {
                        line.push_str(&rest[..start]);
                        rest = &rest[start + 4..];
                        in_comment = true;
                    }
                    None => {
                        line.push_str(rest);
                        break;
                    }
                }
            }
        }
        let t = line.trim();
        let skip = t.is_empty() || t.starts_with('#') || matches!(t, "---" | "***" | "* * *" | "⁂" | "#");
        if skip {
            close(&mut cur, &mut paras);
            continue;
        }
        let n = i + 1;
        match cur.as_mut() {
            Some((_, b, lines)) => {
                *b = n;
                lines.push(line.trim_end().to_string());
            }
            None => cur = Some((n, n, vec![line.trim_end().to_string()])),
        }
    }
    close(&mut cur, &mut paras);
    let mut picked: Vec<&(usize, usize, String)> = Vec::new();
    let mut chars = 0;
    for p in paras.iter().rev() {
        if picked.len() == 3 || (chars >= 400 && !picked.is_empty()) {
            break;
        }
        chars += p.2.chars().count();
        picked.push(p);
    }
    picked.reverse();
    match (picked.first(), picked.last()) {
        (Some(first), Some(last)) => {
            (picked.iter().map(|p| p.2.as_str()).collect::<Vec<_>>().join("\n\n"), first.0, last.1)
        }
        _ => (String::new(), 0, 0),
    }
}

fn mtime_ms(app: &App, rel: &str) -> Option<i64> {
    let m = std::fs::metadata(app.root.join(rel)).ok()?.modified().ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn facts_line(facts: Option<&Vec<Fact>>) -> Option<String> {
    let facts = facts.filter(|f| !f.is_empty())?;
    Some(facts.iter().take(FACTS_PER_SCENE).map(|f| f.fact.trim()).collect::<Vec<_>>().join(" "))
}

/// Everything factual, plus the story so far when `summary` is set (and AI
/// is usable). A still-current summary comes from the cache either way,
/// unless `refresh`.
pub async fn catch_up(app: &App, rel: &RelPath, summary: bool, refresh: bool) -> Result<CatchUp> {
    let rel = rel.as_str().to_string();
    let order = book::reading_order(app);
    let Some(idx) = order.iter().position(|o| *o == rel) else {
        return Err(invalid("Catch me up works on manuscript scenes"));
    };
    let chapter = chapter_of(&rel).to_string();
    let chapter_scenes: Vec<&String> = order.iter().filter(|s| chapter_of(s) == chapter).collect();

    // Unsaved edits count: the journal holds them.
    let journal: HashMap<String, (String, i64)> =
        journal::read(app).unwrap_or_default().into_iter().map(|e| (e.path, (e.content, e.saved_at))).collect();
    let read = |path: &str| -> Option<String> {
        journal.get(path).map(|(c, _)| c.clone()).or_else(|| std::fs::read_to_string(app.root.join(path)).ok())
    };
    let content = read(&rel).unwrap_or_default();

    let (details, entities, all_threads, by_scene, last_day) = app.db.with(|c| {
        let last_day: Option<(String, i64)> = c
            .query_row(
                "SELECT date, latest - start FROM writing_days WHERE latest != start ORDER BY date DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        Ok((story::all_details(c)?, codex::list_entities(c)?, story::threads(c)?, ledger_by_scene(c)?, last_day))
    })?;
    let details: HashMap<&str, &story::SceneDetails> = details.iter().map(|d| (d.file.as_str(), d)).collect();
    let name = |id: Option<i64>| id.and_then(|id| entities.iter().find(|e| e.id == id)).map(|e| e.name.clone());

    // Where you left off.
    let (excerpt_text, line, end_line) = last_paragraphs(&content);
    let d = details.get(rel.as_str());
    let left_off = LeftOff {
        excerpt: excerpt_text,
        line,
        end_line,
        words: stats::count_words(&content),
        target: d.map_or(0, |d| d.target),
        status: d.map(|d| d.status.clone()).unwrap_or_default(),
        synopsis: d.map(|d| d.synopsis.trim().to_string()).unwrap_or_default(),
        pov: name(d.and_then(|d| d.pov)),
        location: name(d.and_then(|d| d.location)),
        story_time: d.map(|d| d.story_time.trim().to_string()).unwrap_or_default(),
        unsaved: journal.contains_key(&rel),
    };

    // Threads through this chapter.
    let threads = all_threads
        .iter()
        .filter_map(|t| {
            let carries = |s: &str| details.get(s).is_some_and(|d| d.threads.contains(&t.id));
            let scenes: Vec<String> = chapter_scenes.iter().filter(|s| carries(s)).map(|s| s.to_string()).collect();
            if scenes.is_empty() {
                return None;
            }
            let last_seen = order[..=idx].iter().rev().find(|s| carries(s)).cloned();
            Some(CatchUpThread { id: t.id, name: t.name.clone(), color: t.color.clone(), scenes, last_seen })
        })
        .collect();

    // Margin notes in this chapter.
    let notes: Vec<Note> = chapter_scenes.iter().flat_map(|s| story::notes_in(s, &read(s).unwrap_or_default())).collect();

    // When you last worked.
    let changed = |path: &str| -> Option<i64> {
        let saved = mtime_ms(app, path);
        let unsaved = journal.get(path).map(|(_, at)| *at);
        saved.max(unsaved)
    };
    let latest = order.iter().filter_map(|s| changed(s).map(|at| (s, at))).max_by_key(|(_, at)| *at);
    let last_worked = LastWorked {
        scene_at: changed(&rel),
        latest_scene: latest.map(|(s, _)| s.clone()),
        latest_at: latest.map(|(_, at)| at),
        last_day: last_day.as_ref().map(|(d, _)| d.clone()),
        last_day_words: last_day.map_or(0, |(_, w)| w),
    };

    // The story so far: the prompt, from scenes up to and including this one.
    let synopsis_of = |s: &str| details.get(s).map(|d| d.synopsis.trim().to_string()).filter(|s| !s.is_empty());
    let labels = story::detail_labels(app);
    let recent_from = {
        let chapter_start = order[..idx].iter().rposition(|s| chapter_of(s) != chapter).map_or(0, |i| i + 1);
        chapter_start.max(idx.saturating_sub(CHAPTER_MAX)).min(idx.saturating_sub(RECENT))
    };
    let mut missing = 0usize;
    let mut earlier: Vec<String> = Vec::new();
    for s in &order[..recent_from] {
        let body = match synopsis_of(s).or_else(|| facts_line(by_scene.get(s))) {
            Some(b) => b,
            None => {
                missing += 1;
                "(no synopsis yet)".into()
            }
        };
        let place = if chapter_of(s).is_empty() { String::new() } else { format!("{} › ", chapter_of(s).replace('/', " › ")) };
        earlier.push(truncate(&format!("- {place}{}: {}", display_name(s), body.replace('\n', " ")), LINE_CHARS));
    }
    let mut dropped = 0;
    while earlier.iter().map(|l| l.len() + 1).sum::<usize>() > EARLIER_CHARS && !earlier.is_empty() {
        earlier.remove(0);
        dropped += 1;
    }
    let mut prompt = String::new();
    let brief = book::brief_text(&book::info(app));
    if !brief.is_empty() {
        prompt.push_str(&format!("# About this book\n{brief}\n\n"));
    }
    if !earlier.is_empty() || dropped > 0 {
        prompt.push_str("# Earlier in the book (one line per scene)\n");
        if dropped > 0 {
            prompt.push_str(&format!("(the first {dropped} scenes are left out for length)\n"));
        }
        prompt.push_str(&earlier.join("\n"));
        prompt.push_str("\n\n");
    }
    if recent_from < idx {
        prompt.push_str("# The scenes just before\n");
        for s in &order[recent_from..idx] {
            let label = labels.get(s).map(|l| format!(" ({l})")).unwrap_or_default();
            prompt.push_str(&format!("## {} — {}{label}\n", chapter_of(s).replace('/', " › "), display_name(s)));
            match synopsis_of(s) {
                Some(syn) => prompt.push_str(&format!("{syn}\n\n")),
                None => {
                    let text = read(s).unwrap_or_default();
                    if text.trim().is_empty() {
                        missing += 1;
                        prompt.push_str("(empty)\n\n");
                    } else {
                        prompt.push_str(&format!("{}\n\n", excerpt(&text, RECENT_CHARS)));
                    }
                }
            }
        }
    }
    let label = labels.get(&rel).map(|l| format!(" ({l})")).unwrap_or_default();
    prompt.push_str(&format!(
        "# The current scene: {} — {}{label}, scene {} of {}\n",
        chapter_of(&rel).replace('/', " › "),
        display_name(&rel),
        idx + 1,
        order.len()
    ));
    if let Some(syn) = synopsis_of(&rel) {
        prompt.push_str(&format!("The writer's plan: {syn}\n"));
    }
    let text = excerpt(&content, CURRENT_CHARS);
    if text.is_empty() {
        prompt.push_str("(nothing written yet)\n");
    } else {
        prompt.push_str(&format!("The text so far:\n{text}\n"));
    }

    let mut out = CatchUp {
        file: rel.clone(),
        chapter: chapter.replace('/', " › "),
        position: idx + 1,
        total: order.len(),
        story_so_far: String::new(),
        summary: "no_ai".into(),
        summary_error: String::new(),
        missing_synopses: missing,
        left_off,
        threads,
        notes,
        last_worked,
    };
    if !ai::usable(app) {
        return Ok(out);
    }
    let model = ai::config(app).model_for(ai::Task::CatchUp).to_string();
    let signature = hash(&format!("{model}\u{1}{SYSTEM}\u{1}{prompt}"));
    let key = cache_key(&rel);
    let cached = app
        .db
        .get_setting(&key)?
        .and_then(|v| v.split_once('\u{1}').map(|(s, t)| (s.to_string(), t.to_string())))
        .filter(|(s, _)| *s == signature)
        .map(|(_, t)| t);
    if let Some(text) = cached.filter(|_| !refresh) {
        out.story_so_far = text;
        out.summary = "ready".into();
        return Ok(out);
    }
    if !summary {
        out.summary = "pending".into();
        return Ok(out);
    }
    match one_shot(app, ai::Task::CatchUp, SYSTEM, &prompt).await {
        Ok(text) => {
            let text = text.trim().to_string();
            app.db.set_setting(&key, &format!("{signature}\u{1}{text}"))?;
            out.story_so_far = text;
            out.summary = "ready".into();
        }
        Err(e) => {
            out.summary = "failed".into();
            out.summary_error = format!("{e:#}");
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_paragraphs_skip_notes_and_headings() {
        let text = "# Title\n\nFirst para.\n\nA long one that goes on. <!-- fix -->\nStill going.\n\n<!-- a note\nover lines -->\n\n* * *\n";
        let (t, a, b) = last_paragraphs(text);
        assert_eq!(t, "First para.\n\nA long one that goes on.\nStill going.");
        assert_eq!((a, b), (3, 6));
        let long = "x".repeat(500);
        let (t, a, _) = last_paragraphs(&format!("Earlier.\n\n{long}\n"));
        assert_eq!((t, a), (long, 3));
        assert_eq!(last_paragraphs("# Only a heading\n").0, "");
    }

    #[test]
    fn excerpts_keep_the_end() {
        let text = format!("{}{}", "a".repeat(100), "b".repeat(100));
        let e = excerpt(&text, 40);
        assert!(e.starts_with("aaaaaaaaaa\n") && e.ends_with(&"b".repeat(30)), "{e}");
        assert_eq!(excerpt("short <!-- note --> text", 100), "short  text");
    }
}
