//! Prose diagnostics and the NER model.

use super::codex::OptionalPathParams;
use super::{NoParams, invalid, required};
use crate::app::App;
use crate::diagnostics::{self, Diagnostic, Dialect, ProseReport, StyleChecks};
use crate::fsx::RelPath;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct DiagStatus {
    /// The language engine is loaded (checks are fast).
    pub ready: bool,
}

pub fn status(app: &App, _: NoParams) -> Result<DiagStatus> {
    Ok(DiagStatus {
        ready: app.lang.is_ready(),
    })
}

#[derive(Serialize, TS)]
pub struct DiagFiles {
    /// Diagnostics per project-relative file.
    pub files: BTreeMap<String, Vec<Diagnostic>>,
}

pub fn check(app: &App, p: OptionalPathParams) -> Result<DiagFiles> {
    Ok(DiagFiles {
        files: diagnostics::check_files(app, &p.files(app)?)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FixParams {
    pub path: String,
    /// 1-based.
    pub line: usize,
    /// 0-based character column, inclusive.
    pub col_start: usize,
    /// 0-based character column, exclusive.
    pub col_end: usize,
    /// The text the diagnostic saw; the fix is refused if it changed.
    pub text: String,
    pub replacement: String,
}

/// Apply one fix on disk: replace the exact span if the text there still
/// matches. For files not open in an editor (open ones fix in-editor).
pub fn fix(app: &App, p: FixParams) -> Result<()> {
    let rel = RelPath::parse(&p.path)?;
    if p.line == 0 {
        return Err(invalid("`line` is 1-based"));
    }
    if p.col_start > p.col_end {
        return Err(invalid("`colStart` is after `colEnd`"));
    }
    let content = app.read(&rel)?;
    let stale = || invalid("the text has changed since this problem was found — recheck first");
    let mut out = String::with_capacity(content.len() + p.replacement.len());
    let mut done = false;
    for (i, raw) in content.split_inclusive('\n').enumerate() {
        if i + 1 != p.line {
            out.push_str(raw);
            continue;
        }
        let body_len = raw
            .strip_suffix("\r\n")
            .or_else(|| raw.strip_suffix('\n'))
            .unwrap_or(raw)
            .len();
        let (body, ending) = raw.split_at(body_len);
        let chars: Vec<char> = body.chars().collect();
        if p.col_end > chars.len()
            || chars[p.col_start..p.col_end].iter().collect::<String>() != p.text
        {
            return Err(stale());
        }
        out.extend(&chars[..p.col_start]);
        out.push_str(&p.replacement);
        out.extend(&chars[p.col_end..]);
        out.push_str(ending);
        done = true;
    }
    if !done {
        return Err(stale());
    }
    app.write(&rel, &out)
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SpellSuggestParams {
    pub word: String,
}

#[derive(Serialize, TS)]
pub struct Suggestions {
    /// Best first, at most 5, in the project's dialect.
    pub suggestions: Vec<String>,
}

pub fn suggest(app: &App, p: SpellSuggestParams) -> Result<Suggestions> {
    Ok(Suggestions {
        suggestions: diagnostics::suggest(app, required("word", &p.word)?)?,
    })
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct WordParams {
    pub word: String,
}

pub fn add_word(app: &App, p: WordParams) -> Result<()> {
    let word = required("word", &p.word)?;
    app.db.with(|c| diagnostics::add_word(c, word))
}

#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct IgnoreParams {
    pub rule_id: String,
    /// The file to ignore it in; omit (or "*") for everywhere.
    pub file: Option<String>,
    /// The flagged text; omit to ignore the rule entirely.
    pub text: Option<String>,
}

pub fn ignore(app: &App, p: IgnoreParams) -> Result<()> {
    let rule = required("ruleId", &p.rule_id)?;
    let file = match p.file.as_deref() {
        None | Some("*") | Some("") => "*".to_string(),
        Some(f) => RelPath::parse(f)?.as_str().to_string(),
    };
    app.db
        .with(|c| diagnostics::suppress(c, rule, &file, p.text.as_deref().unwrap_or("")))
}

#[derive(Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct DialectValue {
    pub dialect: Dialect,
}

pub fn get_dialect(app: &App, _: NoParams) -> Result<DialectValue> {
    Ok(DialectValue {
        dialect: app.db.with(diagnostics::get_dialect)?,
    })
}

pub fn set_dialect(app: &App, p: DialectValue) -> Result<()> {
    app.db.with(|c| diagnostics::set_dialect(c, p.dialect))
}

/// Turn individual style checks on or off; omitted fields keep their value.
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct StyleChecksPatch {
    pub echoes: Option<bool>,
    pub adverb_tags: Option<bool>,
    pub rhythm: Option<bool>,
    pub filter_words: Option<bool>,
}

pub fn style_get(app: &App, _: NoParams) -> Result<StyleChecks> {
    app.db.with(diagnostics::get_style)
}

/// Saves and returns the full set. Callers recheck afterwards.
pub fn style_set(app: &App, p: StyleChecksPatch) -> Result<StyleChecks> {
    app.db.with(|c| {
        let mut s = diagnostics::get_style(c)?;
        if let Some(v) = p.echoes {
            s.echoes = v;
        }
        if let Some(v) = p.adverb_tags {
            s.adverb_tags = v;
        }
        if let Some(v) = p.rhythm {
            s.rhythm = v;
        }
        if let Some(v) = p.filter_words {
            s.filter_words = v;
        }
        diagnostics::set_style(c, s)?;
        Ok(s)
    })
}

/// Crutch words, overused words and sentence rhythm across the manuscript.
pub fn prose_report(app: &App, _: NoParams) -> Result<ProseReport> {
    diagnostics::prose_report(app)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NerStatus {
    /// The model is downloaded.
    pub ready: bool,
    /// The model is in memory right now.
    pub loaded: bool,
    pub model_dir: String,
}

pub fn ner_status(app: &App, _: NoParams) -> Result<NerStatus> {
    Ok(NerStatus {
        ready: app.ner.is_ready(),
        loaded: app.ner.is_loaded(),
        model_dir: crate::ner::model_dir().display().to_string(),
    })
}

#[derive(Serialize, TS)]
pub struct Ready {
    pub ready: bool,
}

pub async fn ner_ensure(app: Arc<App>, _: NoParams) -> Result<Ready> {
    crate::ner::ensure_model().await?;
    Ok(Ready {
        ready: app.ner.is_ready(),
    })
}

// ---------- The writer's dictionary and turned-off rules ----------

#[derive(Serialize, TS)]
pub struct WordList {
    pub words: Vec<String>,
}

pub fn dictionary(app: &App, _: NoParams) -> Result<WordList> {
    Ok(WordList { words: app.db.with(diagnostics::dictionary)? })
}

pub fn remove_word(app: &App, p: WordParams) -> Result<()> {
    let word = required("word", &p.word)?;
    app.db.with(|c| diagnostics::remove_word(c, word))
}

/// One thing the writer told the checker to ignore.
#[derive(Serialize, Deserialize, TS, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Ignored {
    pub rule_id: String,
    /// A scene path, or "*" for everywhere.
    pub file: String,
    /// The ignored text ("" = the whole rule).
    pub text: String,
}

#[derive(Serialize, TS)]
pub struct IgnoredList {
    pub ignored: Vec<IgnoredView>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredView {
    pub rule_id: String,
    pub file: String,
    pub text: String,
    /// The rule in plain words ("Repeated word", "Spelling").
    pub label: String,
}

/// "HARPER/RepeatedWords" → "Repeated words".
fn rule_label(rule_id: &str) -> String {
    if rule_id == diagnostics::SPELLING_RULE {
        return "Spelling".into();
    }
    if let Some(word) = rule_id.strip_prefix("STYLE/FILTER/") {
        return format!("Filter word “{}”", word.to_lowercase());
    }
    match rule_id {
        diagnostics::ECHO_RULE => return "Repeated word nearby".into(),
        diagnostics::ADVERB_TAG_RULE => return "Adverb on a dialogue tag".into(),
        diagnostics::RHYTHM_RULE => return "Sentences all the same length".into(),
        _ => {}
    }
    let name = rule_id.rsplit('/').next().unwrap_or(rule_id);
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_uppercase() && i > 0 {
            out.push(' ');
            out.extend(ch.to_lowercase());
        } else if ch == '_' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

pub fn ignored(app: &App, _: NoParams) -> Result<IgnoredList> {
    let rows = app.db.with(diagnostics::suppressions)?;
    Ok(IgnoredList {
        ignored: rows
            .into_iter()
            .map(|(rule_id, file, text)| IgnoredView { label: rule_label(&rule_id), rule_id, file, text })
            .collect(),
    })
}

pub fn unignore(app: &App, p: Ignored) -> Result<()> {
    app.db.with(|c| diagnostics::unsuppress(c, &p.rule_id, &p.file, &p.text))
}

#[cfg(test)]
mod label_tests {
    #[test]
    fn rule_labels_read_as_words() {
        assert_eq!(super::rule_label("HARPER/RepeatedWords"), "Repeated words");
        assert_eq!(super::rule_label("spelling"), "Spelling");
        assert_eq!(super::rule_label("STYLE/FILTER/JUST"), "Filter word “just”");
        assert_eq!(super::rule_label("STYLE/ECHO"), "Repeated word nearby");
        assert_eq!(super::rule_label("STYLE/RHYTHM"), "Sentences all the same length");
    }
}
