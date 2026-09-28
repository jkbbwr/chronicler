use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

// Manuscript compilation: chapters (each a list of scene files) are converted
// from our markdown subset to Typst, wrapped in a template driven by the
// wizard's settings, and rendered with the system `typst` binary.

#[derive(Deserialize, TS, Debug)]
#[serde(deny_unknown_fields)]
pub struct ChapterSpec {
    pub title: String,
    /// Project-relative scene file paths, in order. The RPC layer reads them
    /// (path-confined) and hands contents to `run`.
    pub scenes: Vec<String>,
}

#[derive(Deserialize, TS, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct CompileSettings {
    #[ts(as = "Option<String>", optional)]
    pub title: String,
    #[ts(as = "Option<String>", optional)]
    pub author: String,
    #[ts(as = "Option<String>", optional)]
    pub paper: String,
    #[ts(as = "Option<f64>", optional)]
    pub font_size: f64,
    #[ts(as = "Option<String>", optional)]
    pub font_family: String,
    #[ts(as = "Option<f64>", optional)]
    pub line_spacing: f64,
    #[ts(as = "Option<bool>", optional)]
    pub justify: bool,
    #[ts(as = "Option<bool>", optional)]
    pub first_line_indent: bool,
    #[ts(as = "Option<bool>", optional)]
    pub title_page: bool,
    #[ts(as = "Option<bool>", optional)]
    pub chapter_page_breaks: bool,
    #[ts(as = "Option<bool>", optional)]
    pub numbering: bool,
    #[ts(as = "Option<String>", optional)]
    pub scene_separator: String,
    #[ts(as = "Option<String>", optional)]
    pub custom_preamble: String,
    /// pdf | typst | markdown
    #[ts(as = "Option<String>", optional)]
    pub format: String,
    /// Aesthetic preset: modern-novel | classic-manuscript | elegant-book | plain
    #[ts(as = "Option<String>", optional)]
    pub template: String,
}

impl Default for CompileSettings {
    fn default() -> Self {
        CompileSettings {
            title: String::new(),
            author: String::new(),
            paper: "a5".into(),
            font_size: 11.0,
            font_family: String::new(),
            line_spacing: 0.85,
            justify: true,
            first_line_indent: true,
            title_page: true,
            chapter_page_breaks: true,
            numbering: true,
            scene_separator: "* * *".into(),
            custom_preamble: String::new(),
            format: "pdf".into(),
            template: "modern-novel".into(),
        }
    }
}

