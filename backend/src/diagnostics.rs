use crate::db;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// Prose diagnostics: spelling (spellbook / Hunspell dictionaries, red) and
// grammar (nlprule / LanguageTool rules, blue). Engines load lazily from a
// user-level cache; the project db holds the custom dictionary and
// per-position rule suppressions.

const DICT_AFF_URL: &str =
    "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.aff";
const DICT_DIC_URL: &str =
    "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.dic";
const NLPRULE_TOKENIZER_URL: &str =
    "https://github.com/bminixhofer/nlprule/releases/download/0.6.4/en_tokenizer.bin.gz";
const NLPRULE_RULES_URL: &str =
    "https://github.com/bminixhofer/nlprule/releases/download/0.6.4/en_rules.bin.gz";

pub fn lang_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".cache").join("chronicler").join("lang")
}

pub fn is_ready() -> bool {
    let dir = lang_dir();
    ["en.aff", "en.dic", "en_tokenizer.bin", "en_rules.bin"]
        .iter()
        .all(|f| dir.join(f).exists())
}

async fn download(client: &reqwest::Client, url: &str, target: &Path, gz: bool) -> Result<()> {
    if target.exists() {
        return Ok(());
    }
    let resp = client.get(url).send().await.with_context(|| format!("downloading {}", url))?;
    if !resp.status().is_success() {
        bail!("download failed for {}: HTTP {}", url, resp.status());
    }
    let bytes = resp.bytes().await?;
    let data: Vec<u8> = if gz {
        use std::io::Read;
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_end(&mut out)
            .context("decompressing")?;
        out
    } else {
        bytes.to_vec()
    };
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, &data)?;
    std::fs::rename(&tmp, target)?;
    tracing::info!("Downloaded {} ({} bytes)", target.display(), data.len());
    Ok(())
}

/// Fetch dictionaries (~1 MB) and grammar rule binaries (~15 MB). Idempotent.
pub async fn ensure_models() -> Result<()> {
    let dir = lang_dir();
    std::fs::create_dir_all(&dir).context("creating language cache dir")?;
    let client = reqwest::Client::new();
    download(&client, DICT_AFF_URL, &dir.join("en.aff"), false).await?;
    download(&client, DICT_DIC_URL, &dir.join("en.dic"), false).await?;
    download(&client, NLPRULE_TOKENIZER_URL, &dir.join("en_tokenizer.bin"), true).await?;
    download(&client, NLPRULE_RULES_URL, &dir.join("en_rules.bin"), true).await?;
    Ok(())
}

struct Engines {
    dict: spellbook::Dictionary,
    tokenizer: nlprule::Tokenizer,
    rules: nlprule::Rules,
    harper: harper_core::linting::LintGroup,
    harper_dict: std::sync::Arc<harper_core::spell::FstDictionary>,
}

static ENGINES: OnceLock<Mutex<Option<Engines>>> = OnceLock::new();

fn with_engines<T>(f: impl FnOnce(&mut Engines) -> Result<T>) -> Result<T> {
    if !is_ready() {
        bail!("Language models not downloaded");
    }
    let cell = ENGINES.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if guard.is_none() {
        let dir = lang_dir();
        let aff = std::fs::read_to_string(dir.join("en.aff")).context("reading en.aff")?;
        let dic = std::fs::read_to_string(dir.join("en.dic")).context("reading en.dic")?;
        let dict = spellbook::Dictionary::new(&aff, &dic)
            .map_err(|e| anyhow::anyhow!("loading dictionary: {}", e))?;
        let tokenizer = nlprule::Tokenizer::new(dir.join("en_tokenizer.bin"))
            .map_err(|e| anyhow::anyhow!("loading grammar tokenizer: {}", e))?;
        let rules = nlprule::Rules::new(dir.join("en_rules.bin"))
            .map_err(|e| anyhow::anyhow!("loading grammar rules: {}", e))?;
        let harper_dict = harper_core::spell::FstDictionary::curated();
        let harper = harper_core::linting::LintGroup::new_curated(
            harper_dict.clone(),
            harper_core::Dialect::American,
        );
        *guard = Some(Engines { dict, tokenizer, rules, harper, harper_dict });
    }
    f(guard.as_mut().unwrap())
}

