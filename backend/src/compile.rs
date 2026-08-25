use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

// Manuscript compilation: chapters (each a list of scene files) are converted
// from our markdown subset to Typst, wrapped in a template driven by the
// wizard's settings, and rendered with the system `typst` binary.

#[derive(Deserialize)]
pub struct ChapterSpec {
    pub title: String,
    /// Project-relative scene file paths, in order. The RPC layer reads them
    /// (path-confined) and hands contents to `run`.
    pub scenes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CompileSettings {
    pub title: String,
    pub author: String,
    pub paper: String,
    pub font_size: f64,
    pub font_family: String,
    pub line_spacing: f64,
    pub justify: bool,
    pub first_line_indent: bool,
    pub title_page: bool,
    pub chapter_page_breaks: bool,
    pub numbering: bool,
    pub scene_separator: String,
    pub custom_preamble: String,
    pub format: String,
}

impl Default for CompileSettings {
    fn default() -> Self {
        CompileSettings {
            title: String::new(),
            author: String::new(),
            paper: "a4".into(),
            font_size: 12.0,
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
        }
    }
}

/// Escape characters that Typst would interpret as markup.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '*' | '_' | '#' | '@' | '$' | '\\' | '<' | '>' | '[' | ']' | '~' | '`' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
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
    let mut keep = |s: String, stash: &mut Vec<String>| -> String {
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
            keep(format!("#link(\"{}\")[{}]", esc_string(&c[2]), esc(&c[1])), &mut stash)
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
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{e000}' {
            let mut idx = String::new();
            for d in chars.by_ref() {
                if d == '\u{e001}' {
                    break;
                }
                idx.push(d);
            }
            if let Ok(i) = idx.parse::<usize>() {
                out.push_str(&stash[i]);
            }
        } else {
            match c {
                '*' | '_' | '#' | '@' | '$' | '\\' | '<' | '>' | '[' | ']' | '~' | '`' => {
                    out.push('\\');
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
    }
    out
}

fn is_hr(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 3
        && (t.chars().all(|c| c == '-') || t.chars().all(|c| c == '*') || t.chars().all(|c| c == '_'))
}

/// Convert a scene's markdown body to Typst markup.
pub fn md_to_typst(md: &str) -> String {
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
                out.push(format!("{} {}", "=".repeat(depth), convert_inline(&trimmed[level + 1..])));
                continue;
            }
        }

