//! Research: material that is not manuscript — images, maps, PDFs, clipped
//! web articles, scratch notes — kept in a top-level `Research/` folder the
//! writer can also see in Finder. The manuscript walker skips it (see
//! [`fsx::is_research_path`]), so nothing here is compiled, counted, checked
//! or indexed; it is only listed, shown beside the text, and read by the
//! agent when asked.

use crate::app::App;
use crate::fsx::{RESEARCH_DIR, RelPath, is_research_path};
use crate::rpc::invalid;
use anyhow::{Context, Result};
use rig_agent::tool::{Tool, ToolContext};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ts_rs::TS;

/// Where clipped web pages are saved.
pub const CLIPPINGS_DIR: &str = "Research/Clippings";

/// Largest page `clip` will download.
const MAX_PAGE_BYTES: usize = 5 * 1024 * 1024;
/// Total time allowed for fetching a page.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// Largest note or clipping `read` returns.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
/// What the agent tool returns of one item, in characters.
const TOOL_TEXT_CHARS: usize = 32_000;

// ---------- Items ----------

#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ResearchKind {
    Note,
    Clipping,
    Image,
    Pdf,
    Other,
}

impl ResearchKind {
    /// Notes and clippings have text the writer (and the agent) can read.
    pub fn is_text(self) -> bool {
        matches!(self, ResearchKind::Note | ResearchKind::Clipping)
    }
}

/// One file in the research folder.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(optional_fields)]
pub struct ResearchItem {
    /// Project-relative path, e.g. `Research/Clippings/Tides.md`.
    pub path: String,
    /// File name, without `.md` for notes and clippings.
    pub name: String,
    pub kind: ResearchKind,
    /// Bytes.
    pub size: i64,
    /// Last modified, milliseconds since the Unix epoch.
    pub modified: i64,
    /// The page a clipping came from.
    pub source: Option<String>,
}

fn extension(rel: &str) -> String {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// What a research file is, from its path.
pub fn kind_of(rel: &str) -> ResearchKind {
    match extension(rel).as_str() {
        "md" | "markdown" | "txt" => {
            if rel.to_lowercase().starts_with("research/clippings/") {
                ResearchKind::Clipping
            } else {
                ResearchKind::Note
            }
        }
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "svg" | "ico" => {
            ResearchKind::Image
        }
        "pdf" => ResearchKind::Pdf,
        _ => ResearchKind::Other,
    }
}

fn display_name(rel: &str, kind: ResearchKind) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    if kind.is_text() {
        base.strip_suffix(".md").unwrap_or(base).to_string()
    } else {
        base.to_string()
    }
}

fn research_root(app: &App) -> PathBuf {
    app.root.join(RESEARCH_DIR)
}

/// Every file under `Research/`, notes first, then by name. Hidden files
/// are skipped and symlinks are never followed. An absent folder is an
/// empty list (it is created on first use, not by looking).
pub fn list(app: &App) -> Result<Vec<ResearchItem>> {
    let mut items = Vec::new();
    // The folder itself must be a real folder, not a link out of the project.
    let root = research_root(app);
    if std::fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
        collect(&root, RESEARCH_DIR, &mut items);
    }
    items.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(items)
}

fn collect(dir: &Path, prefix: &str, out: &mut Vec<ResearchItem>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let rel = format!("{prefix}/{name}");
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir() {
            collect(&entry.path(), &rel, out);
        } else if meta.is_file() {
            let kind = kind_of(&rel);
            let source = if kind == ResearchKind::Clipping {
                read_head(&entry.path()).and_then(|h| parse_source(&h))
            } else {
                None
            };
            out.push(ResearchItem {
                name: display_name(&rel, kind),
                path: rel,
                kind,
                size: meta.len() as i64,
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as i64),
                source,
            });
        }
    }
}

fn read_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = vec![0u8; 4096];
    let n = std::fs::File::open(path).ok()?.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A client-supplied path that must name something inside `Research/`,
/// with no symlink along the way leading out of it.
pub fn resolve(app: &App, raw: &str) -> Result<(RelPath, PathBuf)> {
    let rel = RelPath::parse(raw)?;
    if !is_research_path(rel.as_str()) || rel.as_str().eq_ignore_ascii_case(RESEARCH_DIR) {
        return Err(invalid(format!("“{rel}” isn't in the Research folder")));
    }
    let abs = rel.to_path(&app.root);
    if std::fs::symlink_metadata(research_root(app)).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(invalid("The Research folder is a link to somewhere else"));
    }
    if let (Ok(real), Ok(root)) = (abs.canonicalize(), research_root(app).canonicalize())
        && !real.starts_with(&root)
    {
        return Err(invalid(format!("“{rel}” leads outside the Research folder")));
    }
    Ok((rel, abs))
}

