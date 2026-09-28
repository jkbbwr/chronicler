//! The book as a whole: its reading order (the binder's, from
//! `.chronicler/order.json`), what the writer says it is (`project.json`'s
//! brief), and a compact map of chapters and scenes that every agent gets
//! so it knows the shape of the book without searching for it.

use crate::app::App;
use crate::fsx::{self, is_matter_path, is_research_path};
use rusqlite::Connection;
use serde::Deserialize;
use std::collections::HashMap;

/// `project.json`, as far as agents care.
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct BookInfo {
    pub name: String,
    pub author: String,
    pub brief: Brief,
}

/// "About this book", written in Settings.
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Brief {
    pub genre: String,
    pub audience: String,
    pub narration: String,
    pub comparables: String,
    pub tone: String,
    pub notes: String,
}

pub fn info(app: &App) -> BookInfo {
    std::fs::read_to_string(app.root.join(".chronicler/project.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The writer's description of the book, for system prompts. Empty when
/// nothing has been filled in.
pub fn brief_text(info: &BookInfo) -> String {
    let b = &info.brief;
    let mut lines = Vec::new();
    if !info.name.trim().is_empty() {
        let by = if info.author.trim().is_empty() { String::new() } else { format!(" by {}", info.author.trim()) };
        lines.push(format!("Title: {}{by}", info.name.trim()));
    }
    for (label, value) in [
        ("Genre", &b.genre),
        ("Readers", &b.audience),
        ("Narration (point of view, tense)", &b.narration),
        ("Comparable books", &b.comparables),
        ("Tone", &b.tone),
        ("The writer's notes (deliberate choices — respect them)", &b.notes),
    ] {
        if !value.trim().is_empty() {
            lines.push(format!("{label}: {}", value.trim()));
        }
    }
    lines.join("\n")
}

type OrderMap = HashMap<String, Vec<String>>;

fn order_map(app: &App) -> OrderMap {
    std::fs::read_to_string(app.root.join(".chronicler/order.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Every scene in the order a reader meets it: the binder's manual order
/// where set, then folders before files, then by name (mirroring
/// `buildTree` in the frontend). Front/Back Matter and Research excluded.
pub fn reading_order(app: &App) -> Vec<String> {
    let order = order_map(app);
    let entries = fsx::walk(&app.root);
    let mut children: HashMap<String, Vec<(String, bool)>> = HashMap::new();
    for e in entries {
        if !e.is_dir && !e.path.ends_with(".md") {
            continue;
        }
        let (parent, name) = match e.path.rsplit_once('/') {
            Some((p, n)) => (p.to_string(), n.to_string()),
            None => (String::new(), e.path.clone()),
        };
        children.entry(parent).or_default().push((name, e.is_dir));
    }
    let mut out = Vec::new();
    visit(&children, &order, "", &mut out);
    out.retain(|p| !is_matter_path(p) && !is_research_path(p));
    out
}

fn visit(children: &HashMap<String, Vec<(String, bool)>>, order: &OrderMap, parent: &str, out: &mut Vec<String>) {
    let Some(kids) = children.get(parent) else { return };
    let mut kids = kids.clone();
    sort_children(&mut kids, order.get(parent).map(Vec::as_slice).unwrap_or(&[]));
    for (name, is_dir) in kids {
        let path = if parent.is_empty() { name.clone() } else { format!("{parent}/{name}") };
        if is_dir {
            visit(children, order, &path, out);
        } else {
            out.push(path);
        }
    }
}

/// The binder's order within one folder: manual order first, then folders
/// before files, then by name.
fn sort_children(kids: &mut [(String, bool)], manual: &[String]) {
    kids.sort_by(|(a, a_dir), (b, b_dir)| {
        let ia = manual.iter().position(|n| n == a);
        let ib = manual.iter().position(|n| n == b);
        match (ia, ib) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => b_dir.cmp(a_dir).then_with(|| a.to_lowercase().cmp(&b.to_lowercase())),
        }
    });
}

/// One folder's entries ("" = top level) in binder order, as
/// (name, is_folder).
pub fn folder_order(app: &App, parent: &str) -> Vec<(String, bool)> {
    let mut kids: Vec<(String, bool)> = fsx::walk(&app.root)
        .into_iter()
        .filter(|e| e.is_dir || e.path.ends_with(".md"))
        .filter_map(|e| {
            let (p, n) = e.path.rsplit_once('/').unwrap_or(("", e.path.as_str()));
            (p == parent).then(|| (n.to_string(), e.is_dir))
        })
        .collect();
    sort_children(&mut kids, order_map(app).get(parent).map(Vec::as_slice).unwrap_or(&[]));
    kids
}

/// Pin one folder's order in `order.json` (what the binder's drag and drop
/// writes).
pub fn set_folder_order(app: &App, parent: &str, names: Vec<String>) -> anyhow::Result<()> {
    let mut order = order_map(app);
    order.insert(parent.to_string(), names);
    std::fs::create_dir_all(app.root.join(".chronicler"))?;
    app.write(&fsx::RelPath::document(".chronicler/order.json")?, &serde_json::to_string_pretty(&order)?)
}

/// "03 The Gate.md" → "The Gate".
pub fn display_name(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md");
    let stripped = base.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches([' ', '.', '_', '-']);
    if stripped.is_empty() { base.to_string() } else { stripped.to_string() }
}

/// Synopsis and status per scene.
pub fn scene_meta(conn: &Connection) -> HashMap<String, (String, String)> {
    let Ok(mut stmt) = conn.prepare("SELECT file, synopsis, status FROM scene_meta") else {
        return HashMap::new();
    };
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?))))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// A compact table of contents: chapters, scenes in reading order, their
/// synopses. Bounded so it never crowds out the real work.
pub fn map_text(app: &App, order: &[String]) -> String {
    let meta = app.db.with(|c| Ok(scene_meta(c))).unwrap_or_default();
    let labels = crate::story::detail_labels(app);
    let mut out = String::new();
    let mut chapter = String::new();
    for (i, path) in order.iter().enumerate() {
        let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        if dir != chapter {
            chapter = dir.to_string();
            if !chapter.is_empty() {
                out.push_str(&format!("\n{}\n", chapter.replace('/', " › ")));
            }
        }
        let (synopsis, status) = meta.get(path).cloned().unwrap_or_default();
        let mut line = format!("  {}. {} <{}>", i + 1, display_name(path), path);
        if !status.is_empty() {
            line.push_str(&format!(" [{status}]"));
        }
        if let Some(l) = labels.get(path) {
            line.push_str(&format!(" ({l})"));
        }
        if !synopsis.trim().is_empty() {
            line.push_str(&format!(" — {}", synopsis.trim().replace('\n', " ")));
        }
        out.push_str(&line);
        out.push('\n');
        if out.len() > 12_000 {
            out.push_str(&format!("  … and {} more scenes\n", order.len() - i - 1));
            break;
        }
    }
    out
}

/// Book context for any agent: what the book is, and how it's laid out.
pub fn context(app: &App) -> String {
    let info = info(app);
    let order = reading_order(app);
    let mut out = String::new();
    let brief = brief_text(&info);
    if !brief.is_empty() {
        out.push_str("# About this book (from the writer)\n");
        out.push_str(&brief);
        out.push_str("\n\n");
    }
    if !order.is_empty() {
        out.push_str("# The book, in reading order\n");
        out.push_str(&map_text(app, &order));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_drop_sort_prefixes() {
        assert_eq!(display_name("Ch 1/03 The Gate.md"), "The Gate");
        assert_eq!(display_name("Prologue.md"), "Prologue");
        assert_eq!(display_name("1984.md"), "1984");
    }

    #[test]
    fn reading_order_follows_the_binder() {
        let dir = std::env::temp_dir().join(format!("chronicler-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in ["B/2.md", "B/1.md", "A/x.md", "loose.md", "Front Matter/Title.md"] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "text").unwrap();
        }
        std::fs::create_dir_all(dir.join(".chronicler")).unwrap();
        std::fs::write(dir.join(".chronicler/order.json"), r#"{"": ["B", "A"], "B": ["2.md", "1.md"]}"#).unwrap();
        let (app, _q) = App::open(&dir, crate::app::Output::discard()).unwrap();
        assert_eq!(reading_order(&app), vec!["B/2.md", "B/1.md", "A/x.md", "loose.md"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