        if is_hr(line) {
            out.push("#sep".to_string());
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            out.push(format!("- {}", convert_inline(rest)));
            continue;
        }
        if let Some(pos) = trimmed.find(". ") {
            if pos > 0 && trimmed[..pos].chars().all(|c| c.is_ascii_digit()) {
                out.push(format!("+ {}", convert_inline(&trimmed[pos + 2..])));
                continue;
            }
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

fn chapter_heading(index: usize, title: &str, numbering: bool) -> String {
    let title = title.trim();
    match (numbering, title.is_empty()) {
        (true, false) => format!("= Chapter {} \\ {}", index, esc(title)),
        (true, true) => format!("= Chapter {}", index),
        (false, _) => format!("= {}", esc(title)),
    }
}

/// Generate the full Typst source for the manuscript.
pub fn generate_typst(chapters: &[(String, Vec<String>)], s: &CompileSettings) -> String {
    let mut doc = String::new();

    let paper = match s.paper.as_str() {
        "a5" => "a5",
        "us-letter" => "us-letter",
        _ => "a4",
    };

    doc.push_str(&format!(
        "#set page(paper: \"{}\", numbering: \"1\", margin: (x: 2.2cm, y: 2.4cm))\n",
        paper
    ));
    if s.font_family.trim().is_empty() {
        doc.push_str(&format!("#set text(size: {}pt)\n", s.font_size));
    } else {
        doc.push_str(&format!(
            "#set text(size: {}pt, font: \"{}\")\n",
            s.font_size,
            esc_string(s.font_family.trim())
        ));
    }
    let indent = if s.first_line_indent { ", first-line-indent: 1.2em" } else { "" };
    doc.push_str(&format!(
        "#set par(justify: {}, leading: {}em{})\n",
        s.justify, s.line_spacing, indent
    ));
    doc.push_str(&format!(
        "#let sep = align(center)[#v(0.5em)#text(\"{}\")#v(0.5em)]\n",
        esc_string(&s.scene_separator)
    ));
    doc.push_str("#show heading.where(level: 1): it => {\n");
    if s.chapter_page_breaks {
        doc.push_str("  pagebreak(weak: true)\n");
    }
    doc.push_str("  v(15%)\n  align(center, text(size: 1.5em, weight: \"bold\", it.body))\n  v(3em)\n}\n");
    doc.push_str("#show heading: set text(hyphenate: false)\n");

    if !s.custom_preamble.trim().is_empty() {
        doc.push_str("\n// Custom preamble\n");
        doc.push_str(s.custom_preamble.trim());
        doc.push('\n');
    }

    if s.title_page {
        doc.push_str(&format!(
            "\n#align(center + horizon)[#text(size: 2em, weight: \"bold\")[{}]",
            esc(if s.title.trim().is_empty() { "Untitled" } else { s.title.trim() })
        ));
        if !s.author.trim().is_empty() {
            doc.push_str(&format!(" #v(1.5em) #text(size: 1.2em)[{}]", esc(s.author.trim())));
        }
        doc.push_str("]\n#pagebreak()\n");
    }

    for (i, (title, scenes)) in chapters.iter().enumerate() {
        doc.push('\n');
        doc.push_str(&chapter_heading(i + 1, title, s.numbering));
        doc.push_str("\n\n");
        let bodies: Vec<String> = scenes.iter().map(|md| md_to_typst(md)).collect();
        doc.push_str(&bodies.join("\n\n#sep\n\n"));
        doc.push('\n');
    }

    doc
}

/// Concatenated-markdown output for the "markdown" format.
pub fn generate_markdown(chapters: &[(String, Vec<String>)], s: &CompileSettings) -> String {
    let mut doc = String::new();
    if !s.title.trim().is_empty() {
        doc.push_str(&format!("# {}\n", s.title.trim()));
        if !s.author.trim().is_empty() {
            doc.push_str(&format!("\nby {}\n", s.author.trim()));
        }
        doc.push('\n');
    }
    for (i, (title, scenes)) in chapters.iter().enumerate() {
        let heading = match (s.numbering, title.trim().is_empty()) {
            (true, false) => format!("Chapter {} — {}", i + 1, title.trim()),
            (true, true) => format!("Chapter {}", i + 1),
            (false, _) => title.trim().to_string(),
        };
        doc.push_str(&format!("\n# {}\n\n", heading));
        doc.push_str(&scenes.join(&format!("\n\n{}\n\n", s.scene_separator)));
        doc.push('\n');
    }
    doc
}

/// Build the manuscript into `.chronicler/build/` and return the artifact path.
pub fn run(
    root: &Path,
    chapters: Vec<(String, Vec<String>)>,
    settings: &CompileSettings,
) -> Result<PathBuf> {
    let build_dir = root.join(".chronicler").join("build");
    std::fs::create_dir_all(&build_dir).context("creating build dir")?;

    match settings.format.as_str() {
        "markdown" => {
            let out = build_dir.join("manuscript.md");
            std::fs::write(&out, generate_markdown(&chapters, settings)).context("writing markdown")?;
            Ok(out)
        }
        "typst" => {
            let out = build_dir.join("manuscript.typ");
            std::fs::write(&out, generate_typst(&chapters, settings)).context("writing typst source")?;
            Ok(out)
        }
        _ => {
            // pdf (default)
            let typ = build_dir.join("manuscript.typ");
            let pdf = build_dir.join("manuscript.pdf");
            std::fs::write(&typ, generate_typst(&chapters, settings)).context("writing typst source")?;
            let output = std::process::Command::new("typst")
                .arg("compile")
                .arg(&typ)
                .arg(&pdf)
                .output()
                .context("running typst — is it installed and on PATH?")?;
            if !output.status.success() {
                bail!("typst compile failed:\n{}", String::from_utf8_lossy(&output.stderr));
            }
            Ok(pdf)
        }
    }
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
            ("The Gate".to_string(), vec!["Scene one.".to_string(), "Scene two.".to_string()]),
            ("".to_string(), vec!["Only scene.".to_string()]),
        ];
        let mut settings = CompileSettings::default();
        settings.title = "The Long Night".into();
        settings.author = "K. Author".into();
        let doc = generate_typst(&chapters, &settings);
        assert!(doc.contains("#set page(paper: \"a4\""));
        assert!(doc.contains("= Chapter 1 \\ The Gate"));
        assert!(doc.contains("= Chapter 2\n"));
        assert!(doc.contains("Scene one.\n\n#sep\n\nScene two."));
        assert!(doc.contains("The Long Night"));
    }
}
