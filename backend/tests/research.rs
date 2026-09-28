//! The Research folder: never manuscript, but listable, readable and
//! clippable.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Backend {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: i64,
    /// Notifications seen while waiting for responses.
    events: Vec<Value>,
}

impl Backend {
    fn spawn(dir: &std::path::Path) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_chronicler-backend"))
            .current_dir(dir)
            .env("CHRONICLER_DELETE_PERMANENTLY", "1")
            // App-wide settings go to a scratch dir, never the real ~/.config.
            .env(
                "CHRONICLER_CONFIG_DIR",
                std::env::temp_dir().join(format!(
                    "chronicler-cfg-{}",
                    dir.file_name().unwrap().to_string_lossy()
                )),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if std::env::var_os("CHRONICLER_TEST_STDERR").is_some() {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .spawn()
            .expect("failed to spawn backend");
        let stdin = child.stdin.take().unwrap();
        let reader = BufReader::new(child.stdout.take().unwrap());
        Backend {
            child,
            stdin,
            reader,
            next_id: 1,
            events: vec![],
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{req}").unwrap();
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).unwrap() == 0 {
                panic!("backend exited before responding to {method}");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["id"].as_i64() == Some(id) {
                return v;
            }
            if v["id"].is_null() && v.get("method").is_some() {
                self.events.push(v);
            }
        }
    }

    fn ok(&mut self, method: &str, params: Value) -> Value {
        let resp = self.call(method, params.clone());
        assert!(resp["error"].is_null(), "{method} {params} failed: {}", resp["error"]);
        resp["result"].clone()
    }

    fn err(&mut self, method: &str, params: Value) -> String {
        let resp = self.call(method, params.clone());
        resp["error"]["message"]
            .as_str()
            .unwrap_or_else(|| panic!("{method} {params} should fail"))
            .to_string()
    }

    fn shutdown(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("chronicler-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn write(dir: &std::path::Path, rel: &str, content: &[u8]) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

const PROSE: &str = "The tide came in over the flats and the gulls rose and fell with it.\n";
/// Misspellings that would surely be flagged if research were checked.
const RESEARCH_TEXT: &str = "Teh harbourmastr recieved teh tidebook. Research dragon.\n";

/// A tiny web server: `/article` (HTML), `/plain` (text), `/file.pdf`
/// (not a page), anything else 404.
fn mock_site() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap_or(0);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, ctype, body) = match path.as_str() {
                    "/article" => ("200 OK", "text/html; charset=utf-8", ARTICLE.to_string()),
                    "/plain" => ("200 OK", "text/plain", "Tide tables for Kell, spring 1911.\n".to_string()),
                    "/file.pdf" => ("200 OK", "application/pdf", "%PDF-1.4".to_string()),
                    _ => ("404 Not Found", "text/plain", "nope".to_string()),
                };
                let mut out = stream;
                let _ = write!(
                    out,
                    "HTTP/1.1 {status}\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    format!("http://{addr}")
}

const ARTICLE: &str = r#"<!doctype html><html><head><title>The Tides of Kell</title></head>
<body>
<nav><a href="/">Home</a> <a href="/subscribe">Subscribe now</a></nav>
<article>
<h1>The Tides of Kell</h1>
<p>The tide at Kell comes in faster than a person can walk, and the flats that seem solid at low water become a trap within the hour. Fishermen there have learned to read the gulls, which lift off the sand a few minutes before the water turns.</p>
<p>Old records from the harbour master describe three drownings in a single winter, each of them a visitor who misjudged the turn. The locals, by contrast, speak of the tide almost fondly, as one might of a difficult relative whose moods are known.</p>
<p>Today a bell on the quay rings at the turn. It was installed after the worst of those winters and it has rung, the harbour master says, every day since.</p>
</article>
<footer><p>Copyright Coastal Weekly</p></footer>
</body></html>"#;

fn any_research(v: &Value) -> bool {
    v.to_string().to_lowercase().contains("research/")
}

#[test]
fn research_is_never_manuscript() {
    let dir = temp_dir("research-excluded");
    write(&dir, "01 Arrival/01 Cold Rain.md", PROSE.as_bytes());
    write(&dir, "Research/Harbour notes.md", RESEARCH_TEXT.as_bytes());
    write(&dir, "Research/Clippings/Tides.md", RESEARCH_TEXT.as_bytes());
    write(&dir, "Research/map.png", b"\x89PNG\r\n\x1a\nnot really");
    let mut b = Backend::spawn(&dir);

    let files = b.ok("project/list_files", json!({}));
    assert!(!files.to_string().contains("Research"), "binder shows research: {files}");
    assert!(files.to_string().contains("01 Cold Rain.md"));

    let stats = b.ok("stats/get", json!({ "today": "2026-09-28" }));
    assert!(!any_research(&stats), "stats count research: {stats}");
    assert_eq!(stats["total"], json!(PROSE.split_whitespace().count()));

    let diags = b.ok("diag/check", json!({}));
    assert!(!any_research(&diags), "research was spell-checked: {diags}");

    let hits = b.ok("project/search", json!({ "query": "dragon" }));
    assert_eq!(hits["results"], json!([]), "search reached research");

    b.shutdown();

    // Reading order, as every agent and compile sees it.
    let (app, _q) =
        chronicler_backend::App::open(&dir, chronicler_backend::app::Output::discard()).unwrap();
    assert_eq!(
        chronicler_backend::book::reading_order(&app),
        vec!["01 Arrival/01 Cold Rain.md"]
    );
    assert_eq!(app.md_files(), vec!["01 Arrival/01 Cold Rain.md"]);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn research_changes_reach_the_frontend_but_not_the_indexer() {
    let dir = temp_dir("research-watch");
    write(&dir, "ch1.md", PROSE.as_bytes());
    // The folder exists first: Linux only watches a new folder a moment
    // after it appears, so a file written straight into it goes unseen
    // (the app still hears about the folder itself).
    std::fs::create_dir_all(dir.join("Research")).unwrap();
    let mut b = Backend::spawn(&dir);
    b.ok("diag/check", json!({})); // engine warm
    write(&dir, "Research/Scratch.md", RESEARCH_TEXT.as_bytes());
    write(&dir, "ch1.md", b"Teh tide came in.\n");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let method = |e: &Value| e["method"].as_str().unwrap_or("").to_string();
    loop {
        b.ok("ping", Value::Null);
        let saw_changed = b.events.iter().any(|e| method(e) == "project/changed" && any_research(e));
        let saw_diag = b.events.iter().any(|e| method(e) == "diag/updated" && e.to_string().contains("ch1.md"));
        if saw_changed && saw_diag {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "no watcher events: {:?}", b.events);
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    for e in &b.events {
        if method(e) != "project/changed" {
            assert!(!any_research(e), "research reached the indexer: {e}");
        }
    }
    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn list_new_note_read_rename_delete() {
    let dir = temp_dir("research-crud");
    write(&dir, "ch1.md", PROSE.as_bytes());
    let mut b = Backend::spawn(&dir);

    // No folder yet: an empty list, and nothing created by looking.
    assert_eq!(b.ok("research/list", json!({}))["items"], json!([]));
    assert!(!dir.join("Research").exists());

    let p1 = b.ok("research/new_note", json!({ "name": "Harbour: people" }))["path"].clone();
    assert_eq!(p1, "Research/Harbour- people.md");
    let p2 = b.ok("research/new_note", json!({ "name": "Harbour: people" }))["path"].clone();
    assert_eq!(p2, "Research/Harbour- people 2.md");
    assert!(b.err("research/new_note", json!({ "name": "  " })).contains("name"));
    assert!(!b.err("research/new_note", json!({ "name": "..." })).is_empty());

    assert_eq!(
        b.ok("research/read", json!({ "path": "Research/Harbour- people.md" }))["text"],
        "# Harbour: people\n\n"
    );

    write(&dir, "Research/Maps/coast.jpg", b"jpeg");
    write(&dir, "Research/source.pdf", b"%PDF");
    write(&dir, "Research/Clippings/Tides.md", b"# Tides\n\nSource: <https://example.com/t>  \nClipped: 2026-09-01\n\n---\n\nBody\n");
    write(&dir, "Research/.DS_Store", b"x");
    write(&dir, "Research/table.xlsx", b"x");

    let items = b.ok("research/list", json!({}))["items"].clone();
    let summary: Vec<(String, String)> = items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["path"].as_str().unwrap().to_string(), i["kind"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("Research/Harbour- people.md".into(), "note".into()),
            ("Research/Harbour- people 2.md".into(), "note".into()),
            ("Research/Clippings/Tides.md".into(), "clipping".into()),
            ("Research/Maps/coast.jpg".into(), "image".into()),
            ("Research/source.pdf".into(), "pdf".into()),
            ("Research/table.xlsx".into(), "other".into()),
        ]
    );
    let tides = &items[2];
    assert_eq!(tides["name"], "Tides");
    assert_eq!(tides["source"], "https://example.com/t");
    assert!(tides["size"].as_i64().unwrap() > 0);
    assert!(tides["modified"].as_i64().unwrap() > 0);
    assert!(items[0].get("source").is_none_or(Value::is_null));

    // Only notes and clippings, only inside Research.
    assert!(b.err("research/read", json!({ "path": "Research/source.pdf" })).contains("isn't a note"));
    assert!(b.err("research/read", json!({ "path": "ch1.md" })).contains("Research"));
    assert!(!b.err("research/read", json!({ "path": "Research/../ch1.md" })).is_empty());
    assert!(!b.err("research/read", json!({ "path": "../outside.md" })).is_empty());
    assert!(!b.err("research/read", json!({ "path": "/etc/hosts" })).is_empty());
    assert!(!b.err("research/read", json!({ "path": ".chronicler/project.json" })).is_empty());
    assert!(b.err("research/read", json!({ "path": "Research/missing.md" })).contains("doesn't exist"));

    // A link inside Research that points out of it is refused.
    #[cfg(unix)]
    {
        let outside = temp_dir("research-outside");
        write(&outside, "secret.md", b"secret");
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("Research/link.md")).unwrap();
        assert!(b.err("research/read", json!({ "path": "Research/link.md" })).contains("outside"));
        let items = b.ok("research/list", json!({}))["items"].clone();
        assert!(!items.to_string().contains("link.md"), "symlinks are not listed");
        std::fs::remove_dir_all(&outside).ok();
    }

    // Rename and delete reuse the project methods.
    b.ok(
        "project/rename",
        json!({ "from": "Research/Harbour- people 2.md", "to": "Research/Quay.md" }),
    );
    assert!(dir.join("Research/Quay.md").exists());
    b.ok("project/delete", json!({ "path": "Research/Quay.md" }));
    assert!(!dir.join("Research/Quay.md").exists());

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn clipping_web_pages() {
    let dir = temp_dir("research-clip");
    let site = mock_site();
    let mut b = Backend::spawn(&dir);

    let r = b.ok("research/clip", json!({ "url": format!("{site}/article") }));
    assert_eq!(r["title"], "The Tides of Kell");
    assert_eq!(r["path"], "Research/Clippings/The Tides of Kell.md");
    let text = b.ok("research/read", json!({ "path": r["path"] }))["text"].as_str().unwrap().to_string();
    assert!(text.starts_with("# The Tides of Kell\n"), "{text}");
    assert!(text.contains(&format!("Source: <{site}/article>")), "{text}");
    assert!(text.contains("Clipped: 20"), "{text}");
    assert!(text.contains("faster than a person can walk"), "{text}");
    assert!(!text.contains("Subscribe now") && !text.contains("Copyright"), "{text}");

    // Clipping the same page twice keeps both.
    let again = b.ok("research/clip", json!({ "url": format!("{site}/article") }));
    assert_eq!(again["path"], "Research/Clippings/The Tides of Kell 2.md");

    let listed = b.ok("research/list", json!({}))["items"].clone();
    assert_eq!(listed[0]["kind"], "clipping");
    assert_eq!(listed[0]["source"], format!("{site}/article"));

    let plain = b.ok("research/clip", json!({ "url": format!("{site}/plain") }));
    assert_eq!(plain["path"], "Research/Clippings/plain.md");

    assert!(b.err("research/clip", json!({ "url": format!("{site}/file.pdf") })).contains("isn't a web page"));
    assert!(b.err("research/clip", json!({ "url": format!("{site}/missing") })).contains("404"));
    assert!(b.err("research/clip", json!({ "url": "file:///etc/passwd" })).contains("http"));
    assert!(b.err("research/clip", json!({ "url": "javascript:alert(1)" })).contains("http"));
    assert!(!b.err("research/clip", json!({ "url": "" })).is_empty());

    // Clippings are research: not in the binder.
    assert!(!b.ok("project/list_files", json!({})).to_string().contains("Clippings"));

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
