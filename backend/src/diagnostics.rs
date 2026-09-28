//! Prose diagnostics, all from harper (embedded, no downloads):
//! - **spelling** (red): harper's curated dictionary merged with the
//!   project's custom words and every codex name/alias, checked in the
//!   project's chosen dialect. Suggestions are computed lazily, only when the
//!   writer asks for a fix (`diag/suggest`).
//! - **grammar** (blue) and **style** (info): harper's full curated lint set.
//! - **style** filter words from the project's `styleWords` setting.
//!
//! The project db holds the custom dictionary, the dialect, and per-position
//! rule suppressions.

use crate::app::App;
use crate::fsx::RelPath;
use anyhow::Result;
use harper_core::linting::{LintGroup, LintKind, Suggestion};
use harper_core::spell::{Dictionary, FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{
    Dialect as HarperDialect, DictWordMetadata, Document, NounData, TokenKind, TokenStringExt,
};
use parking_lot::{MappedMutexGuard, Mutex, MutexGuard};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use ts_rs::TS;

// ---------- Wire types ----------

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    #[default]
    American,
    British,
    Australian,
    Canadian,
    Indian,
}

impl Dialect {
    fn harper(self) -> HarperDialect {
        match self {
            Dialect::American => HarperDialect::American,
            Dialect::British => HarperDialect::British,
            Dialect::Australian => HarperDialect::Australian,
            Dialect::Canadian => HarperDialect::Canadian,
            Dialect::Indian => HarperDialect::Indian,
        }
    }
}

#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagSource {
    Spelling,
    Grammar,
    Style,
    Assistant,
}

#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One problem in one scene. Positions are 1-based lines and 0-based
/// character (not byte) columns, end exclusive.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub source: DiagSource,
    pub severity: Severity,
    pub file: String,
    pub line: usize,
    pub col_start: usize,
    pub col_end: usize,
    /// The flagged text.
    pub text: String,
    pub message: String,
    /// Stable rule key, used by `diag/ignore`.
    pub rule_id: String,
    /// Ready-made fixes. Always empty for spelling — ask `diag/suggest`.
    pub replacements: Vec<String>,
    /// Set for assistant findings (`agents/finding_dismiss`).
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finding_id: Option<i64>,
}

pub const SPELLING_RULE: &str = "spelling";
const DIALECT_KEY: &str = "spellingDialect";

pub fn get_dialect(conn: &Connection) -> Result<Dialect> {
    Ok(crate::db::get_setting(conn, DIALECT_KEY)?
        .and_then(|s| serde_json::from_value(serde_json::Value::String(s)).ok())
        .unwrap_or_default())
}

pub fn set_dialect(conn: &Connection, dialect: Dialect) -> Result<()> {
    let v = serde_json::to_value(dialect)?;
    crate::db::set_setting(conn, DIALECT_KEY, v.as_str().unwrap_or("american"))
}

// ---------- Project word lists (loaded once per check) ----------

/// Everything a check needs from the db, read in one go.
pub struct CheckEnv {
    dialect: Dialect,
    /// Custom dictionary words and codex name tokens, as written.
    words: BTreeSet<String>,
    /// The same, lowercased, for case-insensitive acceptance.
    words_lower: HashSet<String>,
    suppressed: HashSet<(String, String, String)>,
    filters: Vec<String>,
    /// Codex name and alias tokens, lowercased (never echoes or tics).
    names_lower: HashSet<String>,
    /// Which local style checks are on.
    style: StyleChecks,
}

const DEFAULT_FILTER_WORDS: &[&str] = &[
    "just",
    "really",
    "very",
    "suddenly",
    "somehow",
    "actually",
    "quite",
    "rather",
    "simply",
    "basically",
    "definitely",
    "totally",
];

fn name_tokens(name: &str) -> impl Iterator<Item = &str> {
    name.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '\u{2019}'))
        .map(|t| t.trim_matches(|c| c == '\'' || c == '\u{2019}'))
        .filter(|t| !t.is_empty())
}

impl CheckEnv {
    pub fn load(conn: &Connection) -> Result<CheckEnv> {
        let mut words = BTreeSet::new();
        for w in conn
            .prepare("SELECT word FROM dictionary")?
            .query_map([], |r| r.get::<_, String>(0))?
        {
            let w = w?;
            if !w.trim().is_empty() {
                words.insert(w.trim().to_string());
            }
        }
        // Codex names and aliases are never misspellings.
        let mut names_lower = HashSet::new();
        for e in crate::codex::list_entities(conn)? {
            for n in e.names() {
                words.extend(name_tokens(n).map(String::from));
                names_lower.extend(name_tokens(n).map(|t| t.to_lowercase()));
            }
        }
        let words_lower = words.iter().map(|w| w.to_lowercase()).collect();
        let suppressed = conn
            .prepare("SELECT rule_id, file, text FROM suppressions")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let filters = crate::db::get_setting(conn, "styleWords")?
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_else(|| DEFAULT_FILTER_WORDS.iter().map(|s| s.to_string()).collect())
            .into_iter()
            .map(|w| w.to_lowercase())
            .collect();
        Ok(CheckEnv {
            dialect: get_dialect(conn)?,
            words,
            words_lower,
            suppressed,
            filters,
            names_lower,
            style: get_style(conn)?,
        })
    }

    fn words_key(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.words.hash(&mut h);
        h.finish()
    }

    fn is_suppressed(&self, rule: &str, file: &str, text: &str) -> bool {
        self.suppressed
            .contains(&(rule.to_string(), file.to_string(), text.to_string()))
            || self
                .suppressed
                .contains(&(rule.to_string(), "*".to_string(), String::new()))
    }
}

// ---------- The engine ----------

struct Engine {
    dialect: Dialect,
    words_key: u64,
    dict: Arc<MergedDictionary>,
    lints: LintGroup,
}