/// Escape plain text for Typst markup: markup characters anywhere, comment
/// openers (`//`, `/*`), and — when the text starts a line — block markers
/// (`= `, `+ `, `- `, `/ `, `1. `).
fn escape(text: &str, line_start: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    let first = if line_start {
        chars.iter().position(|c| !c.is_whitespace())
    } else {
        None
    };
    // `12. ` at line start is an enum marker: escape its dot.
    let enum_dot = first.and_then(|f| {
        let digits = chars[f..].iter().take_while(|c| c.is_ascii_digit()).count();
        let dot = f + digits;
        (digits > 0
            && chars.get(dot) == Some(&'.')
            && chars.get(dot + 1).is_none_or(|c| c.is_whitespace()))
        .then_some(dot)
    });
    for (i, &c) in chars.iter().enumerate() {
        let next = chars.get(i + 1).copied();
        let marker = Some(i) == first
            && (c == '=' || (matches!(c, '+' | '-' | '/') && next.is_none_or(char::is_whitespace)));
        let escape = match c {
            '*' | '_' | '#' | '@' | '$' | '\\' | '<' | '>' | '[' | ']' | '~' | '`' => true,
            '/' if matches!(next, Some('/') | Some('*')) => true,
            _ => marker || Some(i) == enum_dot,
        };
        if escape {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escape inline text (titles, separators) that may begin a line.
fn esc(text: &str) -> String {
    escape(text, true)
}

fn esc_string(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Convert one line of inline markdown to Typst markup.
/// Handles code spans, links, strikethrough, bold, italic; everything else
/// is escaped. Converted segments are stashed behind private-use-area
/// placeholders so the final escape pass can't mangle them.
fn convert_inline(text: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    static CODE: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    static STRIKE: OnceLock<Regex> = OnceLock::new();
    static BOLD: OnceLock<Regex> = OnceLock::new();
    static ITALIC_STAR: OnceLock<Regex> = OnceLock::new();
    static ITALIC_UNDER: OnceLock<Regex> = OnceLock::new();

    let code = CODE.get_or_init(|| Regex::new(r"`([^`]+)`").unwrap());
    let link = LINK.get_or_init(|| Regex::new(r"\[([^\]]+)\]\(([^)\s]+)\)").unwrap());
    let strike = STRIKE.get_or_init(|| Regex::new(r"~~(.+?)~~").unwrap());
    let bold = BOLD.get_or_init(|| Regex::new(r"\*\*(.+?)\*\*").unwrap());
    let italic_star = ITALIC_STAR.get_or_init(|| Regex::new(r"\*([^*\n]+)\*").unwrap());
    let italic_under = ITALIC_UNDER.get_or_init(|| Regex::new(r"\b_([^_\n]+)_\b").unwrap());

    let mut stash: Vec<String> = Vec::new();
    let keep = |s: String, stash: &mut Vec<String>| -> String {
        stash.push(s);
        format!("\u{e000}{}\u{e001}", stash.len() - 1)
    };

    let mut s = text.to_string();
    s = code
        .replace_all(&s, |c: &regex::Captures| {
            keep(format!("`{}`", &c[1]), &mut stash)
        })
        .into_owned();
    s = link
        .replace_all(&s, |c: &regex::Captures| {
            keep(
                format!("#link(\"{}\")[{}]", esc_string(&c[2]), esc(&c[1])),
                &mut stash,
            )
        })
        .into_owned();
    s = strike
        .replace_all(&s, |c: &regex::Captures| {
            keep(format!("#strike[{}]", esc(&c[1])), &mut stash)
        })
        .into_owned();
    s = bold
        .replace_all(&s, |c: &regex::Captures| {
            keep(format!("*{}*", esc(&c[1])), &mut stash)
        })
        .into_owned();
    s = italic_star
        .replace_all(&s, |c: &regex::Captures| {
            keep(format!("_{}_", esc(&c[1])), &mut stash)
        })
        .into_owned();
    s = italic_under
        .replace_all(&s, |c: &regex::Captures| {
            keep(format!("_{}_", esc(&c[1])), &mut stash)
        })
        .into_owned();

    // Escape what's left, then restore stashed segments
    let mut out = String::new();
    let mut plain = String::new();
    let mut at_start = true;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{e000}' {
            out.push_str(&escape(&plain, at_start));
            at_start = false;
            plain.clear();
            let idx: String = chars.by_ref().take_while(|&d| d != '\u{e001}').collect();
            if let Some(seg) = idx.parse::<usize>().ok().and_then(|i| stash.get(i)) {
                out.push_str(seg);
            }
        } else {
            plain.push(c);
        }
    }
    out.push_str(&escape(&plain, at_start));
    out
}

fn is_hr(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3
        && (t.chars().all(|c| c == '-')
            || t.chars().all(|c| c == '*')
            || t.chars().all(|c| c == '_'))
}

/// Remove `<!-- ... -->` annotations (including multi-line ones) — writer
/// notes never belong in compiled output.
pub fn strip_html_comments(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    loop {
        match rest.find("<!--") {
            None => {
                out.push_str(rest);
                break;
            }
            Some(start) => {
                out.push_str(&rest[..start]);
                match rest[start..].find("-->") {
                    Some(end) => rest = &rest[start + end + 3..],
                    None => break, // unterminated comment swallows the rest
                }
            }
        }
    }
    out
}

/// Convert a scene's markdown body to Typst markup.
pub fn md_to_typst(raw: &str) -> String {
    let md = strip_html_comments(raw);
    let md = md.as_str();
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut quote: Vec<String> = Vec::new();

    let flush_quote = |quote: &mut Vec<String>, out: &mut Vec<String>| {
        if !quote.is_empty() {
            out.push(format!("#quote(block: true)[{}]", quote.join("\n")));
            quote.clear();
        }
    };

    for line in md.lines() {
        let trimmed = line.trim_start();

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            flush_quote(&mut quote, &mut out);
            in_fence = !in_fence;
            out.push(line.to_string());
            continue;
        }
        if in_fence {
            out.push(line.to_string());
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('>') {
            quote.push(convert_inline(rest.strip_prefix(' ').unwrap_or(rest)));
            continue;
        }
        flush_quote(&mut quote, &mut out);

        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|&c| c == '#').count();
            if level <= 6 && trimmed.chars().nth(level) == Some(' ') {
                // In-scene headings sit below the chapter heading (level 1)
                let depth = (level + 1).min(6);
                out.push(format!(
                    "{} {}",
                    "=".repeat(depth),
                    convert_inline(&trimmed[level + 1..])
                ));
                continue;
            }
        }

        if is_hr(line) {
            out.push("#sep".to_string());
            continue;
        }

        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            out.push(format!("- {}", convert_inline(rest)));
            continue;
        }
        if let Some(pos) = trimmed.find(". ")
            && pos > 0
            && trimmed[..pos].chars().all(|c| c.is_ascii_digit())
        {
            out.push(format!("+ {}", convert_inline(&trimmed[pos + 2..])));
            continue;
        }

        if trimmed.is_empty() {
            out.push(String::new());
        } else {
            out.push(convert_inline(line));
        }
    }
    flush_quote(&mut quote, &mut out);
    out.join("\n")
}