/// Load all engines now (idempotent) so the first real check is fast.
pub fn warm() -> Result<()> {
    with_engines(|_| Ok(()))
}

// ---------- Project dictionary & suppressions (db) ----------

pub fn add_word(root: &Path, word: &str) -> Result<()> {
    let conn = db::open(root)?;
    conn.execute("INSERT OR IGNORE INTO dictionary (word) VALUES (?1)", [word.trim()])?;
    Ok(())
}

pub fn suppress(root: &Path, rule_id: &str, file: &str, text: &str) -> Result<()> {
    let conn = db::open(root)?;
    conn.execute(
        "INSERT OR IGNORE INTO suppressions (rule_id, file, text) VALUES (?1, ?2, ?3)",
        rusqlite::params![rule_id, file, text],
    )?;
    Ok(())
}

fn custom_words(root: &Path) -> BTreeSet<String> {
    let mut words = BTreeSet::new();
    if let Ok(conn) = db::open(root) {
        if let Ok(mut stmt) = conn.prepare("SELECT word FROM dictionary") {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for w in rows.flatten() {
                    words.insert(w.to_lowercase());
                }
            }
        }
        // Codex names and aliases are never misspellings
        if let Ok(mut stmt) = conn.prepare("SELECT name, aliases FROM entities") {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            }) {
                for (name, aliases) in rows.flatten() {
                    for token in name.split_whitespace() {
                        words.insert(token.to_lowercase());
                    }
                    let aliases: Vec<String> = serde_json::from_str(&aliases).unwrap_or_default();
                    for alias in aliases {
                        for token in alias.split_whitespace() {
                            words.insert(token.to_lowercase());
                        }
                    }
                }
            }
        }
    }
    words
}

fn suppressions(root: &Path) -> BTreeSet<(String, String, String)> {
    let mut set = BTreeSet::new();
    if let Ok(conn) = db::open(root) {
        if let Ok(mut stmt) = conn.prepare("SELECT rule_id, file, text FROM suppressions") {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            }) {
                for row in rows.flatten() {
                    set.insert(row);
                }
            }
        }
    }
    set
}

// ---------- Style (crutch words & repetition) ----------

const DEFAULT_FILTER_WORDS: &[&str] = &[
    "just", "really", "very", "suddenly", "somehow", "actually", "quite",
    "rather", "simply", "basically", "definitely", "totally",
];

fn filter_words(root: &Path) -> Vec<String> {
    db::get_setting(root, "styleWords")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_else(|| DEFAULT_FILTER_WORDS.iter().map(|s| s.to_string()).collect())
}

// ---------- Checking ----------

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c == '\'' || c == '\u{2019}'
}

fn strip_word(w: &str) -> &str {
    w.trim_matches(|c: char| c == '\'' || c == '\u{2019}')
}

/// Blank out `<!-- ... -->` regions (state carries across lines) so comments
/// are never spell/grammar checked. Char count is preserved for offsets.
fn mask_html_comments(line: &str, in_comment: &mut bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = vec![' '; chars.len()];
    let mut i = 0;
    while i < chars.len() {
        if *in_comment {
            if chars[i] == '-' && chars.get(i + 1) == Some(&'-') && chars.get(i + 2) == Some(&'>') {
                *in_comment = false;
                i += 3;
            } else {
                i += 1;
            }
        } else if chars[i] == '<'
            && chars.get(i + 1) == Some(&'!')
            && chars.get(i + 2) == Some(&'-')
            && chars.get(i + 3) == Some(&'-')
        {
            *in_comment = true;
            i += 4;
        } else {
            out[i] = chars[i];
            i += 1;
        }
    }
    out.into_iter().collect()
}

