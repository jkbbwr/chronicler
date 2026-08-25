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

    // Project-wide replace (case-insensitive), then a line-scoped one
    b.call("document/save", serde_json::json!({ "rel_path": "b.md", "content": "The Dragon met a dragon.\nAnother dragon waits." }));
    let rep = b.call("project/replace", serde_json::json!({ "query": "dragon", "replacement": "wyvern" }));
    assert_eq!(rep["result"]["occurrences"], 4); // 1 in a.md + 3 in b.md
    let read = b.call("document/read", serde_json::json!({ "rel_path": "b.md" }));
    assert_eq!(read["result"]["content"], "The wyvern met a wyvern.\nAnother wyvern waits.");

    b.call("document/save", serde_json::json!({ "rel_path": "c.md", "content": "wyvern one\nwyvern two" }));
    let rep = b.call("project/replace", serde_json::json!({ "query": "wyvern", "replacement": "drake", "file": "c.md", "line": 2 }));
    assert_eq!(rep["result"]["occurrences"], 1);
    let read = b.call("document/read", serde_json::json!({ "rel_path": "c.md" }));
    assert_eq!(read["result"]["content"], "wyvern one\ndrake two");

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_entities_mentions_candidates() {
    let dir = temp_dir("codex");
    let mut b = Backend::spawn(&dir);

    b.call("document/save", serde_json::json!({ "rel_path": "ch1.md", "content": "Veyra crossed the gate.\nThe Widow waited beyond it." }));

    let created = b.call("codex/create", serde_json::json!({ "name": "Veyra", "kind": "character", "summary": "The protagonist" }));
    let id = created["result"]["id"].as_i64().expect("create failed");

    // Creating an entity reindexes mentions
    let m = b.call("codex/mentions", serde_json::json!({ "id": id }));
    let mentions = m["result"]["mentions"].as_array().unwrap();
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0]["line"], 1);

    // Aliases match too (case-insensitive, word-bounded)
    b.call("codex/add_alias", serde_json::json!({ "id": id, "alias": "Widow" }));
    let m = b.call("codex/mentions", serde_json::json!({ "id": id }));
    assert_eq!(m["result"]["mentions"].as_array().unwrap().len(), 2);

    // Manual promote-from-selection lands in the inbox
    b.call("codex/suggest", serde_json::json!({ "name": "the Pale Lady", "file": "ch1.md" }));
    let c = b.call("codex/candidates", serde_json::Value::Null);
    assert!(c["result"]["candidates"].as_array().unwrap().iter().any(|x| x["name"] == "the Pale Lady"));

    // Promote as an alias of an existing entity (the nickname flow)
    b.call("codex/promote", serde_json::json!({ "name": "the Pale Lady", "asAliasOf": id }));
    let list = b.call("codex/list", serde_json::Value::Null);
    let entity = &list["result"]["entities"][0];
    assert!(entity["aliases"].as_array().unwrap().iter().any(|a| a == "the Pale Lady"));
    let c = b.call("codex/candidates", serde_json::Value::Null);
    assert!(c["result"]["candidates"].as_array().unwrap().is_empty());

    // Dismissed names stay dead even if re-suggested
    b.call("codex/suggest", serde_json::json!({ "name": "Nonsense", "file": "ch1.md" }));
    b.call("codex/dismiss", serde_json::json!({ "name": "Nonsense" }));
    b.call("codex/suggest", serde_json::json!({ "name": "Nonsense", "file": "ch1.md" }));
    let c = b.call("codex/candidates", serde_json::Value::Null);
    assert!(c["result"]["candidates"].as_array().unwrap().is_empty());

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
    assert!(typ.contains("#chapter([Chapter 1])[Arrival]"));
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

#[test]
fn scene_meta_and_index_rebuild() {
    let dir = temp_dir("meta");
    let mut b = Backend::spawn(&dir);

    b.call("document/save", serde_json::json!({ "rel_path": "ch1.md", "content": "Mira walked. Mira waited." }));
    b.call("meta/set", serde_json::json!({ "file": "ch1.md", "synopsis": "Mira arrives", "status": "draft" }));
    b.call("codex/create", serde_json::json!({ "name": "Mira", "kind": "character" }));
    b.call("codex/reindex", Value::Null);

    let meta = b.call("meta/get_all", Value::Null);
    let rows = meta["result"]["meta"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["synopsis"], "Mira arrives");
    assert_eq!(rows[0]["status"], "draft");

    // Renaming a scene carries its metadata along
    b.call("project/rename", serde_json::json!({ "old_path": "ch1.md", "new_path": "ch2.md" }));
    let meta = b.call("meta/get_all", Value::Null);
    assert_eq!(meta["result"]["meta"][0]["file"], "ch2.md");

    // Rebuild clears and reconstructs derived indexes
    let rebuilt = b.call("index/rebuild", Value::Null);
    assert!(rebuilt["result"]["mentions"].as_u64().unwrap() >= 1);
    let list = b.call("codex/list", Value::Null);
    let id = list["result"]["entities"][0]["id"].as_i64().unwrap();
    let mentions = b.call("codex/mentions", serde_json::json!({ "id": id }));
    assert!(mentions["result"]["mentions"].as_array().unwrap().len() >= 1);

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn diag_fix_replaces_span() {
    let dir = temp_dir("fix");
    let mut b = Backend::spawn(&dir);

    b.call("document/save", serde_json::json!({ "rel_path": "ch1.md", "content": "She recieved a letter.\nMore prose here." }));
    let ok = b.call("diag/fix", serde_json::json!({
        "rel_path": "ch1.md", "line": 1, "colStart": 4, "colEnd": 12,
        "text": "recieved", "replacement": "received"
    }));
    assert_eq!(ok["result"]["success"], true);
    let read = b.call("document/read", serde_json::json!({ "rel_path": "ch1.md" }));
    assert_eq!(read["result"]["content"], "She received a letter.\nMore prose here.");

    // Stale positions are refused rather than corrupting text
    let stale = b.call("diag/fix", serde_json::json!({
        "rel_path": "ch1.md", "line": 1, "colStart": 4, "colEnd": 12,
        "text": "recieved", "replacement": "received"
    }));
    assert!(stale["error"]["message"].as_str().unwrap().contains("changed"));

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn ai_key_roundtrip() {
    let dir = temp_dir("aikey");
    let mut b = Backend::spawn(&dir);

    let set = b.call("ai/set_key", serde_json::json!({ "key": "sk-test" }));
    assert_eq!(set["result"]["success"], true);
    let cfg = b.call("ai/config", Value::Null);
    assert_eq!(cfg["result"]["hasKey"], true);

    // Clearing must land immediately, not on next restart
    let clear = b.call("ai/set_key", serde_json::json!({ "key": "" }));
    assert_eq!(clear["result"]["success"], true);
    let cfg = b.call("ai/config", Value::Null);
    assert_eq!(cfg["result"]["hasKey"], false);

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