/// `#chapter(eyebrow)[Title]` call for one chapter, per the numbering setting.
fn chapter_call(index: usize, title: &str, numbering: bool) -> String {
    let title = title.trim();
    match (numbering, title.is_empty()) {
        (true, false) => format!("#chapter([Chapter {}])[{}]", index, esc(title)),
        (true, true) => format!("#chapter(none)[Chapter {}]", index),
        (false, _) => format!("#chapter(none)[{}]", esc(title)),
    }
}

/// Generate the full Typst source for the manuscript.
///
/// The default design is a modern minimal novel interior: A5, indent-only
/// paragraph flow (par spacing = leading, no gaps), understated small-caps
/// chapter eyebrows over a light title, muted centered scene separators.
pub fn generate_typst(
    front: &[String],
    chapters: &[(String, Vec<String>)],
    back: &[String],
    s: &CompileSettings,
) -> String {
    let mut doc = String::new();

    let paper = match s.paper.as_str() {
        "a4" => "a4",
        "us-letter" => "us-letter",
        _ => "a5",
    };

    // Prelims (title page + front matter) carry no page numbers; the body
    // restarts at 1 after them.
    let has_prelims = s.title_page || !front.is_empty();
    let page_numbering = if has_prelims { "none" } else { "\"1\"" };
    doc.push_str(&format!(
        "#set page(paper: \"{}\", numbering: {}, margin: (x: 2cm, top: 2.2cm, bottom: 2.4cm))\n",
        paper, page_numbering
    ));

    if s.font_family.trim().is_empty() {
        doc.push_str(&format!(
            "#set text(size: {}pt, lang: \"en\")\n",
            s.font_size
        ));
    } else {
        doc.push_str(&format!(
            "#set text(size: {}pt, lang: \"en\", font: \"{}\")\n",
            s.font_size,
            esc_string(s.font_family.trim())
        ));
    }

    // Novel paragraph flow: spacing equals leading so paragraphs run
    // continuously and only the first-line indent marks the break.
    let indent = if s.first_line_indent {
        ", first-line-indent: 1.2em"
    } else {
        ""
    };
    doc.push_str(&format!(
        "#set par(justify: {}, leading: {lead}em, spacing: {lead}em{indent})\n",
        s.justify,
        lead = s.line_spacing,
        indent = indent,
    ));

    let brk = if s.chapter_page_breaks {
        "  pagebreak(weak: true)\n"
    } else {
        ""
    };
    let sep = esc(&s.scene_separator);
    let title_text = esc(if s.title.trim().is_empty() {
        "Untitled"
    } else {
        s.title.trim()
    });
    let author = esc(s.author.trim());

    // Template aesthetics: separator, chapter opener, and title page design.
    // The inner #heading keeps PDF bookmarks working in every template.
    let mut title_page = String::new();
    match s.template.as_str() {
        "classic-manuscript" => {
            doc.push_str(&format!(
                "#let sep = align(center)[#v(1em){}#v(1em)]\n",
                sep
            ));
            doc.push_str(&format!(
                "#let chapter(eyebrow, title) = {{\n{brk}  v(30%)\n  align(center)[#heading(level: 1)[#upper[#if eyebrow != none [#eyebrow: ] #title]]]\n  v(4em)\n}}\n"
            ));
            doc.push_str("#show heading.where(level: 1): it => text(size: 1em, weight: \"bold\", hyphenate: false, it.body)\n");
            if s.title_page {
                title_page.push_str(&format!(
                    "\n#align(center + horizon)[\n  #text(size: 1.4em, weight: \"bold\")[#upper[{}]]",
                    title_text
                ));
                if !author.is_empty() {
                    title_page.push_str(&format!("\n  #v(1.2em)\n  by {}", author));
                }
                title_page.push_str("\n]\n");
            }
        }
        "elegant-book" => {
            doc.push_str(&format!(
                "#let sep = align(center)[#v(1em)#text(fill: luma(130), tracking: 0.5em)[{}]#v(1em)]\n", sep
            ));
            doc.push_str(&format!(
                "#let chapter(eyebrow, title) = {{\n{brk}  v(18%)\n  align(center)[\n    #if eyebrow != none [#text(size: 0.75em, tracking: 0.3em, fill: luma(120))[#upper(eyebrow)] #v(0.9em) #line(length: 18%, stroke: 0.5pt + luma(160)) #v(1.2em)]\n    #heading(level: 1)[#title]\n  ]\n  v(4em)\n}}\n"
            ));
            doc.push_str("#show heading.where(level: 1): it => text(size: 1.7em, weight: \"regular\", style: \"italic\", hyphenate: false, it.body)\n");
            if s.title_page {
                title_page.push_str(&format!(
                    "\n#align(center + horizon)[\n  #text(size: 2.3em, style: \"italic\")[{}]",
                    title_text
                ));
                if !author.is_empty() {
                    title_page.push_str(&format!(
                        "\n  #v(1.4em)\n  #line(length: 22%, stroke: 0.5pt + luma(150))\n  #v(1.4em)\n  #text(size: 0.9em, tracking: 0.22em, fill: luma(90))[#upper[{}]]",
                        author
                    ));
                }
                title_page.push_str("\n]\n");
            }
        }
        "plain" => {
            doc.push_str(&format!(
                "#let sep = align(center)[#v(0.7em){}#v(0.7em)]\n",
                sep
            ));
            doc.push_str(&format!(
                "#let chapter(eyebrow, title) = {{\n{brk}  v(2em)\n  heading(level: 1)[#if eyebrow != none [#eyebrow: ] #title]\n  v(1.2em)\n}}\n"
            ));
            doc.push_str("#show heading.where(level: 1): it => text(size: 1.4em, weight: \"bold\", hyphenate: false, it.body)\n");
            if s.title_page {
                title_page.push_str(&format!(
                    "\n#align(center + horizon)[\n  #text(size: 1.8em, weight: \"bold\")[{}]",
                    title_text
                ));
                if !author.is_empty() {
                    title_page.push_str(&format!("\n  #v(1em)\n  {}", author));
                }
                title_page.push_str("\n]\n");
            }
        }
        _ => {
            // modern-novel (default): small-caps eyebrow over a light title
            doc.push_str(&format!(
                "#let sep = align(center)[#v(0.9em)#text(fill: luma(110), tracking: 0.4em)[{}]#v(0.9em)]\n", sep
            ));
            doc.push_str(&format!(
                "#let chapter(eyebrow, title) = {{\n{brk}  v(16%)\n  align(center)[\n    #if eyebrow != none [#text(size: 0.8em, tracking: 0.22em, fill: luma(110))[#upper(eyebrow)] #v(1.4em)]\n    #heading(level: 1)[#title]\n  ]\n  v(3.5em)\n}}\n"
            ));
            doc.push_str("#show heading.where(level: 1): it => text(size: 1.5em, weight: \"medium\", hyphenate: false, it.body)\n");
            if s.title_page {
                title_page.push_str(&format!(
                    "\n#align(center + horizon)[\n  #text(size: 2.1em, weight: \"medium\")[{}]",
                    title_text
                ));
                if !author.is_empty() {
                    title_page.push_str(&format!(
                        "\n  #v(1.6em)\n  #text(size: 0.95em, tracking: 0.18em, fill: luma(80))[#upper[{}]]",
                        author
                    ));
                }
                title_page.push_str("\n]\n");
            }
        }
    }
    doc.push_str("#show heading: set text(hyphenate: false)\n");
    // In-scene headings: modest, with their own spacing
    doc.push_str("#show heading.where(level: 2): it => { v(1.2em); text(size: 1.15em, weight: \"semibold\", it.body); v(0.5em) }\n");

    if !s.custom_preamble.trim().is_empty() {
        doc.push_str("\n// Custom preamble\n");
        doc.push_str(s.custom_preamble.trim());
        doc.push('\n');
    }

    doc.push_str(&title_page);

    // Front matter: one unnumbered page per file, no chapter headings —
    // the writer owns the content (copyright, dedication, epigraph, ...).
    for md in front {
        doc.push_str("\n#pagebreak(weak: true)\n");
        doc.push_str(&md_to_typst(md));
        doc.push('\n');
    }
    if has_prelims {
        doc.push_str("#pagebreak()\n#set page(numbering: \"1\")\n#counter(page).update(1)\n");
    }

    for (i, (title, scenes)) in chapters.iter().enumerate() {
        doc.push('\n');
        doc.push_str(&chapter_call(i + 1, title, s.numbering));
        doc.push_str("\n\n");
        let bodies: Vec<String> = scenes.iter().map(|md| md_to_typst(md)).collect();
        doc.push_str(&bodies.join("\n\n#sep\n\n"));
        doc.push('\n');
    }

    // Back matter: numbered continuation, one page per file
    for md in back {
        doc.push_str("\n#pagebreak(weak: true)\n");
        doc.push_str(&md_to_typst(md));
        doc.push('\n');
    }

    doc
}