/// The text of a note or clipping.
pub fn read_text(app: &App, raw: &str) -> Result<String> {
    let (rel, abs) = resolve(app, raw)?;
    if !kind_of(rel.as_str()).is_text() {
        return Err(invalid(format!("“{rel}” isn't a note or clipping")));
    }
    let meta = std::fs::metadata(&abs).map_err(|_| invalid(format!("“{rel}” doesn't exist")))?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(invalid(format!("“{rel}” is too large to read")));
    }
    let bytes = std::fs::read(&abs).with_context(|| format!("reading {rel}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---------- Creating ----------

/// A title made safe for a file name: no path separators or characters
/// Finder and Windows refuse, no leading dots, a sensible length.
pub fn safe_file_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches(['.', ' ', '-']).trim_end_matches(['.', ' ']);
    let mut out: String = trimmed.chars().take(80).collect();
    out = out.trim_end_matches(['.', ' ']).to_string();
    out
}

/// `dir/stem.ext`, or `dir/stem 2.ext`, … — whichever doesn't exist yet.
fn unique_path(app: &App, dir: &str, stem: &str, ext: &str) -> Result<RelPath> {
    for n in 1.. {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} {n}.{ext}")
        };
        let rel = RelPath::parse(&format!("{dir}/{name}"))?;
        if std::fs::symlink_metadata(rel.to_path(&app.root)).is_err() {
            return Ok(rel);
        }
    }
    unreachable!()
}

fn ensure_dir(app: &App, dir: &str) -> Result<()> {
    std::fs::create_dir_all(app.root.join(dir)).with_context(|| format!("creating {dir}"))
}

/// A new, empty note: `Research/<name>.md`.
pub fn new_note(app: &App, name: &str) -> Result<RelPath> {
    let stem = safe_file_stem(name);
    if stem.is_empty() {
        return Err(invalid("Give the note a name first"));
    }
    ensure_dir(app, RESEARCH_DIR)?;
    let rel = unique_path(app, RESEARCH_DIR, &stem, "md")?;
    app.write(&rel, &format!("# {}\n\n", name.trim()))?;
    Ok(rel)
}

// ---------- Clipping web pages ----------

/// The readable part of a web page.
#[derive(Debug, Clone, PartialEq)]
pub struct Extracted {
    pub title: String,
    /// Markdown.
    pub body: String,
}

/// Pull the article out of a page (readability-style) and turn it into
/// markdown. Remote images are dropped: the app never loads them.
pub fn extract(html: &str, url: &str) -> Result<Extracted> {
    let cfg = dom_smoothie::Config {
        text_mode: dom_smoothie::TextMode::Markdown,
        max_elements_to_parse: 60_000,
        ..Default::default()
    };
    let mut reader = dom_smoothie::Readability::new(html, Some(url), Some(cfg))
        .map_err(|e| anyhow::anyhow!("reading the page: {e}"))?;
    let article = reader
        .parse()
        .map_err(|_| invalid("Couldn't find an article to clip on that page"))?;
    let body = tidy_markdown(&article.text_content);
    if body.trim().is_empty() {
        return Err(invalid("Couldn't find an article to clip on that page"));
    }
    let title = article.title.split_whitespace().collect::<Vec<_>>().join(" ");
    Ok(Extracted {
        title: if title.is_empty() { fallback_title(url) } else { title },
        body,
    })
}

fn tidy_markdown(md: &str) -> String {
    use std::sync::LazyLock;
    static IMAGE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
    static BLANKS: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\n[ \t]*(\n[ \t]*){2,}").unwrap());
    let no_images = IMAGE.replace_all(md, "");
    let lines: Vec<&str> = no_images.lines().map(str::trim_end).collect();
    BLANKS
        .replace_all(&lines.join("\n"), "\n\n")
        .trim()
        .to_string()
}

fn fallback_title(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "Clipping".into())
}

/// A clipping file: title, where and when it came from, then the article.
pub fn clipping_document(title: &str, url: &str, date: &str, body: &str) -> String {
    format!("# {title}\n\nSource: <{url}>  \nClipped: {date}\n\n---\n\n{body}\n")
}