pub fn check_file(root: &Path, rel: &str) -> Result<Vec<Value>> {
    let path = crate::resolve_path(root, rel)?;
    let content = std::fs::read_to_string(&path).with_context(|| format!("reading {}", rel))?;
    let custom = custom_words(root);
    let suppressed = suppressions(root);
    let filters = filter_words(root);

    with_engines(|engines| {
        let mut diags: Vec<Value> = Vec::new();
        let mut in_fence = false;
        let mut in_comment = false;
        // Masked copy of the whole document (code/comments blanked, char
        // counts preserved) — fed to harper for the style pass at the end.
        let mut doc_lines: Vec<String> = Vec::new();

        for (line_no, raw_line) in content.lines().enumerate() {
            let trimmed = raw_line.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_fence = !in_fence;
                doc_lines.push(" ".repeat(raw_line.chars().count()));
                continue;
            }
            if in_fence {
                doc_lines.push(" ".repeat(raw_line.chars().count()));
                continue;
            }
            let masked = mask_html_comments(raw_line, &mut in_comment);
            doc_lines.push(masked.clone());
            let line = masked.as_str();
            if line.trim().is_empty() {
                continue;
            }
            let trimmed = line.trim_start();

            // ---- Spelling: per word, skipping markdown-ish tokens ----
            let chars: Vec<char> = line.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                if !is_word_char(chars[i]) {
                    i += 1;
                    continue;
                }
                let start = i;
                while i < chars.len() && is_word_char(chars[i]) {
                    i += 1;
                }
                let raw: String = chars[start..i].iter().collect();
                let word = strip_word(&raw);
                if word.len() < 2 || !word.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
                    continue;
                }
                // Skip URLs and inline code crudely: inside backticks or after ](
                if custom.contains(&word.to_lowercase()) {
                    continue;
                }
                if engines.dict.check(word) {
                    continue;
                }
                // Possessives: "Marr's" is fine if "Marr" is
                let base = word
                    .strip_suffix("'s")
                    .or_else(|| word.strip_suffix("\u{2019}s"));
                if let Some(b) = base {
                    if custom.contains(&b.to_lowercase()) || engines.dict.check(b) {
                        continue;
                    }
                }
                if suppressed.contains(&("spelling".into(), rel.into(), word.to_string())) {
                    continue;
                }
                let mut sugg: Vec<String> = Vec::new();
                engines.dict.suggest(word, &mut sugg);
                sugg.truncate(3);
                diags.push(json!({
                    "source": "spelling",
                    "severity": "error",
                    "file": rel,
                    "line": line_no + 1,
                    "colStart": start,
                    "colEnd": start + raw.chars().count(),
                    "text": word,
                    "message": format!("Unknown word “{}”", word),
                    "ruleId": "spelling",
                    "replacements": sugg,
                }));
            }

            // ---- Style: fiction crutch/filter words (config-driven) ----
            {
                let mut i = 0;
                while i < chars.len() {
                    if !is_word_char(chars[i]) {
                        i += 1;
                        continue;
                    }
                    let start = i;
                    while i < chars.len() && is_word_char(chars[i]) {
                        i += 1;
                    }
                    let raw: String = chars[start..i].iter().collect();
                    let word = strip_word(&raw).to_lowercase();
                    if word.len() < 2 {
                        continue;
                    }

                    if filters.contains(&word) {
                        let rule_id = format!("STYLE/FILTER/{}", word.to_uppercase());
                        if !suppressed.contains(&(rule_id.clone(), rel.into(), word.clone()))
                            && !suppressed.contains(&(rule_id.clone(), "*".into(), String::new()))
                        {
                            diags.push(json!({
                                "source": "style",
                                "severity": "info",
                                "file": rel,
                                "line": line_no + 1,
                                "colStart": start,
                                "colEnd": i,
                                "text": word,
                                "message": format!("Filter word “{}” — often cuttable", word),
                                "ruleId": rule_id,
                            }));
                        }
                    }
                }
            }

            // ---- Grammar: nlprule per line (markdown paragraphs are lines) ----
            if trimmed.starts_with('#') || trimmed.starts_with('>') || trimmed.starts_with("- ") {
                continue; // prose lines only; headings/quotes/lists trip style rules
            }
            for suggestion in engines.rules.suggest(line, &engines.tokenizer) {
                let span = suggestion.span().char().clone();
                let text: String = chars
                    .get(span.start..span.end.min(chars.len()))
                    .map(|s| s.iter().collect())
                    .unwrap_or_default();
                let rule_id = suggestion.source().to_string();
                // Straight quotes/apostrophes are how markdown drafts are
                // typed — smart-quote nagging is noise, not grammar. And
                // whitespace nags misfire on comment-masked gaps.
                if rule_id.starts_with("TYPOGRAPHY/EN_QUOTES") || rule_id.contains("WHITESPACE") {
                    continue;
                }
                if suppressed.contains(&(rule_id.clone(), rel.into(), text.clone()))
                    || suppressed.contains(&(rule_id.clone(), "*".into(), String::new()))
                {
                    continue;
                }
                diags.push(json!({
                    "source": "grammar",
                    "severity": "warning",
                    "file": rel,
                    "line": line_no + 1,
                    "colStart": span.start,
                    "colEnd": span.end,
                    "text": text,
                    "message": suggestion.message(),
                    "ruleId": rule_id,
                    "replacements": suggestion.replacements().iter().take(3).collect::<Vec<_>>(),
                }));
            }
        }

        // ---- Style: harper curated lints over the masked document ----
        // Spelling stays with spellbook (codex-aware) and grammar with
        // nlprule, so only style-class lint kinds are kept here.
        {
            use harper_core::linting::LintKind;
            let clean = doc_lines.join("\n");
            let clean_chars: Vec<char> = clean.chars().collect();
            let mut line_starts: Vec<usize> = Vec::with_capacity(doc_lines.len());
            let mut off = 0usize;
            for l in &doc_lines {
                line_starts.push(off);
                off += l.chars().count() + 1;
            }
            let doc = harper_core::Document::new_markdown_default(&clean, &*engines.harper_dict);
            for (name, lints) in engines.harper.organized_lints(&doc) {
                for lint in lints {
                    let styleish = matches!(
                        lint.lint_kind,
                        LintKind::Repetition
                            | LintKind::Redundancy
                            | LintKind::Enhancement
                            | LintKind::Readability
                            | LintKind::Style
                    );
                    if !styleish {
                        continue;
                    }
                    let span = lint.span;
                    if span.start >= clean_chars.len() {
                        continue;
                    }
                    let line_idx = line_starts.partition_point(|&s| s <= span.start) - 1;
                    let col_start = span.start - line_starts[line_idx];
                    let col_end = span.end.min(off).saturating_sub(line_starts[line_idx]);
                    let text: String = clean_chars
                        [span.start..span.end.min(clean_chars.len())]
                        .iter()
                        .collect();
                    let rule_id = format!("HARPER/{}", name);
                    if suppressed.contains(&(rule_id.clone(), rel.into(), text.clone()))
                        || suppressed.contains(&(rule_id.clone(), "*".into(), String::new()))
                    {
                        continue;
                    }
                    let replacements: Vec<String> = lint
                        .suggestions
                        .iter()
                        .filter_map(|s| match s {
                            harper_core::linting::Suggestion::ReplaceWith(chars) => {
                                Some(chars.iter().collect::<String>())
                            }
                            _ => None,
                        })
                        .take(3)
                        .collect();
                    diags.push(json!({
                        "source": "style",
                        "severity": "info",
                        "file": rel,
                        "line": line_idx + 1,
                        "colStart": col_start,
                        "colEnd": col_end,
                        "text": text,
                        "message": lint.message,
                        "ruleId": rule_id,
                        "replacements": replacements,
                    }));
                }
            }
        }
        Ok(diags)
    })
}