/// Concatenated-markdown output for the "markdown" format.
pub fn generate_markdown(
    front: &[String],
    chapters: &[(String, Vec<String>)],
    back: &[String],
    s: &CompileSettings,
) -> String {
    let mut doc = String::new();
    if !s.title.trim().is_empty() {
        doc.push_str(&format!("# {}\n", s.title.trim()));
        if !s.author.trim().is_empty() {
            doc.push_str(&format!("\nby {}\n", s.author.trim()));
        }
        doc.push('\n');
    }
    for md in front {
        doc.push_str(&strip_html_comments(md));
        doc.push_str("\n\n---\n\n");
    }
    for (i, (title, scenes)) in chapters.iter().enumerate() {
        let heading = match (s.numbering, title.trim().is_empty()) {
            (true, false) => format!("Chapter {} — {}", i + 1, title.trim()),
            (true, true) => format!("Chapter {}", i + 1),
            (false, _) => title.trim().to_string(),
        };
        doc.push_str(&format!("\n# {}\n\n", heading));
        let cleaned: Vec<String> = scenes.iter().map(|sc| strip_html_comments(sc)).collect();
        doc.push_str(&cleaned.join(&format!("\n\n{}\n\n", s.scene_separator)));
        doc.push('\n');
    }
    for md in back {
        doc.push_str("\n---\n\n");
        doc.push_str(&strip_html_comments(md));
        doc.push('\n');
    }
    doc
}