/// The source URL recorded at the top of a clipping.
pub fn parse_source(head: &str) -> Option<String> {
    head.lines().take(12).find_map(|l| {
        let rest = l.trim().strip_prefix("Source:")?.trim();
        let url = rest.strip_prefix('<').and_then(|r| r.split('>').next()).unwrap_or(rest);
        (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
    })
}

/// Today as `YYYY-MM-DD` (UTC).
fn today() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() / 86_400) as i64;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Only web pages: `http` and `https`.
pub fn check_url(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| invalid("That doesn't look like a web address"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("Only web pages (http or https) can be clipped"));
    }
    Ok(url)
}

enum Page {
    Html(String),
    Text(String),
}

async fn fetch(url: &reqwest::Url) -> Result<(reqwest::Url, Page)> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Mozilla/5.0 (compatible; Chronicler research clipper)")
        .build()?;
    let mut resp = client
        .get(url.clone())
        .header("accept", "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5")
        .send()
        .await
        .map_err(|e| invalid(format!("Couldn't reach that page: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(invalid(format!("The page answered {status}")));
    }
    let final_url = resp.url().clone();
    if !matches!(final_url.scheme(), "http" | "https") {
        return Err(invalid("That page redirected somewhere that isn't a web page"));
    }
    if resp.content_length().is_some_and(|n| n > MAX_PAGE_BYTES as u64) {
        return Err(invalid("That page is too large to clip"));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html")
        .to_ascii_lowercase();
    let is_html = content_type.contains("html") || content_type.contains("xml");
    let is_text = content_type.starts_with("text/plain") || content_type.starts_with("text/markdown");
    if !is_html && !is_text {
        let kind = content_type.split(';').next().unwrap_or("").trim().to_string();
        return Err(invalid(format!(
            "That link isn't a web page ({kind}). Download it and use Add files instead."
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| invalid(format!("The page stopped loading: {e}")))?
    {
        if body.len() + chunk.len() > MAX_PAGE_BYTES {
            return Err(invalid("That page is too large to clip"));
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    Ok((final_url, if is_html { Page::Html(text) } else { Page::Text(text) }))
}

/// Fetch a web page, keep its readable article as markdown, and save it to
/// `Research/Clippings/<title>.md`. Returns the new path and the title.
pub async fn clip(app: &Arc<App>, raw_url: &str) -> Result<(RelPath, String)> {
    let url = check_url(raw_url)?;
    let (final_url, page) = fetch(&url).await?;
    let source = url.to_string();
    let page_url = final_url.to_string();
    app.blocking(move |app| {
        let Extracted { title, body } = match page {
            Page::Html(html) => extract(&html, &page_url)?,
            Page::Text(text) => {
                if text.trim().is_empty() {
                    return Err(invalid("That page is empty"));
                }
                let name = final_url
                    .path_segments()
                    .and_then(|mut s| s.next_back().map(str::to_string))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| fallback_title(&page_url));
                Extracted { title: name, body: text.trim().to_string() }
            }
        };
        let mut stem = safe_file_stem(&title);
        if stem.is_empty() {
            stem = safe_file_stem(&fallback_title(&page_url));
        }
        if stem.is_empty() {
            stem = "Clipping".into();
        }
        ensure_dir(app, CLIPPINGS_DIR)?;
        let rel = unique_path(app, CLIPPINGS_DIR, &stem, "md")?;
        app.write(&rel, &clipping_document(&title, &source, &today(), &body))?;
        Ok((rel, title))
    })
    .await
}

// ---------- The agent's tool ----------

/// Read-only access to the research folder for the chat agent: list what's
/// there, or read one note or clipping. Register with
/// `.tool(ResearchTool::new(app.clone()))`.
pub struct ResearchTool {
    app: Arc<App>,
}

impl ResearchTool {
    pub fn new(app: Arc<App>) -> Self {
        ResearchTool { app }
    }
}

#[derive(Deserialize)]
pub struct ResearchArgs {
    path: Option<String>,
}

#[derive(Debug)]
pub struct ResearchToolError(String);

impl std::fmt::Display for ResearchToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ResearchToolError {}

fn tool_fail(e: anyhow::Error) -> ResearchToolError {
    ResearchToolError(format!("{e:#}"))
}

impl Tool for ResearchTool {
    const NAME: &'static str = "read_research";
    type Args = ResearchArgs;
    type Output = Value;
    type Error = ResearchToolError;

    fn description(&self) -> String {
        "The writer's research folder: notes, clipped web articles, images and PDFs they keep \
         beside the book. It is background material, not the manuscript. Without a path: lists \
         every item. With a path: returns the text of one note or clipping. Only use it when the \
         writer asks about their research or notes."
            .into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "A note or clipping path from the list, e.g. \"Research/Clippings/Tides.md\"; omit to list everything" }
            }
        })
    }

    async fn call(&self, _ctx: &mut ToolContext, args: Self::Args) -> Result<Value, ResearchToolError> {
        let path = args.path.filter(|p| !p.trim().is_empty());
        self.app
            .blocking(move |app| {
                let Some(path) = path else {
                    let items = list(app)?;
                    return Ok(json!({
                        "items": items.iter().map(|i| {
                            let mut v = json!({ "path": i.path, "name": i.name, "kind": i.kind, "readable": i.kind.is_text() });
                            if let Some(s) = &i.source { v["source"] = json!(s); }
                            v
                        }).collect::<Vec<_>>(),
                    }));
                };
                let text = read_text(app, &path)?;
                let capped: String = text.chars().take(TOOL_TEXT_CHARS).collect();
                Ok(json!({
                    "path": path,
                    "truncated": capped.len() < text.len(),
                    "text": capped,
                }))
            })
            .await
            .map_err(tool_fail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTICLE: &str = r#"<!doctype html><html><head><title>The Tides of Kell | Coastal Weekly</title></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe now</a></nav>
<div class="sidebar"><p>Advertisement</p><ul><li><a href="/x">Trending</a></li></ul></div>
<article>
<h1>The Tides of Kell</h1>
<p>The tide at Kell comes in faster than a person can walk, and the flats that seem solid at low water become a trap within the hour. Fishermen there have learned to read the gulls, which lift off the sand a few minutes before the water turns.</p>
<p>Old records from the harbour master describe <a href="/history">three drownings</a> in a single winter, each of them a visitor who misjudged the turn. The locals, by contrast, speak of the tide almost fondly, as one might of a difficult relative whose moods are known.</p>
<img src="https://cdn.example.com/flats.jpg" alt="The flats at dusk">
<p>Today a bell on the quay rings at the turn. It was installed after the worst of those winters and it has rung, the harbour master says, every day since, whatever the weather and whoever is listening.</p>
</article>
<footer><p>Copyright Coastal Weekly</p></footer>
</body></html>"#;

    #[test]
    fn extracts_the_article_as_markdown() {
        let e = extract(ARTICLE, "https://example.com/kell").unwrap();
        assert!(e.title.contains("Tides of Kell"), "title: {}", e.title);
        assert!(e.body.contains("faster than a person can walk"), "{}", e.body);
        assert!(e.body.contains("bell on the quay"));
        // Relative links become absolute markdown links; images and chrome go.
        assert!(e.body.contains("(https://example.com/history)"), "{}", e.body);
        assert!(!e.body.contains("flats.jpg"));
        assert!(!e.body.contains("Subscribe now"));
        assert!(!e.body.contains("Copyright"));
    }

    #[test]
    fn a_page_without_an_article_is_refused() {
        assert!(extract("<html><body></body></html>", "https://example.com/").is_err());
    }

    #[test]
    fn tidy_drops_images_and_extra_blank_lines() {
        assert_eq!(tidy_markdown("a\n\n\n\n![x](http://i/p.png)\nb  \n"), "a\n\nb");
    }

    #[test]
    fn clipping_header_round_trips_its_source() {
        let doc = clipping_document("T", "https://example.com/a?b=1", "2026-09-28", "Body");
        assert_eq!(parse_source(&doc).as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(parse_source("# Note\n\nSource: somewhere"), None);
    }

    #[test]
    fn file_stems_are_safe() {
        assert_eq!(safe_file_stem("  Kell: a/b  history? "), "Kell- a-b history-");
        assert_eq!(safe_file_stem("...hidden"), "hidden");
        assert_eq!(safe_file_stem("../../etc"), "etc");
        assert_eq!(safe_file_stem("   "), "");
        assert!(safe_file_stem(&"x".repeat(300)).chars().count() <= 80);
    }

    #[test]
    fn kinds_by_extension_and_folder() {
        assert_eq!(kind_of("Research/a.md"), ResearchKind::Note);
        assert_eq!(kind_of("Research/Clippings/a.md"), ResearchKind::Clipping);
        assert_eq!(kind_of("Research/map.PNG"), ResearchKind::Image);
        assert_eq!(kind_of("Research/x.pdf"), ResearchKind::Pdf);
        assert_eq!(kind_of("Research/x.docx"), ResearchKind::Other);
    }

    #[test]
    fn only_web_urls() {
        assert!(check_url("https://example.com").is_ok());
        assert!(check_url("http://127.0.0.1:8080/a").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "not a url", "data:text/html,hi"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn today_is_a_date() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert!(t.starts_with("20"));
    }
}
