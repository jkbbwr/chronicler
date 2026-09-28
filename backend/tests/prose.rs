//! Local style checks and the book-level prose report, over the wire.

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
    /// Responses that arrived while waiting for a different id.
    early: std::collections::HashMap<i64, Value>,
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
            early: Default::default(),
        }
    }

    fn send(&mut self, method: &str, params: Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{req}").unwrap();
        id
    }

    fn read_until(&mut self, id: i64) -> Value {
        if let Some(v) = self.early.remove(&id) {
            return v;
        }
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).unwrap() == 0 {
                panic!("backend exited before responding to request {id}");
            }
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(&line).unwrap();
            match v["id"].as_i64() {
                Some(got) if got == id => return v,
                Some(got) => {
                    self.early.insert(got, v);
                }
                None if v.get("method").is_some() => self.events.push(v),
                None => {}
            }
        }
    }

    /// Send one request and read lines until its response arrives,
    /// collecting notifications (e.g. project/changed from the watcher).
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.read_until(id)
    }

    fn ok(&mut self, method: &str, params: Value) -> Value {
        let resp = self.call(method, params.clone());
        assert!(
            resp["error"].is_null(),
            "{method} {params} failed: {}",
            resp["error"]
        );
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

#[test]
fn style_switches_and_prose_report() {
    let dir = temp_dir("prose");
    let mut b = Backend::spawn(&dir);

    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": "# One\nShe lifted the lantern high. The wind caught the lantern. \"Go,\" she said softly.\n" }),
    );
    b.ok(
        "document/save",
        json!({ "path": "ch2.md", "content": "The lantern fell. She began to run.\n<!-- lantern lantern -->\n" }),
    );
    b.ok("project/create_folder", json!({ "path": "Front Matter" }));
    b.ok(
        "document/save",
        json!({ "path": "Front Matter/Dedication.md", "content": "For the lantern, the lantern, the lantern.\n" }),
    );

    let all_on = json!({ "echoes": true, "adverbTags": true, "rhythm": true, "filterWords": true });
    assert_eq!(b.ok("diag/style_get", Value::Null), all_on);

    let rules = |b: &mut Backend| -> Vec<String> {
        b.ok("diag/check", json!({ "path": "ch1.md" }))["files"]["ch1.md"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["source"] == "style")
            .map(|d| d["ruleId"].as_str().unwrap().to_string())
            .collect()
    };
    let on = rules(&mut b);
    assert!(on.contains(&"STYLE/ECHO".to_string()), "{on:?}");
    assert!(on.contains(&"STYLE/ADVERB_TAG".to_string()), "{on:?}");

    // Partial update: only echoes change.
    let r = b.ok("diag/style_set", json!({ "echoes": false }));
    assert_eq!(r, json!({ "echoes": false, "adverbTags": true, "rhythm": true, "filterWords": true }));
    assert_eq!(b.ok("diag/style_get", Value::Null), r);
    let off = rules(&mut b);
    assert!(!off.contains(&"STYLE/ECHO".to_string()), "{off:?}");
    assert!(off.contains(&"STYLE/ADVERB_TAG".to_string()), "{off:?}");
    assert!(b.err("diag/style_set", json!({ "loud": true })).contains("unknown field"));

    // "Turn off rule" works for the new rules too.
    b.ok("diag/ignore", json!({ "ruleId": "STYLE/ADVERB_TAG" }));
    assert!(!rules(&mut b).contains(&"STYLE/ADVERB_TAG".to_string()));
    let ignored = b.ok("diag/ignored", Value::Null);
    assert_eq!(ignored["ignored"][0]["label"], "Adverb on a dialogue tag");

    // The report covers the manuscript only: no Front Matter, no comments.
    let r = b.ok("diag/prose_report", Value::Null);
    assert_eq!(r["words"], 21, "{r}");
    let lantern = r["overused"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["word"] == "lantern")
        .unwrap_or_else(|| panic!("lantern missing: {r}"));
    assert_eq!(lantern["count"], 3);
    assert_eq!(
        lantern["examples"],
        json!([{ "file": "ch1.md", "line": 2 }, { "file": "ch2.md", "line": 1 }])
    );
    let began = r["crutch"].as_array().unwrap().iter().find(|c| c["word"] == "began to").unwrap();
    assert_eq!(began["count"], 1);
    assert!(began["per10k"].as_f64().unwrap() > 400.0);
    let scenes: Vec<&str> = r["scenes"].as_array().unwrap().iter().map(|s| s["file"].as_str().unwrap()).collect();
    assert_eq!(scenes, ["ch1.md", "ch2.md"]);
    assert_eq!(r["scenes"][1]["sentences"], 2);
    assert_eq!(r["scenes"][1]["avgLength"], 3.5);
    assert_eq!(r["scenes"][1]["stdev"], 0.5);

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