/// How long typst may run before the compile is abandoned.
pub const TYPST_TIMEOUT: Duration = Duration::from_secs(180);

/// Write the manuscript source into `.chronicler/build/`. Returns the
/// finished artifact for markdown/typst formats, or the `.typ` source still
/// to be rendered for PDF.
pub fn write_source(
    root: &Path,
    front: &[String],
    chapters: &[(String, Vec<String>)],
    back: &[String],
    settings: &CompileSettings,
) -> Result<Build> {
    let build_dir = root.join(".chronicler").join("build");
    std::fs::create_dir_all(&build_dir).context("creating build dir")?;
    match settings.format.as_str() {
        "markdown" => {
            let out = build_dir.join("manuscript.md");
            std::fs::write(&out, generate_markdown(front, chapters, back, settings))
                .context("writing markdown")?;
            Ok(Build::Done(out))
        }
        "typst" => {
            let out = build_dir.join("manuscript.typ");
            std::fs::write(&out, generate_typst(front, chapters, back, settings))
                .context("writing typst source")?;
            Ok(Build::Done(out))
        }
        _ => {
            let typ = build_dir.join("manuscript.typ");
            std::fs::write(&typ, generate_typst(front, chapters, back, settings))
                .context("writing typst source")?;
            Ok(Build::NeedsPdf {
                pdf: build_dir.join("manuscript.pdf"),
                typ,
            })
        }
    }
}

pub enum Build {
    Done(PathBuf),
    NeedsPdf { typ: PathBuf, pdf: PathBuf },
}

