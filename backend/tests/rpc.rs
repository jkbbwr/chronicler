use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Backend {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: i64,
}

impl Backend {
    fn spawn(dir: &std::path::Path) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_chronicler-backend"))
            .current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn backend");
        let stdin = child.stdin.take().unwrap();
        let reader = BufReader::new(child.stdout.take().unwrap());
        Backend { child, stdin, reader, next_id: 1 }
    }

    /// Send one request and read lines until its response arrives,
    /// skipping notifications (e.g. project/changed from the watcher).
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{}", req).unwrap();
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).unwrap() == 0 {
                panic!("backend exited before responding to {}", method);
            }
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"].as_i64() == Some(id) {
                return v;
            }
        }
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

#[test]
fn documents_and_search() {
    let dir = temp_dir("docs");
    let mut b = Backend::spawn(&dir);

    assert_eq!(b.call("ping", Value::Null)["result"], "pong");

    let save = b.call("document/save", serde_json::json!({ "rel_path": "a.md", "content": "# Hello\nworld dragon" }));
    assert_eq!(save["result"]["success"], true);

    let read = b.call("document/read", serde_json::json!({ "rel_path": "a.md" }));
    assert_eq!(read["result"]["content"], "# Hello\nworld dragon");

    let traversal = b.call("document/read", serde_json::json!({ "rel_path": "../outside.md" }));
    assert!(traversal["error"]["message"].as_str().unwrap().contains("escapes"));

    let absolute = b.call("project/delete", serde_json::json!({ "path": "/tmp" }));
    assert!(absolute["error"]["message"].as_str().unwrap().contains("Absolute"));

    let search = b.call("project/search", serde_json::json!({ "query": "DRAGON" }));
    let results = search["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["file"], "a.md");
    assert_eq!(results[0]["line"], 2);

    let list = b.call("project/list_files", Value::Null);
    let files = list["result"]["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f["name"] == "a.md"));

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn compile_manuscript() {
    let dir = temp_dir("compile");
    let mut b = Backend::spawn(&dir);

    b.call("project/create_folder", serde_json::json!({ "rel_path": "01 Arrival" }));
    b.call("document/save", serde_json::json!({ "rel_path": "01 Arrival/scene1.md", "content": "She **arrived** at last." }));
    b.call("document/save", serde_json::json!({ "rel_path": "01 Arrival/scene2.md", "content": "# Later\n\nA *quiet* evening — cost: $5." }));

    let chapters = serde_json::json!([{ "title": "Arrival", "scenes": ["01 Arrival/scene1.md", "01 Arrival/scene2.md"] }]);

    // Settings persistence in the project db
    let set = b.call("db/set", serde_json::json!({ "key": "compile", "value": "{\"paper\":\"a5\"}" }));
    assert_eq!(set["result"]["success"], true);
    let got = b.call("db/get", serde_json::json!({ "key": "compile" }));
    assert_eq!(got["result"]["value"], "{\"paper\":\"a5\"}");
    assert!(dir.join(".chronicler").join("db").exists());

    // Typst-source compile (no external binary needed)
    let run = b.call("compile/run", serde_json::json!({
        "chapters": chapters,
        "settings": { "format": "typst", "title": "Test Book", "author": "A. Writer" }
    }));
    let out = run["result"]["output"].as_str().expect("compile failed");
    assert!(out.ends_with("manuscript.typ"));
    let typ = std::fs::read_to_string(out).unwrap();
    assert!(typ.contains("= Chapter 1 \\ Arrival"));
    assert!(typ.contains("*arrived*"));
    assert!(typ.contains("_quiet_"));
    assert!(typ.contains("\\$5")); // typst specials escaped
    assert!(typ.contains("#sep")); // scene separator between the two scenes
    assert!(typ.contains("Test Book"));

    // Full PDF render when typst is available
    let typst_present = std::process::Command::new("typst")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if typst_present {
        let run = b.call("compile/run", serde_json::json!({
            "chapters": chapters,
            "settings": { "format": "pdf", "title": "Test Book" }
        }));
        let out = run["result"]["output"].as_str().expect("pdf compile failed");
        assert!(out.ends_with("manuscript.pdf"));
        let bytes = std::fs::read(out).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "output is not a PDF");
        assert!(bytes.len() > 1000);
    } else {
        eprintln!("typst not on PATH; skipping pdf render assertion");
    }

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn snapshots_roundtrip() {
    let dir = temp_dir("snap");
    let mut b = Backend::spawn(&dir);

    b.call("document/save", serde_json::json!({ "rel_path": "ch1.md", "content": "version one" }));
    let created = b.call("snapshot/create", serde_json::json!({ "message": "first" }));
    assert_eq!(created["result"]["created"], true);

    // No changes: creating again reports nothing to snapshot
    let empty = b.call("snapshot/create", serde_json::json!({ "message": "noop" }));
    assert_eq!(empty["result"]["created"], false);

    b.call("document/save", serde_json::json!({ "rel_path": "ch1.md", "content": "version two" }));

    let list = b.call("snapshot/list", Value::Null);
    let snaps = list["result"]["snapshots"].as_array().unwrap();
    assert_eq!(snaps.len(), 1);
    assert_eq!(snaps[0]["message"], "first");
    let hash = snaps[0]["hash"].as_str().unwrap().to_string();

    let restore = b.call("snapshot/restore_file", serde_json::json!({ "hash": hash, "rel_path": "ch1.md" }));
    assert_eq!(restore["result"]["success"], true);

    let read = b.call("document/read", serde_json::json!({ "rel_path": "ch1.md" }));
    assert_eq!(read["result"]["content"], "version one");

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