impl Engine {
    fn build(env: &CheckEnv) -> Engine {
        let mut custom = MutableDictionary::new();
        let proper = DictWordMetadata {
            noun: Some(NounData {
                is_proper: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        custom.extend_words(env.words.iter().flat_map(|w| {
            let lower = w.to_lowercase();
            let mut v = vec![(w.chars().collect::<Vec<_>>(), proper.clone())];
            if lower != *w {
                v.push((lower.chars().collect(), proper.clone()));
            }
            v
        }));
        let mut dict = MergedDictionary::new();
        dict.add_dictionary(FstDictionary::curated());
        dict.add_dictionary(Arc::new(custom));
        let dict = Arc::new(dict);
        let mut lints = LintGroup::new_curated(dict.clone(), env.dialect.harper());
        // Spelling runs as our own pass: codex-aware, with lazy suggestions.
        lints.config.set_rule_enabled("SpellCheck", false);
        Engine {
            dialect: env.dialect,
            words_key: env.words_key(),
            dict,
            lints,
        }
    }
}

/// The lazily built harper engine, rebuilt when the dialect or the project's
/// word list changes.
#[derive(Default)]
pub struct Lang {
    engine: Mutex<Option<Engine>>,
}

impl Lang {
    pub fn is_ready(&self) -> bool {
        self.engine.lock().is_some()
    }

    fn engine(&self, env: &CheckEnv) -> MappedMutexGuard<'_, Engine> {
        let mut guard = self.engine.lock();
        let stale = guard
            .as_ref()
            .is_none_or(|e| e.dialect != env.dialect || e.words_key != env.words_key());
        if stale {
            *guard = Some(Engine::build(env));
        }
        MutexGuard::map(guard, |g| g.as_mut().expect("engine just built"))
    }
}

/// Build the engine now so the first real check is fast.
pub fn warm(app: &App) -> Result<()> {
    let env = app.db.with(CheckEnv::load)?;
    drop(app.lang.engine(&env));
    Ok(())
}

// ---------- Checking ----------

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c == '\'' || c == '\u{2019}'
}

fn strip_word(w: &str) -> &str {
    w.trim_matches(|c: char| c == '\'' || c == '\u{2019}')
}

/// Blank out `<!-- ... -->` regions (state carries across lines) so comments
/// are never checked. Char count is preserved for offsets.
fn mask_html_comments(line: &str, in_comment: &mut bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = vec![' '; chars.len()];
    let mut i = 0;
    while i < chars.len() {
        if *in_comment {
            if chars[i..].starts_with(&['-', '-', '>']) {
                *in_comment = false;
                i += 3;
            } else {
                i += 1;
            }
        } else if chars[i..].starts_with(&['<', '!', '-', '-']) {
            *in_comment = true;
            i += 4;
        } else {
            out[i] = chars[i];
            i += 1;
        }
    }
    out.into_iter().collect()
}

/// The document with fenced code and HTML comments blanked (char counts
/// preserved), split into lines.
fn masked_lines(content: &str) -> Vec<String> {
    let mut in_fence = false;
    let mut in_comment = false;
    content
        .lines()
        .map(|raw| {
            let trimmed = raw.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_fence = !in_fence;
                return " ".repeat(raw.chars().count());
            }
            if in_fence {
                return " ".repeat(raw.chars().count());
            }
            mask_html_comments(raw, &mut in_comment)
        })
        .collect()
}

/// Taste-level lint kinds render as style hints; everything else (typos,
/// agreement, word choice, punctuation…) is a grammar warning.
fn source_for(kind: LintKind) -> (DiagSource, Severity) {
    match kind {
        LintKind::Style | LintKind::Readability | LintKind::Enhancement | LintKind::Redundancy => {
            (DiagSource::Style, Severity::Info)
        }
        _ => (DiagSource::Grammar, Severity::Warning),
    }
}

/// Is this word spelled correctly for the dialect?
fn word_ok(
    engine: &Engine,
    env: &CheckEnv,
    word: &[char],
    meta: Option<&DictWordMetadata>,
) -> bool {
    let dialect = env.dialect.harper();
    let known = |w: &[char]| {
        let lower: Vec<char> = w.iter().flat_map(|c| c.to_lowercase()).collect();
        engine.dict.contains_exact_word(w) || engine.dict.contains_exact_word(&lower)
    };
    if meta.is_some_and(|m| m.dialects.is_dialect_enabled(dialect)) && known(word) {
        return true;
    }
    let s: String = word.iter().collect();
    let s = strip_word(&s);
    if env.words_lower.contains(&s.to_lowercase()) {
        return true;
    }
    // Possessives: "Marr's" is fine if "Marr" is.
    if let Some(base) = s.strip_suffix("'s").or_else(|| s.strip_suffix("\u{2019}s")) {
        let base_chars: Vec<char> = base.chars().collect();
        if env.words_lower.contains(&base.to_lowercase()) {
            return true;
        }
        if let Some(m) = engine.dict.get_word_metadata(&base_chars) {
            return m.dialects.is_dialect_enabled(dialect) && known(&base_chars);
        }
    }
    false
}