/// Render the typst source to PDF with the system `typst`, killing it if it
/// runs past [`TYPST_TIMEOUT`].
pub async fn render_pdf(typ: &Path, pdf: &Path, timeout: Duration) -> Result<()> {
    let child = tokio::process::Command::new("typst")
        .arg("compile")
        .arg(typ)
        .arg(pdf)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("running typst — is it installed and on PATH?")?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.context("waiting for typst")?,
        Err(_) => bail!(
            "typst took longer than {}s and was stopped",
            timeout.as_secs()
        ),
    };
    if !output.status.success() {
        bail!(
            "typst compile failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_conversion() {
        assert_eq!(convert_inline("plain text"), "plain text");
        assert_eq!(convert_inline("**bold** move"), "*bold* move");
        assert_eq!(convert_inline("so *very* quiet"), "so _very_ quiet");
        assert_eq!(convert_inline("a ~~cut~~ line"), "a #strike[cut] line");
        assert_eq!(
            convert_inline("see [the map](https://x.y/map)"),
            "see #link(\"https://x.y/map\")[the map]"
        );
        // Typst specials in plain prose get escaped
        assert_eq!(convert_inline("cost: $5 #tag"), "cost: \\$5 \\#tag");
        // Bold containing markup-significant chars
        assert_eq!(convert_inline("**a#b**"), "*a\\#b*");
    }

    #[test]
    fn typst_comments_and_markers_are_escaped() {
        assert_eq!(convert_inline("see http://x.y now"), "see http:\\//x.y now");
        assert_eq!(convert_inline("a /* b"), "a \\/\\* b");
        assert_eq!(convert_inline("= not a heading"), "\\= not a heading");
        assert_eq!(convert_inline("+ not a list"), "\\+ not a list");
        assert_eq!(convert_inline("/ not a term"), "\\/ not a term");
        assert_eq!(convert_inline("1984. It rained"), "1984\\. It rained");
        assert_eq!(convert_inline("a = b - c / d"), "a = b - c / d");
        assert_eq!(esc("= Title"), "\\= Title");
    }

    #[test]
    fn comments_never_compile() {
        let t =
            md_to_typst("before <!-- note to self --> after\n\n<!-- block\nspanning\n-->\nvisible");
        assert!(!t.contains("note to self"));
        assert!(!t.contains("spanning"));
        assert!(t.contains("before"));
        assert!(t.contains("after"));
        assert!(t.contains("visible"));
    }

    #[test]
    fn block_conversion() {
        let md = "# Scene Title\n\nSome **bold** prose.\n\n> quoted line\n\n---\n\n- item one\n1. numbered";
        let t = md_to_typst(md);
        assert!(t.contains("== Scene Title"));
        assert!(t.contains("Some *bold* prose."));
        assert!(t.contains("#quote(block: true)[quoted line]"));
        assert!(t.contains("#sep"));
        assert!(t.contains("- item one"));
        assert!(t.contains("+ numbered"));
    }

    #[test]
    fn typst_document_shape() {
        let chapters = vec![
            (
                "The Gate".to_string(),
                vec!["Scene one.".to_string(), "Scene two.".to_string()],
            ),
            ("".to_string(), vec!["Only scene.".to_string()]),
        ];
        let settings = CompileSettings {
            title: "The Long Night".into(),
            author: "K. Author".into(),
            ..Default::default()
        };
        let doc = generate_typst(&[], &chapters, &[], &settings);
        assert!(doc.contains("#set page(paper: \"a5\""));
        assert!(doc.contains("#chapter([Chapter 1])[The Gate]"));
        assert!(doc.contains("#chapter(none)[Chapter 2]"));
        assert!(doc.contains("Scene one.\n\n#sep\n\nScene two."));
        assert!(doc.contains("The Long Night"));
        // Novel flow: paragraph spacing equals leading
        assert!(doc.contains("leading: 0.85em, spacing: 0.85em"));
    }
}

#[cfg(test)]
mod matter_tests {
    use super::*;

    #[test]
    fn matter_brackets_the_body() {
        let settings = CompileSettings::default();
        let chapters = vec![(
            "The Arrival".to_string(),
            vec!["Body text here.".to_string()],
        )];
        let front = vec!["Copyright page.".to_string()];
        let back = vec!["Acknowledgements page.".to_string()];
        let doc = generate_typst(&front, &chapters, &back, &settings);

        let copyright = doc.find("Copyright page.").unwrap();
        let restart = doc.find("#counter(page).update(1)").unwrap();
        let body = doc.find("Body text here.").unwrap();
        let ack = doc.find("Acknowledgements page.").unwrap();
        // front matter before the numbering restart, body after, back last
        assert!(copyright < restart && restart < body && body < ack);

        // markdown output brackets too
        let md = generate_markdown(&front, &chapters, &back, &settings);
        let c = md.find("Copyright page.").unwrap();
        let b = md.find("Body text here.").unwrap();
        let a = md.find("Acknowledgements page.").unwrap();
        assert!(c < b && b < a);
    }
}
