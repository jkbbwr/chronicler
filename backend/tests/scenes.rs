//! Splitting and merging scenes.

use serde_json::{Value, json};
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
        let cfg = std::env::temp_dir().join(format!("chronicler-cfg-{}", dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&cfg);
        let mut child = Command::new(env!("CARGO_BIN_EXE_chronicler-backend"))
            .current_dir(dir)
            .env("CHRONICLER_DELETE_PERMANENTLY", "1")
            .env("CHRONICLER_CONFIG_DIR", cfg)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if std::env::var_os("CHRONICLER_TEST_STDERR").is_some() { Stdio::inherit() } else { Stdio::null() })
            .spawn()
            .expect("failed to spawn backend");
        let stdin = child.stdin.take().unwrap();
        let reader = BufReader::new(child.stdout.take().unwrap());
        Backend { child, stdin, reader, next_id: 1 }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).unwrap();
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).unwrap() == 0 {
                panic!("backend exited before responding to {method}");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v["id"].as_i64() == Some(id) {
                return v;
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
        resp["error"]["message"].as_str().unwrap_or_else(|| panic!("{method} {params} should fail")).to_string()
    }

    fn shutdown(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("chronicler-test-scenes-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn detail(b: &mut Backend, file: &str) -> Value {
    b.ok("meta/get_all", Value::Null)["meta"].as_array().unwrap().iter().find(|m| m["file"] == file).cloned().unwrap_or(Value::Null)
}

fn order(dir: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(".chronicler/order.json")).unwrap()).unwrap()
}

#[test]
fn split_then_merge_round_trips() {
    let dir = temp_dir("split");
    let mut b = Backend::spawn(&dir);
    b.ok("project/create_folder", json!({ "path": "Ch" }));
    for (f, t) in [("Ch/A.md", "Alpha one.\n\nAlpha two.\n"), ("Ch/B.md", "Bravo.\n"), ("Ch/C.md", "Charlie.\n")] {
        b.ok("document/save", json!({ "path": f, "content": t }));
    }
    let maren = b.ok("codex/create", json!({ "name": "Maren", "kind": "character" }))["id"].as_i64().unwrap();
    let letter = b.ok("threads/create", json!({ "name": "The letter" }))["id"].as_i64().unwrap();
    let debt = b.ok("threads/create", json!({ "name": "The debt" }))["id"].as_i64().unwrap();
    b.ok("meta/set", json!({ "path": "Ch/A.md", "pov": maren, "storyTime": "Day 1", "status": "draft", "target": 800,
                            "synopsis": "Alpha things.", "threads": [letter] }));

    // Split A: the new scene sits right after it and inherits its details
    // (but not its synopsis or target).
    let new = b.ok("scene/split", json!({ "path": "Ch/A.md", "before": "Alpha one.\n\n", "after": "\nAlpha two.\n" }))["path"].clone();
    assert_eq!(new, "Ch/A (2).md");
    assert_eq!(std::fs::read_to_string(dir.join("Ch/A.md")).unwrap(), "Alpha one.\n");
    assert_eq!(std::fs::read_to_string(dir.join("Ch/A (2).md")).unwrap(), "Alpha two.\n");
    assert_eq!(order(&dir)["Ch"], json!(["A.md", "A (2).md", "B.md", "C.md"]));
    let d = detail(&mut b, "Ch/A (2).md");
    assert_eq!((d["pov"].clone(), d["storyTime"].clone(), d["status"].clone()), (json!(maren), json!("Day 1"), json!("draft")));
    assert_eq!((d["threads"].clone(), d["synopsis"].clone(), d["target"].clone()), (json!([letter]), json!(""), json!(0)));

    // Named splits; names can't collide; both halves must have text.
    let named = b.ok("scene/split", json!({ "path": "Ch/B.md", "before": "Bra", "after": "vo.\n", "name": "Later" }))["path"].clone();
    assert_eq!(named, "Ch/Later.md");
    assert_eq!(order(&dir)["Ch"], json!(["A.md", "A (2).md", "B.md", "Later.md", "C.md"]));
    assert!(b.err("scene/split", json!({ "path": "Ch/B.md", "before": "B", "after": "ra", "name": "Later" })).contains("already exists"));
    assert!(b.err("scene/split", json!({ "path": "Ch/C.md", "before": "  ", "after": "Charlie." })).contains("cursor"));

    // Merge A with the next scene: text joined, threads and targets combined,
    // the other file gone from disk, the order and the index.
    b.ok("meta/set", json!({ "path": "Ch/A (2).md", "threads": [letter, debt], "target": 400 }));
    assert_eq!(b.ok("scene/merge", json!({ "path": "Ch/A.md" }))["merged"], "Ch/A (2).md");
    assert_eq!(std::fs::read_to_string(dir.join("Ch/A.md")).unwrap(), "Alpha one.\n\nAlpha two.\n");
    assert!(!dir.join("Ch/A (2).md").exists());
    assert_eq!(order(&dir)["Ch"], json!(["A.md", "B.md", "Later.md", "C.md"]));
    let d = detail(&mut b, "Ch/A.md");
    assert_eq!((d["threads"].clone(), d["target"].clone(), d["synopsis"].clone()), (json!([letter, debt]), json!(1200), json!("Alpha things.")));
    assert_eq!(detail(&mut b, "Ch/A (2).md"), Value::Null);

    // The last scene has nothing to merge with.
    assert!(b.err("scene/merge", json!({ "path": "Ch/C.md" })).contains("last scene"));
    assert!(b.err("scene/merge", json!({ "path": "Ch" })).contains("isn't a scene"));

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn programs_can_be_pointed_at() {
    let dir = temp_dir("programs");
    let mut b = Backend::spawn(&dir);
    let on_path = b.ok("system/tools", Value::Null)["jj"].clone();
    // A wrong location: not found, and remembered.
    let t = b.ok("system/tools_set", json!({ "tool": "jj", "path": " /nowhere/jj " }));
    assert_eq!((t["jj"].clone(), t["jjPath"].clone()), (Value::Null, json!("/nowhere/jj")));
    assert_eq!(b.ok("system/tools", Value::Null)["jjPath"], "/nowhere/jj");
    // History says so plainly instead of pretending there's nothing.
    b.ok("document/save", json!({ "path": "a.md", "content": "One.\n" }));
    assert!(b.call("history/lock_in", json!({ "message": "x" }))["error"].is_object());
    // Back to PATH.
    let t = b.ok("system/tools_set", json!({ "tool": "jj", "path": "" }));
    assert_eq!((t["jj"].clone(), t["jjPath"].clone()), (on_path, json!("")));
    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