/// Check one document's text.
fn check_text(engine: &mut Engine, env: &CheckEnv, rel: &str, content: &str) -> Vec<Diagnostic> {
    let lines = masked_lines(content);
    let clean = lines.join("\n");
    let chars: Vec<char> = clean.chars().collect();
    let mut line_starts = Vec::with_capacity(lines.len());
    let mut off = 0usize;
    for l in &lines {
        line_starts.push(off);
        off += l.chars().count() + 1;
    }
    // Char span -> (0-based line, col start, col end clipped to the line).
    let locate = |start: usize, end: usize| -> Option<(usize, usize, usize)> {
        if start >= chars.len() {
            return None;
        }
        let idx = line_starts
            .partition_point(|&s| s <= start)
            .checked_sub(1)?;
        let line_len = lines[idx].chars().count();
        let col_start = start - line_starts[idx];
        let col_end = (end.max(start) - line_starts[idx]).min(line_len);
        Some((idx, col_start, col_end.max(col_start)))
    };
    let text_of = |start: usize, end: usize| {
        chars[start..end.min(chars.len())]
            .iter()
            .collect::<String>()
    };

    let mut diags = Vec::new();
    let doc = Document::new_markdown_default(&clean, &*engine.dict);

    // ---- Spelling ----
    for word in doc.iter_words() {
        let content = doc.get_span_content(&word.span);
        if content.len() < 2 || !content[0].is_alphabetic() {
            continue;
        }
        let meta = match &word.kind {
            TokenKind::Word(m) => m.as_ref(),
            _ => None,
        };
        if word_ok(engine, env, content, meta) {
            continue;
        }
        let text: String = content.iter().collect();
        let text = strip_word(&text).to_string();
        if env.is_suppressed(SPELLING_RULE, rel, &text) {
            continue;
        }
        let Some((line, col_start, col_end)) = locate(word.span.start, word.span.end) else {
            continue;
        };
        diags.push(Diagnostic {
            source: DiagSource::Spelling,
            severity: Severity::Error,
            file: rel.to_string(),
            line: line + 1,
            col_start,
            col_end,
            message: format!("Unknown word “{text}”"),
            text,
            rule_id: SPELLING_RULE.into(),
            replacements: vec![],
            finding_id: None,
        });
    }

    // ---- Grammar & style: harper's curated lints ----
    for (name, lints) in engine.lints.organized_lints(&doc) {
        let rule_id = format!("HARPER/{name}");
        for lint in lints {
            let Some((line, col_start, col_end)) = locate(lint.span.start, lint.span.end) else {
                continue;
            };
            let text = text_of(lint.span.start, lint.span.end);
            if env.is_suppressed(&rule_id, rel, &text) {
                continue;
            }
            let (source, severity) = source_for(lint.lint_kind);
            let replacements = lint
                .suggestions
                .iter()
                .map(|s| match s {
                    Suggestion::ReplaceWith(c) => c.iter().collect(),
                    Suggestion::InsertAfter(c) => format!("{text}{}", c.iter().collect::<String>()),
                    Suggestion::Remove => String::new(),
                })
                .take(3)
                .collect();
            diags.push(Diagnostic {
                source,
                severity,
                file: rel.to_string(),
                line: line + 1,
                col_start,
                col_end,
                text,
                message: lint.message,
                rule_id: rule_id.clone(),
                replacements,
                finding_id: None,
            });
        }
    }

    // ---- Style: fiction crutch/filter words ----
    for (line_no, line) in lines.iter().enumerate().filter(|_| env.style.filter_words) {
        let lc: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < lc.len() {
            if !is_word_char(lc[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < lc.len() && is_word_char(lc[i]) {
                i += 1;
            }
            let raw: String = lc[start..i].iter().collect();
            let word = strip_word(&raw).to_lowercase();
            if !env.filters.contains(&word) {
                continue;
            }
            let rule_id = format!("STYLE/FILTER/{}", word.to_uppercase());
            if env.is_suppressed(&rule_id, rel, &word) {
                continue;
            }
            diags.push(Diagnostic {
                source: DiagSource::Style,
                severity: Severity::Info,
                file: rel.to_string(),
                line: line_no + 1,
                col_start: start,
                col_end: i,
                message: format!("Filter word “{word}” — often cuttable"),
                text: word,
                rule_id,
                replacements: vec![],
                finding_id: None,
            });
        }
    }
    diags.extend(style_diags(env, rel, &lines));
    diags.sort_by_key(|d| (d.line, d.col_start));
    diags
}

// ---------- Local style checks (no AI) ----------

/// Which local style checks run, per project. Missing fields default on.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct StyleChecks {
    /// The same distinctive word again within a few lines.
    pub echoes: bool,
    /// "said softly": an -ly adverb on a dialogue tag.
    pub adverb_tags: bool,
    /// Runs of sentences that are all about the same length.
    pub rhythm: bool,
    /// Filter words from the `styleWords` list.
    pub filter_words: bool,
}

impl Default for StyleChecks {
    fn default() -> Self {
        StyleChecks {
            echoes: true,
            adverb_tags: true,
            rhythm: true,
            filter_words: true,
        }
    }
}

const STYLE_KEY: &str = "styleChecks";

pub fn get_style(conn: &Connection) -> Result<StyleChecks> {
    Ok(crate::db::get_setting(conn, STYLE_KEY)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

pub fn set_style(conn: &Connection, style: StyleChecks) -> Result<()> {
    crate::db::set_setting(conn, STYLE_KEY, &serde_json::to_string(&style)?)
}

pub const ECHO_RULE: &str = "STYLE/ECHO";
pub const ADVERB_TAG_RULE: &str = "STYLE/ADVERB_TAG";
pub const RHYTHM_RULE: &str = "STYLE/RHYTHM";

/// An echo is the same word again within this many words.
const ECHO_WINDOW: usize = 50;
/// Words shorter than this never echo.
const ECHO_MIN_LEN: usize = 4;
/// A monotone run is at least this many sentences…
const RHYTHM_RUN: usize = 5;
/// …whose word counts all lie within this many words of each other.
const RHYTHM_SPREAD: usize = 3;

/// Function words and everyday words too common to count as echoes or tics.
const STOPWORDS: &[&str] = &[
    "a", "about", "above", "across", "after", "again", "against", "all", "almost", "along",
    "already", "also", "although", "always", "among", "an", "and", "another", "any", "anyone",
    "anything", "are", "around", "as", "at", "away", "back", "be", "because", "been", "before",
    "behind", "being", "below", "beneath", "beside", "between", "beyond", "both", "but", "by",
    "came", "can", "cannot", "come", "could", "did", "does", "doing", "done", "down", "during",
    "each", "either", "else", "enough", "even", "ever", "every", "everyone", "everything", "few",
    "for", "from", "further", "get", "gets", "getting", "give", "given", "goes", "going", "gone",
    "good", "got", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
    "himself", "his", "how", "however", "i", "if", "in", "inside", "into", "is", "it", "its",
    "itself", "just", "know", "knew", "known", "last", "least", "less", "like", "little", "made",
    "make", "makes", "many", "may", "me", "might", "more", "most", "much", "must", "my", "myself",
    "near", "neither", "never", "next", "no", "nobody", "none", "nor", "not", "nothing", "now",
    "of", "off", "often", "on", "once", "one", "only", "onto", "or", "other", "others", "ought",
    "our", "ours", "ourselves", "out", "outside", "over", "own", "perhaps", "put", "quite",
    "rather", "really", "same", "said", "say", "says", "see", "seen", "shall", "she", "should",
    "since", "so", "some", "someone", "something", "still", "such", "take", "taken", "than",
    "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they",
    "thing", "things", "this", "those", "though", "through", "thus", "till", "to", "together",
    "too", "took", "toward", "towards", "two", "under", "until", "up", "upon", "us", "very",
    "want", "wanted", "was", "way", "we", "well", "went", "were", "what", "whatever", "when",
    "where", "whether", "which", "while", "who", "whole", "whom", "whose", "why", "will", "with",
    "within", "without", "would", "yes", "yet", "you", "your", "yours", "yourself", "yourselves",
    "three", "first", "time", "left", "right",
];

/// Verbs that make a dialogue tag.
const TAG_VERBS: &[&str] = &[
    "said", "says", "say", "asked", "asks", "whispered", "whispers", "replied", "replies",
    "muttered", "mutters", "murmured", "murmurs", "shouted", "shouts", "yelled", "yells",
    "called", "cried", "answered", "snapped", "added", "continued", "hissed", "breathed",
    "exclaimed", "demanded", "barked", "growled", "admitted", "insisted", "repeated", "laughed",
    "stammered", "mumbled", "retorted", "sneered", "told", "tells", "spoke", "pleaded",
    "begged", "agreed", "offered", "warned", "promised", "protested", "snarled", "groaned",
];

/// Words ending in -ly that aren't adverbs.
const NOT_ADVERBS: &[&str] = &[
    "only", "family", "early", "daily", "weekly", "monthly", "yearly", "hourly", "nightly",
    "lonely", "lovely", "friendly", "unfriendly", "ugly", "holy", "belly", "jelly", "bully",
    "rally", "ally", "reply", "supply", "apply", "comply", "rely", "fly", "silly", "hilly",
    "curly", "chilly", "likely", "unlikely", "elderly", "costly", "deadly", "timely", "orderly",
    "lively", "lowly", "kindly", "manly", "womanly", "cowardly", "scholarly", "sly", "wily",
    "surly", "burly", "gnarly", "oily", "woolly", "wooly", "prickly", "smelly", "bubbly",
    "wobbly", "crumbly", "anomaly", "italy", "july", "lily", "folly", "gully", "sully",
    "dally", "tally", "multiply", "assembly", "melancholy", "homely", "comely", "ghastly",
    "ghostly", "godly", "saintly", "stately", "portly", "measly", "beastly", "leisurely",
];

/// Abbreviations whose full stop doesn't end a sentence.
const ABBREVIATIONS: &[&str] = &["mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "mt", "vs", "etc", "rev", "capt", "col", "gen", "lt", "sgt"];

/// Common crutch words and phrases for the book-level report.
const CRUTCHES: &[&str] = &[
    "just", "really", "very", "suddenly", "slightly", "began to", "started to", "seemed",
    "felt", "looked", "turned", "nodded", "smiled", "sighed", "shrugged", "that", "even",
    "quite", "somehow", "actually", "rather", "almost", "a bit", "a little", "some kind of",
    "for a moment", "in order to", "managed to", "realized", "realised", "noticed", "wondered",
    "could see", "could hear", "then", "simply", "basically", "totally", "definitely",
];

/// One word of prose, with where it sits.
#[derive(Debug, Clone)]
struct Tok {
    /// 0-based line.
    line: usize,
    /// Char columns, end exclusive.
    start: usize,
    end: usize,
    /// As written, apostrophes trimmed.
    text: String,
    lower: String,
    /// Inside double quotes.
    dialogue: bool,
    /// Only whitespace separates it from the previous word on the same line.
    tight_before: bool,
    /// Followed by . ! ? or … (before the next word).
    stop_after: bool,
    /// Last word of its sentence (computed after tokenizing).
    ends_sentence: bool,
}

fn is_heading(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

/// Words of prose in masked lines (comments and code already blanked),
/// skipping headings. Each line is a paragraph: quotes reset per line.
fn prose_tokens(lines: &[String]) -> Vec<Tok> {
    let mut toks: Vec<Tok> = Vec::new();
    for (ln, line) in lines.iter().enumerate() {
        if is_heading(line) {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut in_quote = false;
        let mut last_end: Option<usize> = None;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            match c {
                '"' => in_quote = !in_quote,
                '\u{201C}' => in_quote = true,
                '\u{201D}' => in_quote = false,
                '.' | '!' | '?' | '\u{2026}' => {
                    if let Some(t) = toks.last_mut().filter(|t| t.line == ln) {
                        let abbrev = c == '.' && ABBREVIATIONS.contains(&t.lower.as_str());
                        if !abbrev {
                            t.stop_after = true;
                        }
                    }
                }
                _ => {}
            }
            if !is_word_char(c) {
                i += 1;
                continue;
            }
            let raw_start = i;
            while i < chars.len() && is_word_char(chars[i]) {
                i += 1;
            }
            let raw: String = chars[raw_start..i].iter().collect();
            let lead = raw.chars().take_while(|&c| c == '\'' || c == '\u{2019}').count();
            let text = strip_word(&raw).to_string();
            if text.is_empty() {
                continue;
            }
            let start = raw_start + lead;
            let end = start + text.chars().count();
            let tight_before = last_end.is_some_and(|e| chars[e..start].iter().all(|c| c.is_whitespace()));
            last_end = Some(end);
            toks.push(Tok {
                line: ln,
                start,
                end,
                lower: text.to_lowercase(),
                text,
                dialogue: in_quote,
                tight_before,
                stop_after: false,
                ends_sentence: false,
            });
        }
    }
    // A sentence ends at a stop followed by a capital (so `"Why?" she
    // asked` stays one sentence), and always at the end of a paragraph.
    for i in 0..toks.len() {
        let ends = match toks.get(i + 1) {
            None => true,
            Some(next) if next.line != toks[i].line => true,
            Some(next) => toks[i].stop_after && next.text.starts_with(char::is_uppercase),
        };
        toks[i].ends_sentence = ends;
    }
    toks
}

/// Sentences as ranges into the token list.
fn sentences(toks: &[Tok]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, t) in toks.iter().enumerate() {
        if t.ends_sentence {
            out.push(start..i + 1);
            start = i + 1;
        }
    }
    out
}

/// The key a word is counted under ("lantern's" → "lantern"), or None when
/// it's too short, too common, a name, or a contraction.
fn distinctive(env: &CheckEnv, t: &Tok) -> Option<String> {
    let key = t
        .lower
        .strip_suffix("'s")
        .or_else(|| t.lower.strip_suffix("\u{2019}s"))
        .unwrap_or(&t.lower);
    if key.chars().count() < ECHO_MIN_LEN
        || key.contains(['\'', '\u{2019}'])
        || STOPWORDS.contains(&key)
        || TAG_VERBS.contains(&key)
        || env.names_lower.contains(key)
        || env.names_lower.contains(&t.lower)
    {
        return None;
    }
    Some(key.to_string())
}

fn is_ly_adverb(env: &CheckEnv, t: &Tok) -> bool {
    t.lower.ends_with("ly")
        && t.lower.chars().count() >= 5
        && !t.text.starts_with(char::is_uppercase)
        && !NOT_ADVERBS.contains(&t.lower.as_str())
        && !env.names_lower.contains(&t.lower)
}

fn style_diag(rel: &str, rule: &str, line: usize, col_start: usize, col_end: usize, text: String, message: String) -> Diagnostic {
    Diagnostic {
        source: DiagSource::Style,
        severity: Severity::Info,
        file: rel.to_string(),
        line: line + 1,
        col_start,
        col_end,
        text,
        message,
        rule_id: rule.to_string(),
        replacements: vec![],
        finding_id: None,
    }
}

/// Echoes, adverb dialogue tags and monotone rhythm, per the project's
/// switches. `lines` are already masked (comments, fenced code).
fn style_diags(env: &CheckEnv, rel: &str, lines: &[String]) -> Vec<Diagnostic> {
    let s = env.style;
    if !(s.echoes || s.adverb_tags || s.rhythm) {
        return vec![];
    }
    let toks = prose_tokens(lines);
    let span_text = |line: usize, a: usize, b: usize| -> String {
        lines[line].chars().skip(a).take(b.saturating_sub(a)).collect()
    };
    let mut out = Vec::new();

    if s.echoes {
        let mut last_seen: std::collections::HashMap<String, usize> = Default::default();
        for (i, t) in toks.iter().enumerate() {
            let Some(key) = distinctive(env, t) else { continue };
            if env.filters.contains(&key) {
                continue; // the filter-word check already flags these
            }
            if let Some(&prev) = last_seen.get(&key) {
                let gap = i - prev;
                if gap <= ECHO_WINDOW && !env.is_suppressed(ECHO_RULE, rel, &t.text) {
                    let ago = if gap == 1 { "the word before".to_string() } else { format!("{gap} words earlier") };
                    out.push(style_diag(
                        rel,
                        ECHO_RULE,
                        t.line,
                        t.start,
                        t.end,
                        t.text.clone(),
                        format!("\u{2018}{key}\u{2019} again \u{2014} used {ago}"),
                    ));
                }
            }
            last_seen.insert(key, i);
        }
    }

    if s.adverb_tags {
        for (i, t) in toks.iter().enumerate() {
            if t.dialogue || !TAG_VERBS.contains(&t.lower.as_str()) {
                continue;
            }
            let after = toks
                .get(i + 1)
                .filter(|n| n.line == t.line && n.tight_before && !n.dialogue && !t.stop_after && is_ly_adverb(env, n));
            let before = i
                .checked_sub(1)
                .map(|j| &toks[j])
                .filter(|p| p.line == t.line && t.tight_before && !p.dialogue && !p.stop_after && is_ly_adverb(env, p));
            let (a, b, adverb) = match (after, before) {
                (Some(n), _) => (t, n, n),
                (None, Some(p)) => (p, t, p),
                _ => continue,
            };
            let text = span_text(t.line, a.start, b.end);
            if env.is_suppressed(ADVERB_TAG_RULE, rel, &text) {
                continue;
            }
            out.push(style_diag(
                rel,
                ADVERB_TAG_RULE,
                t.line,
                a.start,
                b.end,
                text,
                format!(
                    "\u{201C}{}\u{201D} leans on an adverb \u{2014} let the words or an action show how it\u{2019}s said",
                    adverb.lower
                ),
            ));
        }
    }

    if s.rhythm {
        // Narration sentences only: all-dialogue sentences break a run.
        let sents: Vec<_> = sentences(&toks)
            .into_iter()
            .map(|r| {
                let narration = toks[r.clone()].iter().any(|t| !t.dialogue);
                (r, narration)
            })
            .collect();
        let mut i = 0;
        while i < sents.len() {
            if !sents[i].1 {
                i += 1;
                continue;
            }
            let (mut lo, mut hi) = (sents[i].0.len(), sents[i].0.len());
            let mut j = i + 1;
            while j < sents.len() && sents[j].1 {
                let n = sents[j].0.len();
                if n.max(hi) - n.min(lo) > RHYTHM_SPREAD {
                    break;
                }
                lo = lo.min(n);
                hi = hi.max(n);
                j += 1;
            }
            let run = j - i;
            if run < RHYTHM_RUN {
                i += 1;
                continue;
            }
            let first = &sents[i].0;
            let total: usize = sents[i..j].iter().map(|(r, _)| r.len()).sum();
            let typical = (total as f64 / run as f64).round() as usize;
            let a = &toks[first.start];
            let last = &toks[first.end - 1];
            let end = if last.line == a.line { last.end } else { lines[a.line].chars().count() };
            let text = span_text(a.line, a.start, end);
            if !env.is_suppressed(RHYTHM_RULE, rel, &text) {
                out.push(style_diag(
                    rel,
                    RHYTHM_RULE,
                    a.line,
                    a.start,
                    end,
                    text,
                    format!(
                        "{run} sentences in a row of about {typical} words each \u{2014} vary the length to change the pace"
                    ),
                ));
            }
            i = j;
        }
    }
    out
}

// ---------- The book-level prose report ----------

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProseReport {
    /// Words of prose in the manuscript (headings, notes and matter excluded).
    pub words: usize,
    /// Common crutch words and phrases that appear, most frequent first.
    pub crutch: Vec<CrutchWord>,
    /// The writer's own most-repeated distinctive words, most frequent first.
    pub overused: Vec<OverusedWord>,
    /// Sentence rhythm per scene, in reading order.
    pub scenes: Vec<SceneRhythm>,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrutchWord {
    pub word: String,
    pub count: usize,
    /// Uses per 10,000 words.
    pub per10k: f64,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverusedWord {
    pub word: String,
    pub count: usize,
    pub per10k: f64,
    /// Up to five places it's used.
    pub examples: Vec<WordExample>,
}

#[derive(Serialize, TS, Debug)]
pub struct WordExample {
    pub file: String,
    /// 1-based.
    pub line: usize,
}

#[derive(Serialize, TS, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneRhythm {
    pub file: String,
    pub sentences: usize,
    /// Mean words per sentence.
    pub avg_length: f64,
    /// Standard deviation of words per sentence (higher = more varied).
    pub stdev: f64,
}

const OVERUSED_TOP: usize = 20;
const OVERUSED_MIN: usize = 3;
const EXAMPLES_MAX: usize = 5;

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Build the report from (file, content) pairs in reading order.
fn prose_report_of(env: &CheckEnv, files: &[(String, String)]) -> ProseReport {
    let crutches: Vec<Vec<&str>> = CRUTCHES.iter().map(|c| c.split(' ').collect()).collect();
    let crutch_words: HashSet<&str> = CRUTCHES.iter().filter(|c| !c.contains(' ')).copied().collect();
    let mut crutch_counts = vec![0usize; CRUTCHES.len()];
    let mut words = 0usize;
    let mut counts: std::collections::HashMap<String, (usize, Vec<WordExample>)> = Default::default();
    let mut scenes = Vec::new();

    for (file, content) in files {
        let lines = masked_lines(content);
        let toks = prose_tokens(&lines);
        words += toks.len();
        for i in 0..toks.len() {
            for (k, phrase) in crutches.iter().enumerate() {
                if toks.len() - i >= phrase.len()
                    && phrase.iter().zip(&toks[i..]).all(|(w, t)| t.lower == *w)
                {
                    crutch_counts[k] += 1;
                }
            }
            let t = &toks[i];
            let Some(key) = distinctive(env, t) else { continue };
            if crutch_words.contains(key.as_str()) {
                continue;
            }
            let entry = counts.entry(key).or_default();
            entry.0 += 1;
            let line = t.line + 1;
            if entry.1.len() < EXAMPLES_MAX && !entry.1.iter().any(|e| e.file == *file && e.line == line) {
                entry.1.push(WordExample { file: file.clone(), line });
            }
        }
        let lens: Vec<f64> = sentences(&toks).iter().map(|r| r.len() as f64).collect();
        if !lens.is_empty() {
            let n = lens.len() as f64;
            let mean = lens.iter().sum::<f64>() / n;
            let var = lens.iter().map(|l| (l - mean).powi(2)).sum::<f64>() / n;
            scenes.push(SceneRhythm {
                file: file.clone(),
                sentences: lens.len(),
                avg_length: round1(mean),
                stdev: round1(var.sqrt()),
            });
        }
    }

    let per10k = |count: usize| if words == 0 { 0.0 } else { round1(count as f64 * 10_000.0 / words as f64) };
    let mut crutch: Vec<CrutchWord> = CRUTCHES
        .iter()
        .zip(crutch_counts)
        .filter(|(_, n)| *n > 0)
        .map(|(w, count)| CrutchWord { word: w.to_string(), count, per10k: per10k(count) })
        .collect();
    crutch.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    let mut overused: Vec<OverusedWord> = counts
        .into_iter()
        .filter(|(_, (n, _))| *n >= OVERUSED_MIN)
        .map(|(word, (count, examples))| OverusedWord { word, count, per10k: per10k(count), examples })
        .collect();
    overused.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    overused.truncate(OVERUSED_TOP);
    ProseReport { words, crutch, overused, scenes }
}

/// The book-level prose report over the manuscript in reading order.
pub fn prose_report(app: &App) -> Result<ProseReport> {
    let env = app.db.with(CheckEnv::load)?;
    let files: Vec<(String, String)> = crate::book::reading_order(app)
        .into_iter()
        .filter_map(|rel| {
            let path = RelPath::parse(&rel).ok()?;
            let content = app.read(&path).ok()?;
            Some((rel, content))
        })
        .collect();
    Ok(prose_report_of(&env, &files))
}

/// Diagnostics (engine + stored assistant findings) for a batch of files,
/// with the project word lists read once.
pub fn check_files(app: &App, files: &[String]) -> Result<BTreeMap<String, Vec<Diagnostic>>> {
    let env = app.db.with(CheckEnv::load)?;
    let mut out = BTreeMap::new();
    for rel in files {
        let Ok(rel_path) = RelPath::parse(rel) else {
            continue;
        };
        let Ok(content) = app.read(&rel_path) else {
            continue;
        };
        let mut diags = {
            let mut engine = app.lang.engine(&env);
            check_text(&mut engine, &env, rel_path.as_str(), &content)
        };
        let findings = app
            .db
            .with(|c| crate::agents::findings_for(c, rel_path.as_str(), &content))?;
        diags.extend(findings);
        out.insert(rel_path.as_str().to_string(), diags);
    }
    Ok(out)
}

/// Spelling suggestions for one word, best first, in the project's dialect.
pub fn suggest(app: &App, word: &str) -> Result<Vec<String>> {
    let env = app.db.with(CheckEnv::load)?;
    let engine = app.lang.engine(&env);
    let dialect = env.dialect.harper();
    let chars: Vec<char> = word.chars().collect();
    let capitalized = chars.first().is_some_and(|c| c.is_uppercase());
    for dist in 2..5u8 {
        let found: Vec<String> =
            harper_core::spell::suggest_correct_spelling(&chars, 200, dist, &*engine.dict)
                .into_iter()
                .filter(|w| {
                    engine
                        .dict
                        .get_word_metadata(w)
                        .is_some_and(|m| m.dialects.is_dialect_enabled(dialect))
                })
                .take(5)
                .map(|w| {
                    let mut s: String = w.iter().collect();
                    if capitalized && w.iter().skip(1).all(|c| !c.is_uppercase()) {
                        let mut cs = s.chars();
                        if let Some(first) = cs.next() {
                            s = first.to_uppercase().chain(cs).collect();
                        }
                    }
                    s
                })
                .collect();
        if !found.is_empty() {
            let mut dedup = Vec::new();
            for s in found {
                if !dedup.contains(&s) {
                    dedup.push(s);
                }
            }
            return Ok(dedup);
        }
    }
    Ok(vec![])
}

pub fn add_word(conn: &Connection, word: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO dictionary (word) VALUES (?1)",
        [word.trim()],
    )?;
    Ok(())
}

/// Words the writer added, alphabetically.
pub fn dictionary(conn: &Connection) -> Result<Vec<String>> {
    let mut words: Vec<String> = conn
        .prepare("SELECT word FROM dictionary")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    words.sort_by_key(|w: &String| w.to_lowercase());
    Ok(words)
}

pub fn remove_word(conn: &Connection, word: &str) -> Result<()> {
    conn.execute("DELETE FROM dictionary WHERE word = ?1", [word])?;
    Ok(())
}

/// Suppressions as (rule_id, file, text); file "*" means everywhere.
pub fn suppressions(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    Ok(conn
        .prepare("SELECT rule_id, file, text FROM suppressions ORDER BY file = '*' DESC, rule_id, file")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn unsuppress(conn: &Connection, rule_id: &str, file: &str, text: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM suppressions WHERE rule_id = ?1 AND file = ?2 AND text = ?3",
        rusqlite::params![rule_id, file, text],
    )?;
    Ok(())
}

pub fn suppress(conn: &Connection, rule_id: &str, file: &str, text: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO suppressions (rule_id, file, text) VALUES (?1, ?2, ?3)",
        rusqlite::params![rule_id, file, text],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn env(db: &Db) -> CheckEnv {
        db.with(CheckEnv::load).unwrap()
    }

    fn spelling(db: &Db, text: &str) -> Vec<String> {
        let env = env(db);
        let mut engine = Engine::build(&env);
        check_text(&mut engine, &env, "a.md", text)
            .into_iter()
            .filter(|d| d.source == DiagSource::Spelling)
            .map(|d| d.text)
            .collect()
    }

    #[test]
    fn dialect_controls_spelling() {
        let db = Db::open_in_memory().unwrap();
        let text = "The grey boat left the harbour at dawn.\n";
        let us = spelling(&db, text);
        assert!(us.contains(&"harbour".to_string()), "{us:?}");
        db.with(|c| set_dialect(c, Dialect::British)).unwrap();
        assert_eq!(db.with(get_dialect).unwrap(), Dialect::British);
        let uk = spelling(&db, text);
        assert!(uk.is_empty(), "British English flagged: {uk:?}");
    }

    #[test]
    fn codex_names_custom_words_and_possessives() {
        let db = Db::open_in_memory().unwrap();
        let text = "Veyra met Qorvath's cousin by the zzyzzyx.\n";
        let flagged = spelling(&db, text);
        assert!(flagged.contains(&"Veyra".to_string()), "{flagged:?}");
        db.with(|c| {
            crate::codex::create_entity(c, "Veyra Ashcombe", "character", "", &["Qorvath".into()])?;
            add_word(c, "zzyzzyx")
        })
        .unwrap();
        let flagged = spelling(&db, text);
        assert!(flagged.is_empty(), "{flagged:?}");
    }

    #[test]
    fn spans_are_char_columns_and_comments_are_skipped() {
        let db = Db::open_in_memory().unwrap();
        let text = "Ünïcödé prefix then wrdo.\n<!-- qqqqzzz -->\n```\nzzzqqq\n```\n";
        let env = env(&db);
        let mut engine = Engine::build(&env);
        let diags = check_text(&mut engine, &env, "a.md", text);
        let wrdo = diags
            .iter()
            .find(|d| d.text == "wrdo")
            .expect("typo flagged");
        assert_eq!((wrdo.line, wrdo.col_start, wrdo.col_end), (1, 20, 24));
        assert!(
            !diags
                .iter()
                .any(|d| d.text.contains("qqq") || d.text.contains("zzz"))
        );
        assert!(
            diags
                .iter()
                .all(|d| d.replacements.is_empty() || d.source != DiagSource::Spelling)
        );
    }

    #[test]
    fn grammar_lints_fire() {
        let db = Db::open_in_memory().unwrap();
        let env = env(&db);
        let mut engine = Engine::build(&env);
        let diags = check_text(
            &mut engine,
            &env,
            "a.md",
            "She has a apple and and a pear.\n",
        );
        assert!(
            diags.iter().any(|d| d.source == DiagSource::Grammar),
            "{diags:#?}"
        );
    }

    fn style(db: &Db, text: &str, rule: &str) -> Vec<Diagnostic> {
        let env = env(db);
        style_diags(&env, "a.md", &masked_lines(text))
            .into_iter()
            .filter(|d| d.rule_id == rule)
            .collect()
    }

    #[test]
    fn echoes_flag_the_second_use() {
        let db = Db::open_in_memory().unwrap();
        let text = "She lifted the lantern high. The wind pulled at her coat and the lantern swung.\n";
        let d = style(&db, text, ECHO_RULE);
        assert_eq!(d.len(), 1, "{d:#?}");
        assert_eq!(d[0].text, "lantern");
        assert_eq!((d[0].line, d[0].col_start, d[0].col_end), (1, 65, 72));
        assert_eq!(d[0].message, "\u{2018}lantern\u{2019} again \u{2014} used 10 words earlier");
        // Far enough apart: no echo.
        let far = format!(
            "The lantern glowed. {} The lantern dimmed.\n",
            "Rain fell on stones by night. ".repeat(10)
        );
        assert!(!style(&db, &far, ECHO_RULE).iter().any(|d| d.text == "lantern"));
    }

    #[test]
    fn echoes_skip_names_tags_stopwords_headings_and_comments() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| crate::codex::create_entity(c, "Maren Holt", "character", "", &[]).map(|_| ()))
            .unwrap();
        let text = "# Harbour\n\nThe harbour was quiet. \"Come,\" Maren said. \"Now,\" Maren said again. \
                    They would have gone there. <!-- harbour harbour -->\n";
        let d = style(&db, text, ECHO_RULE);
        assert!(d.is_empty(), "{d:#?}");
        // Fenced code is skipped too.
        assert!(style(&db, "```\nlantern lantern\n```\n", ECHO_RULE).is_empty());
    }

    #[test]
    fn adverb_tags_after_and_before() {
        let db = Db::open_in_memory().unwrap();
        let text = "\"Go,\" she said softly. He angrily asked for more.\n";
        let d = style(&db, text, ADVERB_TAG_RULE);
        let texts: Vec<_> = d.iter().map(|d| d.text.as_str()).collect();
        assert_eq!(texts, ["said softly", "angrily asked"], "{d:#?}");
        assert!(d[0].message.contains("softly"));
        assert_eq!((d[0].col_start, d[0].col_end), (10, 21));
    }

    #[test]
    fn adverb_tags_false_positives() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| crate::codex::create_entity(c, "Dolly", "character", "", &[]).map(|_| ()))
            .unwrap();
        let text = "\"She said sadly nothing,\" he told me. He said only this. \
                    The family said nothing. \"Go,\" said Emily. \"Stay,\" said dolly. \
                    She said. Slowly, the door opened.\n\
                    # He said quietly\n<!-- said softly -->\n";
        let d = style(&db, text, ADVERB_TAG_RULE);
        assert!(d.is_empty(), "{d:#?}");
    }

    #[test]
    fn monotone_rhythm_anchors_on_the_first_sentence() {
        let db = Db::open_in_memory().unwrap();
        let text = "Intro.\nThe rain fell on the roof. The dog slept by the fire. \
                    The kettle sang on the old stove. The clock ticked in the hall. \
                    Her tea went cold in the cup. Then everything changed, all at once, forever and for good.\n";
        let d = style(&db, text, RHYTHM_RULE);
        assert_eq!(d.len(), 1, "{d:#?}");
        assert_eq!((d[0].line, d[0].col_start), (2, 0));
        assert_eq!(d[0].text, "The rain fell on the roof");
        assert_eq!(
            d[0].message,
            "5 sentences in a row of about 6 words each \u{2014} vary the length to change the pace"
        );
        // Varied lengths: nothing.
        let varied = "It rained. The dog slept by the fire all afternoon. Cold. \
                      The kettle sang on the old iron stove in the corner of the kitchen. Tick. The end came.\n";
        assert!(style(&db, varied, RHYTHM_RULE).is_empty());
    }

    #[test]
    fn rhythm_ignores_dialogue_headings_and_abbreviations() {
        let db = Db::open_in_memory().unwrap();
        // Back-and-forth dialogue isn't narration.
        let talk = "\"Yes.\"\n\"No.\"\n\"Why?\"\n\"Because.\"\n\"Fine.\"\n\"Good.\"\n";
        assert!(style(&db, talk, RHYTHM_RULE).is_empty());
        let heads = "# One\n## Two\n# Three\n# Four\n# Five\n# Six\n";
        assert!(style(&db, heads, RHYTHM_RULE).is_empty());
        let notes = "<!--\nA b c.\nA b c.\nA b c.\nA b c.\nA b c.\n-->\n";
        assert!(style(&db, notes, RHYTHM_RULE).is_empty());
        // "Mr." doesn't end a sentence, and `"Why?" she asked` is one sentence.
        let toks = prose_tokens(&masked_lines("Mr. Hale left. \"Why?\" she asked.\n"));
        assert_eq!(sentences(&toks).len(), 2);
    }

    #[test]
    fn style_switches_and_suppressions() {
        let db = Db::open_in_memory().unwrap();
        let text = "The lantern swung. The lantern fell. \"Go,\" he said softly. It was just so.\n";
        assert_eq!(db.with(get_style).unwrap(), StyleChecks::default());
        assert_eq!(style(&db, text, ECHO_RULE).len(), 1);
        db.with(|c| suppress(c, ECHO_RULE, "a.md", "lantern")).unwrap();
        assert!(style(&db, text, ECHO_RULE).is_empty());
        assert_eq!(style(&db, text, ADVERB_TAG_RULE).len(), 1);
        db.with(|c| suppress(c, ADVERB_TAG_RULE, "*", "")).unwrap();
        assert!(style(&db, text, ADVERB_TAG_RULE).is_empty());

        // Everything off, filter words included (those run in check_text).
        let env0 = env(&db);
        let mut engine = Engine::build(&env0);
        let has_filter = |engine: &mut Engine, env: &CheckEnv| {
            check_text(engine, env, "a.md", text)
                .iter()
                .any(|d| d.rule_id.starts_with("STYLE/FILTER/"))
        };
        assert!(has_filter(&mut engine, &env0));
        db.with(|c| {
            unsuppress(c, ECHO_RULE, "a.md", "lantern")?;
            set_style(
                c,
                StyleChecks { echoes: false, adverb_tags: false, rhythm: false, filter_words: false },
            )
        })
        .unwrap();
        let env1 = env(&db);
        assert!(!has_filter(&mut engine, &env1));
        assert!(style_diags(&env1, "a.md", &masked_lines(text)).is_empty());
    }

    #[test]
    fn prose_report_counts() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| crate::codex::create_entity(c, "Maren", "character", "", &[]).map(|_| ()))
            .unwrap();
        let env = env(&db);
        let files = vec![
            (
                "one.md".to_string(),
                "# Chapter\nMaren just began to walk. The lantern glowed.\nThe lantern was very bright. Maren smiled.\n"
                    .to_string(),
            ),
            (
                "two.md".to_string(),
                "The lantern fell. Maren began to run.\n<!-- lantern -->\n".to_string(),
            ),
        ];
        let r = prose_report_of(&env, &files);
        assert_eq!(r.words, 22);
        let crutch = |w: &str| r.crutch.iter().find(|c| c.word == w);
        assert_eq!(crutch("began to").map(|c| (c.count, c.per10k)), Some((2, 909.1)));
        assert_eq!(crutch("just").map(|c| c.count), Some(1));
        assert_eq!(crutch("smiled").map(|c| c.count), Some(1));
        assert!(crutch("suddenly").is_none());
        assert_eq!(r.overused.len(), 1, "{:?}", r.overused);
        let lantern = &r.overused[0];
        assert_eq!((lantern.word.as_str(), lantern.count), ("lantern", 3));
        let ex: Vec<_> = lantern.examples.iter().map(|e| (e.file.as_str(), e.line)).collect();
        assert_eq!(ex, [("one.md", 2), ("one.md", 3), ("two.md", 1)]);
        assert_eq!(r.scenes.len(), 2);
        assert_eq!((r.scenes[0].sentences, r.scenes[0].avg_length), (4, 3.8));
        assert_eq!((r.scenes[1].sentences, r.scenes[1].avg_length, r.scenes[1].stdev), (2, 3.5, 0.5));
    }
}
