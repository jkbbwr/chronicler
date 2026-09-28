use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
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
fn documents_and_search() {
    let dir = temp_dir("docs");
    let mut b = Backend::spawn(&dir);

    assert_eq!(b.ok("ping", Value::Null), "pong");

    assert_eq!(
        b.ok(
            "document/save",
            json!({ "path": "a.md", "content": "# Hello\nworld dragon" })
        ),
        Value::Null
    );
    assert_eq!(
        b.ok("document/read", json!({ "path": "a.md" }))["content"],
        "# Hello\nworld dragon"
    );

    assert!(
        b.err("document/read", json!({ "path": "../outside.md" }))
            .contains("escapes")
    );
    assert!(
        b.err("project/delete", json!({ "path": "/tmp" }))
            .contains("Absolute")
    );
    // Old wire names are refused loudly, not silently defaulted.
    let old = b.call("document/read", json!({ "rel_path": "a.md" }));
    assert_eq!(old["error"]["code"], -32602);

    let results = b.ok("project/search", json!({ "query": "DRAGON" }))["results"].clone();
    assert_eq!(results.as_array().unwrap().len(), 1);
    assert_eq!(results[0]["file"], "a.md");
    assert_eq!(results[0]["line"], 2);

    let files = b.ok("project/list_files", Value::Null)["files"].clone();
    assert!(
        files
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["path"] == "a.md" && f["isDir"] == false)
    );

    // Project-wide replace (case-insensitive), then a line-scoped one
    b.ok("document/save", json!({ "path": "b.md", "content": "The Dragon met a dragon.\r\nAnother dragon waits.\r\n" }));
    let rep = b.ok(
        "project/replace",
        json!({ "query": "dragon", "replacement": "wyvern" }),
    );
    assert_eq!(rep["occurrences"], 4); // 1 in a.md + 3 in b.md
    // CRLF endings survive
    assert_eq!(
        b.ok("document/read", json!({ "path": "b.md" }))["content"],
        "The wyvern met a wyvern.\r\nAnother wyvern waits.\r\n"
    );

    b.ok(
        "document/save",
        json!({ "path": "c.md", "content": "wyvern one\nwyvern two" }),
    );
    let rep = b.ok(
        "project/replace",
        json!({ "query": "wyvern", "replacement": "drake", "file": "c.md", "line": 2 }),
    );
    assert_eq!(rep["occurrences"], 1);
    assert_eq!(
        b.ok("document/read", json!({ "path": "c.md" }))["content"],
        "wyvern one\ndrake two"
    );

    // App-data files the binder uses are readable and writable; the db is not.
    b.ok(
        "document/save",
        json!({ "path": ".chronicler/order.json", "content": "{}" }),
    );
    assert_eq!(
        b.ok("document/read", json!({ "path": ".chronicler/order.json" }))["content"],
        "{}"
    );
    assert!(
        b.err("document/read", json!({ "path": ".chronicler/db" }))
            .contains("Hidden")
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn concurrent_saves_of_one_file_never_corrupt() {
    let dir = temp_dir("concurrent");
    let mut b = Backend::spawn(&dir);
    let contents: Vec<String> = (0..24)
        .map(|i| format!("version {i} ").repeat(2_000 + i))
        .collect();
    let ids: Vec<i64> = contents
        .iter()
        .map(|c| b.send("document/save", json!({ "path": "scene.md", "content": c })))
        .collect();
    for id in ids {
        let resp = b.read_until(id);
        assert!(resp["error"].is_null(), "save failed: {}", resp["error"]);
    }
    let final_content = b.ok("document/read", json!({ "path": "scene.md" }))["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        contents.contains(&final_content),
        "content is a mix of saves"
    );
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind");
    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rename_refuses_to_overwrite_and_delete_is_confined() {
    let dir = temp_dir("rename");
    let mut b = Backend::spawn(&dir);
    b.ok(
        "document/save",
        json!({ "path": "a.md", "content": "alpha" }),
    );
    b.ok(
        "document/save",
        json!({ "path": "b.md", "content": "beta" }),
    );

    assert!(
        b.err("project/rename", json!({ "from": "a.md", "to": "b.md" }))
            .contains("already exists")
    );
    assert_eq!(
        b.ok("document/read", json!({ "path": "b.md" }))["content"],
        "beta"
    );
    assert_eq!(
        b.ok("document/read", json!({ "path": "a.md" }))["content"],
        "alpha"
    );

    b.ok("project/create_folder", json!({ "path": "ch" }));
    assert!(
        b.err("project/rename", json!({ "from": "ch", "to": "ch/inner" }))
            .contains("inside itself")
    );

    // The project root, app state and history are never mutation targets.
    for path in [
        ".",
        "",
        "./",
        ".chronicler",
        ".jj",
        "ch/..",
        ".chronicler/db",
    ] {
        let resp = b.call("project/delete", json!({ "path": path }));
        assert_eq!(
            resp["error"]["code"], -32602,
            "delete {path:?} should be refused"
        );
    }
    assert!(
        b.err(
            "project/rename",
            json!({ "from": ".chronicler", "to": "x" })
        )
        .contains("Hidden")
    );
    assert!(dir.join(".chronicler").join("db").exists());
    assert!(dir.join("a.md").exists());

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rename_and_delete_carry_every_index() {
    let dir = temp_dir("move");
    let mut b = Backend::spawn(&dir);

    b.ok("project/create_folder", json!({ "path": "Été" }));
    b.ok(
        "document/save",
        json!({ "path": "Été/a_1.md", "content": "Mira walked. Mira waited." }),
    );
    b.ok(
        "document/save",
        json!({ "path": "ÉtéX.md", "content": "Mira elsewhere." }),
    );
    b.ok(
        "meta/set",
        json!({ "path": "Été/a_1.md", "synopsis": "Mira arrives", "status": "draft" }),
    );
    b.ok(
        "meta/set",
        json!({ "path": "ÉtéX.md", "synopsis": "Other" }),
    );
    let id = b.ok(
        "codex/create",
        json!({ "name": "Mira", "kind": "character" }),
    )["id"]
        .as_i64()
        .unwrap();
    b.ok(
        "diag/ignore",
        json!({ "ruleId": "spelling", "file": "Été/a_1.md", "text": "Mira" }),
    );

    b.ok("project/rename", json!({ "from": "Été", "to": "Summer" }));
    let meta = b.ok("meta/get_all", Value::Null)["meta"].clone();
    let files: Vec<&str> = meta
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, vec!["Summer/a_1.md", "ÉtéX.md"]);
    let mentions = b.ok("codex/mentions", json!({ "id": id }))["mentions"].clone();
    let mfiles: Vec<&str> = mentions
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["file"].as_str().unwrap())
        .collect();
    assert!(
        mfiles.contains(&"Summer/a_1.md") && mfiles.contains(&"ÉtéX.md"),
        "{mfiles:?}"
    );
    assert!(!mfiles.iter().any(|f| f.starts_with("Été/")));

    b.ok("project/delete", json!({ "path": "Summer" }));
    assert!(!dir.join("Summer").exists());
    let meta = b.ok("meta/get_all", Value::Null)["meta"].clone();
    assert_eq!(meta.as_array().unwrap().len(), 1);
    let mentions = b.ok("codex/mentions", json!({ "id": id }))["mentions"].clone();
    assert!(
        mentions
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["file"] == "ÉtéX.md")
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_entities_mentions_candidates() {
    let dir = temp_dir("codex");
    let mut b = Backend::spawn(&dir);

    b.ok("document/save", json!({ "path": "ch1.md", "content": "Veyra crossed the gate.\nThe Widow waited beyond it." }));
    let id = b.ok(
        "codex/create",
        json!({ "name": "Veyra", "kind": "character", "summary": "The protagonist" }),
    )["id"]
        .as_i64()
        .unwrap();

    // Creating an entity reindexes mentions
    let mentions = b.ok("codex/mentions", json!({ "id": id }))["mentions"].clone();
    assert_eq!(mentions.as_array().unwrap().len(), 1);
    assert_eq!(mentions[0]["line"], 1);

    // Aliases match too (case-insensitive, word-bounded)
    b.ok("codex/add_alias", json!({ "id": id, "alias": "Widow" }));
    assert_eq!(
        b.ok("codex/mentions", json!({ "id": id }))["mentions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // Manual promote-from-selection lands in the inbox
    b.ok(
        "codex/suggest",
        json!({ "name": "the Pale Lady", "file": "ch1.md" }),
    );
    let c = b.ok("codex/candidates", Value::Null);
    assert!(
        c["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["name"] == "the Pale Lady")
    );

    // Promote as an alias of an existing entity (the nickname flow)
    assert_eq!(
        b.ok(
            "codex/promote",
            json!({ "name": "the Pale Lady", "asAliasOf": id })
        )["aliasedTo"],
        id
    );
    let list = b.ok("codex/list", Value::Null);
    assert!(
        list["entities"][0]["aliases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a == "the Pale Lady")
    );
    assert!(
        b.ok("codex/candidates", Value::Null)["candidates"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Dismissed names stay dead even if re-suggested
    b.ok(
        "codex/suggest",
        json!({ "name": "Nonsense", "file": "ch1.md" }),
    );
    b.ok("codex/dismiss", json!({ "name": "Nonsense" }));
    b.ok(
        "codex/suggest",
        json!({ "name": "Nonsense", "file": "ch1.md" }),
    );
    assert!(
        b.ok("codex/candidates", Value::Null)["candidates"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Bad kinds are invalid params, not server errors
    assert_eq!(
        b.call("codex/create", json!({ "name": "X", "kind": "wizard" }))["error"]["code"],
        -32602
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn compile_manuscript() {
    let dir = temp_dir("compile");
    let mut b = Backend::spawn(&dir);

    b.ok("project/create_folder", json!({ "path": "01 Arrival" }));
    b.ok(
        "document/save",
        json!({ "path": "01 Arrival/scene1.md", "content": "She **arrived** at last." }),
    );
    b.ok("document/save", json!({ "path": "01 Arrival/scene2.md", "content": "# Later\n\nA *quiet* evening — cost: $5.\n\nhttp://example.com // not a comment" }));

    let chapters =
        json!([{ "title": "Arrival", "scenes": ["01 Arrival/scene1.md", "01 Arrival/scene2.md"] }]);

    // Settings persistence in the project db
    assert_eq!(
        b.ok(
            "db/set",
            json!({ "key": "compile", "value": "{\"paper\":\"a5\"}" })
        ),
        Value::Null
    );
    assert_eq!(
        b.ok("db/get", json!({ "key": "compile" }))["value"],
        "{\"paper\":\"a5\"}"
    );
    assert!(dir.join(".chronicler").join("db").exists());

    // Typst-source compile (no external binary needed)
    let run = b.ok(
        "compile/run",
        json!({
            "chapters": chapters,
            "settings": { "format": "typst", "title": "Test Book", "author": "A. Writer" }
        }),
    );
    let out = run["output"].as_str().expect("compile failed").to_string();
    assert!(out.ends_with("manuscript.typ"));
    let typ = std::fs::read_to_string(&out).unwrap();
    assert!(typ.contains("#chapter([Chapter 1])[Arrival]"));
    assert!(typ.contains("*arrived*"));
    assert!(typ.contains("_quiet_"));
    assert!(typ.contains("\\$5")); // typst specials escaped
    assert!(typ.contains("http:\\//example.com \\// not a comment"));
    assert!(typ.contains("#sep")); // scene separator between the two scenes
    assert!(typ.contains("Test Book"));

    // Full PDF render when typst is available
    let typst_present = Command::new("typst")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if typst_present {
        let run = b.ok(
            "compile/run",
            json!({ "chapters": chapters, "settings": { "format": "pdf", "title": "Test Book" } }),
        );
        let out = run["output"].as_str().expect("pdf compile failed");
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
fn history_roundtrip() {
    let dir = temp_dir("history");
    let mut b = Backend::spawn(&dir);

    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": "version one" }),
    );

    // Nothing to lock in without a name
    assert_eq!(
        b.call("history/lock_in", json!({ "message": "  " }))["error"]["code"],
        -32602
    );
    assert_eq!(
        b.ok("history/lock_in", json!({ "message": "first" }))["locked"],
        true
    );

    // The fresh draft is empty: locking in again reports nothing to do
    assert_eq!(
        b.ok("history/lock_in", json!({ "message": "noop" }))["locked"],
        false
    );

    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": "version two" }),
    );
    b.ok(
        "document/save",
        json!({ "path": "other.md", "content": "unrelated" }),
    );

    let changes = b.ok("history/changes", Value::Null)["changes"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["current"], true);
    assert_eq!(changes[0]["empty"], false);
    assert_eq!(changes[1]["description"], "first");
    assert!(dir.join(".jj").exists());
    assert!(!dir.join(".git").exists());

    // The draft's save log lists only real saves, each with the files it touched
    let draft_id = changes[0]["changeId"].as_str().unwrap().to_string();
    let saves = b.ok("history/evolog", json!({ "changeId": draft_id }))["entries"]
        .as_array()
        .unwrap()
        .clone();
    assert!(!saves.is_empty());
    assert!(
        saves
            .iter()
            .all(|e| !e["files"].as_array().unwrap().is_empty())
    );

    // Prose diff: the rewritten paragraph marks just the changed word
    let parent = changes[0]["parentId"].as_str().unwrap().to_string();
    let files = b.ok("history/diff", json!({ "from": parent, "to": "@" }))["files"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(files.len(), 2);
    let ch1 = files.iter().find(|f| f["path"] == "ch1.md").unwrap();
    assert_eq!(ch1["status"], "modified");
    assert_eq!(ch1["wordsAdded"], 1);
    assert_eq!(ch1["wordsRemoved"], 1);
    let paras = ch1["paragraphs"].as_array().unwrap();
    assert_eq!(paras.len(), 1);
    assert_eq!(paras[0]["tag"], "modify");
    assert_eq!(
        paras[0]["segments"],
        json!([["equal", "version "], ["delete", "one"], ["insert", "two"]])
    );
    assert_eq!(
        files.iter().find(|f| f["path"] == "other.md").unwrap()["status"],
        "added"
    );
    let only = b.ok(
        "history/diff",
        json!({ "from": parent, "to": "@", "path": "other.md" }),
    );
    assert_eq!(only["files"].as_array().unwrap().len(), 1);

    // Rename the locked-in change; its change id is stable
    let first_id = changes[1]["changeId"].as_str().unwrap().to_string();
    b.ok(
        "history/describe",
        json!({ "changeId": first_id, "message": "Draft one" }),
    );
    let changes = b.ok("history/changes", json!({ "path": "ch1.md" }))["changes"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(changes[1]["changeId"], first_id.as_str());
    assert_eq!(changes[1]["description"], "Draft one");

    // Renaming doesn't count as a save
    let evo = b.ok("history/evolog", json!({ "changeId": first_id }));
    assert!(
        evo["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| !e["files"].as_array().unwrap().is_empty())
    );

    b.ok(
        "history/restore",
        json!({ "rev": first_id, "path": "ch1.md" }),
    );
    assert_eq!(
        b.ok("document/read", json!({ "path": "ch1.md" }))["content"],
        "version one"
    );
    // Single-file restore leaves the rest of the draft alone
    assert_eq!(
        b.ok("document/read", json!({ "path": "other.md" }))["content"],
        "unrelated"
    );

    // Whole-project restore takes everything back
    b.ok("history/restore", json!({ "rev": first_id }));
    assert!(!dir.join("other.md").exists());

    assert!(
        b.call(
            "history/restore",
            json!({ "rev": "@-; rm", "path": "ch1.md" })
        )["error"]
            .is_object()
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn scene_meta_and_index_rebuild() {
    let dir = temp_dir("meta");
    let mut b = Backend::spawn(&dir);

    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": "Mira walked. Mira waited." }),
    );
    b.ok(
        "meta/set",
        json!({ "path": "ch1.md", "synopsis": "Mira arrives", "status": "draft" }),
    );
    b.ok("meta/set", json!({ "path": "ch1.md", "status": "revised" })); // synopsis kept
    b.ok(
        "codex/create",
        json!({ "name": "Mira", "kind": "character" }),
    );
    b.ok("codex/reindex", Value::Null);

    let rows = b.ok("meta/get_all", Value::Null)["meta"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["synopsis"], "Mira arrives");
    assert_eq!(rows[0]["status"], "revised");

    // Renaming a scene carries its metadata along
    b.ok(
        "project/rename",
        json!({ "from": "ch1.md", "to": "ch2.md" }),
    );
    assert_eq!(
        b.ok("meta/get_all", Value::Null)["meta"][0]["file"],
        "ch2.md"
    );

    // Rebuild clears and reconstructs derived indexes
    assert!(
        b.ok("index/rebuild", Value::Null)["mentions"]
            .as_u64()
            .unwrap()
            >= 1
    );
    let id = b.ok("codex/list", Value::Null)["entities"][0]["id"]
        .as_i64()
        .unwrap();
    assert!(
        !b.ok("codex/mentions", json!({ "id": id }))["mentions"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn diag_fix_replaces_span_and_rejects_bad_input() {
    let dir = temp_dir("fix");
    let mut b = Backend::spawn(&dir);

    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": "She recieved a letter.\r\nMore prose here." }),
    );
    b.ok(
        "diag/fix",
        json!({
            "path": "ch1.md", "line": 1, "colStart": 4, "colEnd": 12,
            "text": "recieved", "replacement": "received"
        }),
    );
    assert_eq!(
        b.ok("document/read", json!({ "path": "ch1.md" }))["content"],
        "She received a letter.\r\nMore prose here."
    );

    // Stale positions are refused rather than corrupting text
    let stale = b.err(
        "diag/fix",
        json!({
            "path": "ch1.md", "line": 1, "colStart": 4, "colEnd": 12,
            "text": "recieved", "replacement": "received"
        }),
    );
    assert!(stale.contains("changed"));

    // Inputs that used to panic (and hang the frontend) are plain errors now
    for bad in [
        json!({ "path": "ch1.md", "line": 1, "colStart": 12, "colEnd": 4, "text": "", "replacement": "x" }),
        json!({ "path": "ch1.md", "line": 0, "colStart": 0, "colEnd": 3, "text": "She", "replacement": "He" }),
        json!({ "path": "ch1.md", "line": 99, "colStart": 0, "colEnd": 3, "text": "She", "replacement": "He" }),
        json!({ "path": "ch1.md", "line": 1, "colStart": 0, "colEnd": 999, "text": "She", "replacement": "He" }),
    ] {
        let resp = b.call("diag/fix", bad);
        assert!(resp["error"].is_object());
    }
    assert_eq!(b.ok("ping", Value::Null), "pong");

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn diagnostics_dialect_and_lazy_suggestions() {
    let dir = temp_dir("dialect");
    let mut b = Backend::spawn(&dir);

    b.ok("document/save", json!({ "path": "ch1.md", "content": "The grey boat left the harbour. She recieved Veyra.\n" }));
    assert_eq!(b.ok("diag/get_dialect", Value::Null)["dialect"], "american");
    let spelled = |b: &mut Backend| -> Vec<String> {
        b.ok("diag/check", json!({ "path": "ch1.md" }))["files"]["ch1.md"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["source"] == "spelling")
            .map(|d| {
                assert_eq!(
                    d["replacements"],
                    json!([]),
                    "spelling suggestions are lazy"
                );
                d["text"].as_str().unwrap().to_string()
            })
            .collect()
    };
    let us = spelled(&mut b);
    assert!(us.contains(&"harbour".to_string()), "{us:?}");
    assert!(us.contains(&"Veyra".to_string()), "{us:?}");

    b.ok("diag/set_dialect", json!({ "dialect": "british" }));
    b.ok("codex/create", json!({ "name": "Veyra" }));
    let uk = spelled(&mut b);
    assert_eq!(uk, vec!["recieved".to_string()]);

    let s = b.ok("diag/suggest", json!({ "word": "recieved" }))["suggestions"].clone();
    assert!(s.as_array().unwrap().iter().any(|w| w == "received"), "{s}");
    assert_eq!(
        b.call("diag/set_dialect", json!({ "dialect": "martian" }))["error"]["code"],
        -32602
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn journal_and_malformed_input() {
    let dir = temp_dir("journal");
    let mut b = Backend::spawn(&dir);

    b.ok(
        "journal/write",
        json!({ "path": "ch1.md", "content": "unsaved words" }),
    );
    b.ok(
        "journal/write",
        json!({ "path": "ch2.md", "content": "more" }),
    );
    let entries = b.ok("journal/read", Value::Null)["entries"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(entries.len(), 2);
    assert!(
        entries
            .iter()
            .any(|e| e["path"] == "ch1.md" && e["content"] == "unsaved words")
    );
    b.ok("journal/clear", json!({ "path": "ch1.md" }));
    assert_eq!(
        b.ok("journal/read", Value::Null)["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    b.ok("journal/clear", Value::Null);
    assert!(
        b.ok("journal/read", Value::Null)["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // Invalid UTF-8 and garbage lines get parse errors; the loop keeps going.
    b.stdin.write_all(b"{\"id\": 1, \xff\xfe}\n").unwrap();
    b.stdin.write_all(b"not json\n").unwrap();
    assert_eq!(b.ok("ping", Value::Null), "pong");
    assert_eq!(
        b.call("no/such_method", Value::Null)["error"]["code"],
        -32601
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn ai_key_roundtrip() {
    let dir = temp_dir("aikey");
    let mut b = Backend::spawn(&dir);

    b.ok("ai/set_key", json!({ "key": "sk-test" }));
    assert_eq!(b.ok("ai/config", Value::Null)["hasKey"], true);

    // Clearing must land immediately, not on next restart
    b.ok("ai/set_key", json!({ "key": "" }));
    assert_eq!(b.ok("ai/config", Value::Null)["hasKey"], false);

    // Partial config updates keep the other fields
    b.ok(
        "ai/config_set",
        json!({ "provider": "openai-compat", "baseUrl": "http://127.0.0.1:1/v1" }),
    );
    b.ok("ai/config_set", json!({ "deepModel": "careful", "overrides": { "ledger": "special", "chat": " " } }));
    let cfg = b.ok("ai/config", Value::Null);
    assert_eq!(cfg["provider"], "openai-compat");
    assert_eq!(cfg["baseUrl"], "http://127.0.0.1:1/v1");
    assert_eq!(cfg["deepModel"], "careful");
    assert_eq!(cfg["overrides"], json!({ "ledger": "special" }), "blank overrides are dropped");


    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

// ---------- Agents, against a local mock of the OpenAI API ----------

/// A minimal OpenAI-compatible server: non-streaming requests get
/// `completion` as the assistant message; streaming ones get `stream_text`.
/// Returns the base URL.
type Responder = std::sync::Arc<dyn Fn(&Value) -> String + Send + Sync>;

/// The system prompt and user message of a chat-completions request.
fn prompts(req: &Value) -> (String, String) {
    let msgs = req["messages"].as_array().cloned().unwrap_or_default();
    let text = |role: &str| {
        msgs.iter()
            .filter(|m| m["role"] == role)
            .map(|m| match &m["content"] {
                Value::String(t) => t.clone(),
                // Content as parts: [{ "type": "text", "text": … }]
                Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    (text("system"), text("user"))
}

fn mock_openai(completion: String, stream_text: String) -> String {
    let fixed = completion.clone();
    mock_openai_with(std::sync::Arc::new(move |_| fixed.clone()), stream_text)
}

/// Like `mock_openai`, but each non-streaming reply comes from `respond`.
fn mock_openai_with(respond: Responder, stream_text: String) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let respond = respond.clone();
            let stream_text = stream_text.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let l = line.trim_end().to_ascii_lowercase();
                    if let Some(v) = l.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if l.is_empty() {
                        break;
                    }
                }
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).unwrap();
                let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let mut out = stream;
                if req["stream"] == true {
                    let _ = respond(&req); // lets tests see streaming requests too
                    let chunk = |delta: Value, finish: Value| {
                        json!({ "id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "mock",
                                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] })
                    };
                    let mut sse = String::new();
                    sse += &format!(
                        "data: {}\n\n",
                        chunk(
                            json!({ "role": "assistant", "content": stream_text }),
                            Value::Null
                        )
                    );
                    sse += &format!("data: {}\n\n", chunk(json!({}), json!("stop")));
                    sse += "data: [DONE]\n\n";
                    let _ = write!(
                        out,
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        sse.len(),
                        sse
                    );
                } else {
                    let completion = respond(&req);
                    let resp = json!({
                        "id": "c1", "object": "chat.completion", "created": 0, "model": "mock",
                        "choices": [{ "index": 0, "message": { "role": "assistant", "content": completion }, "finish_reason": "stop" }],
                        "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
                    })
                    .to_string();
                    let _ = write!(
                        out,
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        resp.len(),
                        resp
                    );
                }
            });
        }
    });
    format!("http://{addr}/v1")
}

#[test]
fn critique_skips_matter_and_continuity_keeps_critique_findings() {
    let dir = temp_dir("agents");
    let critique = json!({ "notes": "Reads cleanly.", "problems": [{ "quote": "The tide", "message": "Slow open." }] });
    let base = mock_openai(
        critique.to_string(),
        "Sweep complete: nothing contradicts.".into(),
    );
    let mut b = Backend::spawn(&dir);
    b.ok(
        "ai/config_set",
        json!({ "provider": "openai-compat", "baseUrl": base, "fastModel": "mock", "deepModel": "mock" }),
    );

    let prose = "The tide came in over the flats and the gulls rose and fell with it, \
                 calling to one another across the grey water while the boats waited \
                 for the turn, and nobody on the quay said a word about the night before.";
    b.ok("project/create_folder", json!({ "path": "Front Matter" }));
    b.ok(
        "document/save",
        json!({ "path": "Front Matter/Dedication.md", "content": prose }),
    );
    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": prose }),
    );

    let r = b.ok(
        "agents/critique",
        json!({ "brief": { "audience": "adults" } }),
    );
    assert_eq!(
        r["problems"], 1,
        "only the manuscript scene is critiqued: {r}"
    );
    let findings = |b: &mut Backend, path: &str| -> Vec<Value> {
        b.ok("diag/check", json!({ "path": path }))["files"][path]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["source"] == "assistant")
            .cloned()
            .collect()
    };
    assert_eq!(findings(&mut b, "ch1.md").len(), 1);
    assert!(findings(&mut b, "Front Matter/Dedication.md").is_empty());

    // A full continuity pass replaces continuity findings only.
    let r = b.ok("agents/continuity", Value::Null);
    assert_eq!(r["stopped"], false);
    let kept = findings(&mut b, "ch1.md");
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["ruleId"], "ASSIST/CRITIQUE");

    // Stopping a job that isn't running is a no-op
    assert_eq!(
        b.ok("agents/stop", json!({ "id": "critique" }))["stopped"],
        false
    );

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn watcher_pipeline_reports_changes() {
    let dir = temp_dir("watch");
    let mut b = Backend::spawn(&dir);
    b.ok(
        "document/save",
        json!({ "path": "ch1.md", "content": "She recieved it.\n" }),
    );
    // An external edit (another editor, a sync tool) goes through the same pipeline.
    std::fs::write(dir.join("ch2.md"), "Anothr scene.\n").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let seen = |b: &Backend, m: &str| b.events.iter().any(|e| e["method"] == m);
    while !(seen(&b, "project/changed") && seen(&b, "diag/updated") && seen(&b, "history/changed"))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "events so far: {:?}",
            b.events
        );
        std::thread::sleep(std::time::Duration::from_millis(200));
        b.ok("ping", Value::Null);
    }
    let diag_files: Vec<String> = b
        .events
        .iter()
        .filter(|e| e["method"] == "diag/updated")
        .flat_map(|e| {
            e["params"]["files"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(diag_files.contains(&"ch2.md".to_string()), "{diag_files:?}");
    // Nothing hidden (.chronicler, .jj, temp files) ever leaks into change events.
    for e in b.events.iter().filter(|e| e["method"] == "project/changed") {
        for p in e["params"]["paths"].as_array().unwrap() {
            assert!(
                !p.as_str().unwrap().split('/').any(|c| c.starts_with('.')),
                "{p}"
            );
        }
    }
    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn continuity_checks_each_scene_against_earlier_facts() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let dir = temp_dir("continuity");
    let checks = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = checks.clone();
    let base = mock_openai_with(
        std::sync::Arc::new(move |req: &Value| {
            let (system, user) = prompts(req);
            if system.contains("continuity ledger") {
                if user.contains("blue eyes") {
                    return json!({ "facts": [{ "fact": "Maren has blue eyes", "kind": "physical",
                        "subjects": ["Maren"], "quote": "her blue eyes", "basis": "narrated" }] })
                    .to_string();
                }
                return json!({ "facts": [] }).to_string();
            }
            if system.contains("continuity editor") {
                counted.fetch_add(1, Ordering::SeqCst);
                assert!(user.contains("F1 [ch1] (narrated) Maren has blue eyes"), "{user}");
                return json!({ "contradictions": [
                    { "quote": "her brown eyes", "contradicts": "F1", "kind": "physical",
                      "message": "Maren's eyes change colour.", "confidence": "high" },
                    { "quote": "words that are not in the scene", "contradicts": "F1", "kind": "physical",
                      "message": "Invented quote.", "confidence": "high" },
                    { "quote": "her brown eyes", "contradicts": "F9", "kind": "physical",
                      "message": "Cites a fact that doesn't exist.", "confidence": "high" },
                    { "quote": "her brown eyes", "contradicts": "F1", "kind": "physical",
                      "message": "Unsure.", "confidence": "low" }
                ] })
                .to_string();
            }
            "{}".into()
        }),
        String::new(),
    );
    let mut b = Backend::spawn(&dir);
    b.ok("ai/config_set", json!({ "provider": "openai-compat", "baseUrl": base, "fastModel": "mock", "deepModel": "mock", "ledgerOnSave": false }));
    b.ok("codex/create", json!({ "name": "Maren", "kind": "character" }));
    let filler = "The harbour was quiet and the boats rode low in the water while the gulls argued over scraps on the stones.";
    b.ok("document/save", json!({ "path": "ch1.md", "content": format!("Maren looked up with her blue eyes. {filler}") }));
    b.ok("document/save", json!({ "path": "ch2.md", "content": format!("Maren narrowed her brown eyes. {filler}") }));

    let r = b.ok("agents/continuity", Value::Null);
    assert_eq!(r["checked"], 2, "{r}");
    assert_eq!(r["findings"], 1, "only the verified, confident finding survives: {r}");
    assert_eq!(checks.load(Ordering::SeqCst), 1, "the first scene has nothing earlier to contradict");

    let diags = b.ok("diag/check", json!({ "path": "ch2.md" }))["files"]["ch2.md"].clone();
    let found: Vec<&Value> = diags.as_array().unwrap().iter().filter(|d| d["source"] == "assistant").collect();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["text"], "her brown eyes");
    assert!(found[0]["message"].as_str().unwrap().contains("established in ch1: “her blue eyes”"), "{}", found[0]);

    // Nothing changed: a second pass skips both scenes and keeps the finding.
    let r = b.ok("agents/continuity", Value::Null);
    assert_eq!(r["checked"], 0, "{r}");
    assert_eq!(r["unchanged"], 2);
    assert_eq!(r["findings"], 1);
    assert_eq!(checks.load(Ordering::SeqCst), 1);

    // Asking about one scene always re-checks it.
    let r = b.ok("agents/continuity", json!({ "path": "ch2.md" }));
    assert_eq!(r["checked"], 1);
    assert_eq!(checks.load(Ordering::SeqCst), 2);

    // A cost estimate needs no network when the provider publishes no prices.
    let est = b.ok("agents/estimate", json!({ "job": "critique" }));
    assert_eq!(est["scenes"], 2);
    assert!(est["words"].as_u64().unwrap() > 20);

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn dictionary_and_turned_off_rules_can_be_undone() {
    let dir = temp_dir("dictionary");
    let mut b = Backend::spawn(&dir);
    b.ok("diag/add_word", json!({ "word": "Veyra" }));
    b.ok("diag/add_word", json!({ "word": "aelith" }));
    assert_eq!(b.ok("diag/dictionary", Value::Null)["words"], json!(["aelith", "Veyra"]));
    b.ok("diag/remove_word", json!({ "word": "Veyra" }));
    assert_eq!(b.ok("diag/dictionary", Value::Null)["words"], json!(["aelith"]));

    b.ok("diag/ignore", json!({ "ruleId": "HARPER/RepeatedWords" }));
    b.ok("diag/ignore", json!({ "ruleId": "spelling", "file": "ch1.md", "text": "Thurn" }));
    let ignored = b.ok("diag/ignored", Value::Null)["ignored"].clone();
    assert_eq!(ignored[0]["label"], "Repeated words");
    assert_eq!(ignored[0]["file"], "*");
    assert_eq!(ignored[1]["label"], "Spelling");
    b.ok("diag/unignore", json!({ "ruleId": "spelling", "file": "ch1.md", "text": "Thurn" }));
    assert_eq!(b.ok("diag/ignored", Value::Null)["ignored"].as_array().unwrap().len(), 1);

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn chat_prompt_is_the_writers_to_extend_or_replace() {
    let dir = temp_dir("chatprompt");
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    // Streaming chat gets `stream_text`; record every system prompt on the way.
    let base = {
        let listener_log = log.clone();
        mock_openai_with(
            std::sync::Arc::new(move |req: &Value| {
                listener_log.lock().unwrap().push(prompts(req).0);
                "ok".into()
            }),
            "Noted.".into(),
        )
    };
    let mut b = Backend::spawn(&dir);
    b.ok("ai/config_set", json!({ "provider": "openai-compat", "baseUrl": base, "fastModel": "mock", "deepModel": "mock" }));
    let default = b.ok("ai/default_prompts", Value::Null)["chat"].as_str().unwrap().to_string();
    assert!(default.contains("write or rewrite their prose"));

    b.ok("ai/config_set", json!({ "chatInstructions": "Call me Captain." }));
    b.ok("agents/chat", json!({ "messages": [{ "role": "user", "content": "hi" }] }));
    b.ok("ai/config_set", json!({ "chatPrompt": "You are a pirate." }));
    b.ok("agents/chat", json!({ "messages": [{ "role": "user", "content": "hi" }] }));

    let prompts = seen.lock().unwrap().clone();
    assert_eq!(prompts.len(), 2, "{prompts:?}");
    assert!(prompts[0].starts_with(default.trim()) && prompts[0].contains("Call me Captain."), "{}", prompts[0]);
    assert!(prompts[1].starts_with("You are a pirate.") && prompts[1].contains("Call me Captain."), "{}", prompts[1]);
    assert!(!prompts[1].contains("write or rewrite their prose"), "a replacement prompt replaces");
    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn codex_drafts_see_only_paragraphs_about_the_subject() {
    let dir = temp_dir("filldraft");
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let cap = captured.clone();
    let base = mock_openai_with(
        std::sync::Arc::new(move |req: &Value| {
            let (system, user) = prompts(req);
            if system.contains("world bible") {
                *cap.lock().unwrap() = user;
                return "**Role**\n- Waits at the harbour.".into();
            }
            "{}".into()
        }),
        String::new(),
    );
    let mut b = Backend::spawn(&dir);
    b.ok("ai/config_set", json!({ "provider": "openai-compat", "baseUrl": base, "fastModel": "mock", "deepModel": "mock", "ledgerOnSave": false }));
    let id = b.ok("codex/create", json!({ "name": "Maren", "kind": "character", "summary": "A courier." }))["id"].as_i64().unwrap();
    b.ok("document/save", json!({ "path": "harbour.md", "content":
        "# The Harbour\n\nThe fog came in thick as wet wool.\n\nMaren waited by the third bollard.\n\nA bell rang eleven times.\n" }));
    b.ok("codex/reindex", Value::Null);
    let text = b.ok("agents/fill", json!({ "id": id, "field": "body" }))["text"].as_str().unwrap().to_string();
    assert!(text.contains("Waits at the harbour"));

    let user = captured.lock().unwrap().clone();
    assert!(user.contains("Maren waited by the third bollard."), "{user}");
    assert!(!user.contains("wet wool") && !user.contains("bell rang"), "unrelated paragraphs leaked: {user}");
    assert!(!user.contains("The Harbour") && !user.contains("harbour.md"), "scene names leaked: {user}");
    assert!(user.contains("The writer's summary (their intent): A courier."));
    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn scene_details_threads_notes_and_reader_knowledge() {
    let dir = temp_dir("story");
    let base = mock_openai_with(
        std::sync::Arc::new(|req: &Value| {
            let (system, user) = prompts(req);
            if system.contains("continuity ledger") && user.contains("lighthouse keeper") {
                return json!({ "facts": [{ "fact": "Maren is the lighthouse keeper's daughter", "kind": "relationship",
                    "subjects": ["Maren"], "quote": "the lighthouse keeper's daughter", "basis": "narrated" }] }).to_string();
            }
            json!({ "facts": [] }).to_string()
        }),
        String::new(),
    );
    let mut b = Backend::spawn(&dir);
    b.ok("ai/config_set", json!({ "provider": "openai-compat", "baseUrl": base, "fastModel": "mock", "deepModel": "mock", "ledgerOnSave": false }));
    let maren = b.ok("codex/create", json!({ "name": "Maren", "kind": "character" }))["id"].as_i64().unwrap();
    let harbour = b.ok("codex/create", json!({ "name": "Kestle Harbour", "kind": "place" }))["id"].as_i64().unwrap();
    let ilse = b.ok("codex/create", json!({ "name": "Ilse", "kind": "character" }))["id"].as_i64().unwrap();
    let filler = "The morning came slowly over the water and the gulls wheeled above the grey stones of the quay.";
    b.ok("project/create_folder", json!({ "path": "Ch" }));
    b.ok("document/save", json!({ "path": "Ch/1.md", "content": format!("Maren, the lighthouse keeper's daughter, walked the wall. {filler}") }));
    b.ok("document/save", json!({ "path": "Ch/2.md", "content": format!("Maren met Ilse at the bollard. <!-- slower here? --> {filler}\n<!-- check the tide times -->\n") }));

    // Threads and details
    let letter = b.ok("threads/create", json!({ "name": "The letter" }))["id"].as_i64().unwrap();
    let debt = b.ok("threads/create", json!({ "name": "Her father's debt" }))["id"].as_i64().unwrap();
    b.ok("meta/set", json!({ "path": "Ch/2.md", "pov": maren, "location": harbour, "storyTime": "Day 1, dawn", "target": 2000, "threads": [letter, debt] }));
    let meta = b.ok("meta/get_all", Value::Null)["meta"].clone();
    let two = meta.as_array().unwrap().iter().find(|m| m["file"] == "Ch/2.md").unwrap().clone();
    assert_eq!(two["pov"], maren);
    assert_eq!(two["storyTime"], "Day 1, dawn");
    assert_eq!(two["target"], 2000);
    assert_eq!(two["threads"], json!([letter, debt]));
    // A partial update leaves the rest; 0 clears the point of view.
    b.ok("meta/set", json!({ "path": "Ch/2.md", "pov": 0, "status": "draft" }));
    let two = b.ok("meta/get_all", Value::Null)["meta"].as_array().unwrap().iter().find(|m| m["file"] == "Ch/2.md").unwrap().clone();
    assert_eq!(two["pov"], Value::Null);
    assert_eq!(two["location"], harbour);
    assert_eq!(two["status"], "draft");
    // Deleting a thread takes it off scenes; renames carry threads along.
    b.ok("threads/delete", json!({ "id": debt }));
    b.ok("project/rename", json!({ "from": "Ch", "to": "Chapter One" }));
    let moved = b.ok("meta/get_all", Value::Null)["meta"].as_array().unwrap().iter().find(|m| m["file"] == "Chapter One/2.md").unwrap().clone();
    assert_eq!(moved["threads"], json!([letter]));

    // Margin notes, in reading order, and resolving one
    let notes = b.ok("notes/list", Value::Null)["notes"].clone();
    assert_eq!(notes.as_array().unwrap().len(), 2, "{notes}");
    assert_eq!(notes[0]["text"], "slower here?");
    b.ok("notes/resolve", json!({ "path": "Chapter One/2.md", "line": 2, "text": "check the tide times" }));
    let text = b.ok("document/read", json!({ "path": "Chapter One/2.md" }))["content"].as_str().unwrap().to_string();
    assert!(!text.contains("tide times") && text.contains("slower here?"), "{text}");
    assert!(b.call("notes/resolve", json!({ "path": "Chapter One/2.md", "line": 2, "text": "check the tide times" }))["error"].is_object());

    // What the reader knows by scene 2: Maren from scene 1's facts; Ilse is new.
    b.ok("agents/ledger", Value::Null);
    b.ok("codex/reindex", Value::Null);
    let k = b.ok("story/reader_knowledge", json!({ "path": "Chapter One/2.md" }));
    let known: Vec<&str> = k["known"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    let introduced: Vec<&str> = k["introduced"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(known, vec!["Maren"], "{k}");
    assert_eq!(introduced, vec!["Ilse"], "{k}");
    assert_eq!(k["known"][0]["facts"][0]["fact"], "Maren is the lighthouse keeper's daughter");
    let _ = ilse;

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn renaming_a_codex_entry_rewrites_the_manuscript() {
    let dir = temp_dir("codex-rename");
    let mut b = Backend::spawn(&dir);
    b.ok("document/save", json!({ "path": "01 Arrival.md", "content": "Maren's coat was wet.\nMAREN! The Marens' house stood by Marengo.\n" }));
    b.ok("document/save", json!({ "path": "02 Road.md", "content": "Maren walked on.\nThen Maren stopped.\n" }));
    std::fs::create_dir_all(dir.join("Research")).unwrap();
    std::fs::write(dir.join("Research/notes.md"), "Maren is based on my aunt.\n").unwrap();
    let id = b.ok("codex/create", json!({ "name": "Maren", "summary": "Maren is the smuggler." }))["id"].as_i64().unwrap();
    b.ok("codex/create", json!({ "name": "Tobin", "summary": "Owes Maren money." }));
    b.ok("meta/set", json!({ "path": "02 Road.md", "synopsis": "Maren leaves." }));

    let p = b.ok("codex/rename_preview", json!({ "id": id, "from": "Maren", "to": "Marin" }));
    assert_eq!(p["total"], 5, "{p}");
    let scenes = p["scenes"].as_array().unwrap();
    assert_eq!(scenes.len(), 2, "research is never touched");
    assert_eq!(scenes[0]["path"], "01 Arrival.md");
    let found: Vec<&str> = scenes[0]["occurrences"].as_array().unwrap().iter().map(|o| o["found"].as_str().unwrap()).collect();
    assert_eq!(found, ["Maren", "MAREN", "Marens"]);
    assert_eq!(scenes[0]["occurrences"][1]["replacement"], "MARIN");
    assert_eq!(scenes[0]["occurrences"][1]["line"], 2);
    assert_eq!(p["notes"].as_array().unwrap().len(), 3, "two entries and one synopsis: {p}");

    // Leave the second line of the road scene alone.
    let road = &scenes[1]["occurrences"];
    let chosen = json!([
        { "path": "01 Arrival.md", "starts": scenes[0]["occurrences"].as_array().unwrap().iter().map(|o| o["start"].clone()).collect::<Vec<_>>() },
        { "path": "02 Road.md", "starts": [road[0]["start"]] },
    ]);
    let r = b.ok("codex/rename_apply", json!({ "id": id, "from": "Maren", "to": "Marin", "chosen": chosen, "keepAlias": true, "updateNotes": true }));
    assert_eq!(r["filesChanged"], 2);
    assert_eq!(r["replaced"], 4);
    assert_eq!(r["notesChanged"], 3);
    let read = |p: &str| std::fs::read_to_string(dir.join(p)).unwrap();
    assert_eq!(read("01 Arrival.md"), "Marin's coat was wet.\nMARIN! The Marins' house stood by Marengo.\n");
    assert_eq!(read("02 Road.md"), "Marin walked on.\nThen Maren stopped.\n");
    assert_eq!(read("Research/notes.md"), "Maren is based on my aunt.\n");

    let list = b.ok("codex/list", Value::Null);
    let e = list["entities"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
    assert_eq!(e["name"], "Marin");
    assert_eq!(e["aliases"], json!(["Maren"]));
    assert_eq!(e["summary"], "Marin is the smuggler.");
    assert!(list["entities"].as_array().unwrap().iter().any(|e| e["summary"] == "Owes Marin money."));
    let meta = b.ok("meta/get_all", Value::Null);
    assert_eq!(meta["meta"][0]["synopsis"], "Marin leaves.");
    // Mentions follow: both names still answer to the entry.
    assert_eq!(b.ok("codex/mentions", json!({ "id": id }))["mentions"].as_array().unwrap().len(), 4);

    // Renaming an alias, codex only, without keeping it.
    b.ok("codex/rename_apply", json!({ "id": id, "from": "Maren", "to": "Mar" }));
    let e = b.ok("codex/list", Value::Null)["entities"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
    assert_eq!(e["name"], "Marin");
    assert_eq!(e["aliases"], json!(["Mar"]));
    assert_eq!(read("02 Road.md"), "Marin walked on.\nThen Maren stopped.\n");

    // Paths outside the manuscript and unknown names are refused.
    b.err("codex/rename_apply", json!({ "id": id, "from": "Marin", "to": "M", "chosen": [{ "path": "Research/notes.md", "starts": [0] }] }));
    b.err("codex/rename_apply", json!({ "id": id, "from": "Nobody", "to": "M" }));
    b.err("codex/rename_preview", json!({ "id": id, "from": "Marin", "to": "Marin" }));
    assert!(b.err("codex/rename_apply", json!({ "id": id, "from": "Marin", "to": "Tobin" })).contains("already called"));
    assert_eq!(b.ok("codex/list", Value::Null)["entities"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap()["name"], "Marin");

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn catch_up_briefs_from_scenes_up_to_here_only() {
    let dir = temp_dir("catchup");
    let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let cap = captured.clone();
    let base = mock_openai_with(
        std::sync::Arc::new(move |req: &Value| {
            let (system, user) = prompts(req);
            if system.contains("coming back to their own book") {
                cap.lock().unwrap().push(user);
                return "Maren has found the letter and waits for the tide.".into();
            }
            json!({ "facts": [] }).to_string()
        }),
        String::new(),
    );
    let mut b = Backend::spawn(&dir);
    b.ok("project/create_folder", json!({ "path": "One" }));
    b.ok("project/create_folder", json!({ "path": "Two" }));
    b.ok("document/save", json!({ "path": "One/1 Harbour.md", "content": "Maren walks the harbour wall at dawn." }));
    b.ok("document/save", json!({ "path": "One/2 Letter.md", "content": "In the drawer Maren finds a letter sealed with green wax." }));
    b.ok("document/save", json!({ "path": "Two/3 Tide.md", "content":
        "# Tide\n\nShe reads the letter twice. <!-- slower here? -->\n\nThe tide turns; she waits by the bollard.\nNobody comes.\n" }));
    b.ok("document/save", json!({ "path": "Two/4 Later.md", "content": "LATERTEXT: the ship sinks. <!-- move this? -->" }));
    b.ok("meta/set", json!({ "path": "One/1 Harbour.md", "synopsis": "Maren patrols the harbour." }));
    b.ok("meta/set", json!({ "path": "Two/4 Later.md", "synopsis": "LATERSYNOPSIS" }));
    let letter = b.ok("threads/create", json!({ "name": "The letter" }))["id"].as_i64().unwrap();
    let ship = b.ok("threads/create", json!({ "name": "The ship" }))["id"].as_i64().unwrap();
    let dawn = b.ok("threads/create", json!({ "name": "Dawn walks" }))["id"].as_i64().unwrap();
    b.ok("meta/set", json!({ "path": "One/2 Letter.md", "threads": [letter] }));
    b.ok("meta/set", json!({ "path": "Two/3 Tide.md", "threads": [letter], "status": "draft", "target": 1500, "storyTime": "Day 2" }));
    b.ok("meta/set", json!({ "path": "Two/4 Later.md", "threads": [ship] }));
    b.ok("meta/set", json!({ "path": "One/1 Harbour.md", "threads": [dawn] }));

    // No AI set up: the factual parts only.
    let r = b.ok("agents/catch_up", json!({ "path": "Two/3 Tide.md" }));
    assert_eq!(r["summary"], "no_ai");
    assert_eq!(r["storySoFar"], "");
    assert_eq!((r["position"].as_u64(), r["total"].as_u64(), r["chapter"].as_str()), (Some(3), Some(4), Some("Two")));
    let left = &r["leftOff"];
    assert_eq!(left["excerpt"], "She reads the letter twice.\n\nThe tide turns; she waits by the bollard.\nNobody comes.");
    assert_eq!((left["line"].as_u64(), left["endLine"].as_u64()), (Some(3), Some(6)));
    assert_eq!((left["status"].as_str(), left["target"].as_u64(), left["storyTime"].as_str()), (Some("draft"), Some(1500), Some("Day 2")));
    let threads: Vec<(String, Value, Value)> = r["threads"].as_array().unwrap().iter()
        .map(|t| (t["name"].as_str().unwrap().to_string(), t["scenes"].clone(), t["lastSeen"].clone())).collect();
    assert_eq!(threads, vec![
        ("The letter".to_string(), json!(["Two/3 Tide.md"]), json!("Two/3 Tide.md")),
        ("The ship".to_string(), json!(["Two/4 Later.md"]), Value::Null),
    ]);
    let notes: Vec<&str> = r["notes"].as_array().unwrap().iter().map(|n| n["text"].as_str().unwrap()).collect();
    assert_eq!(notes, vec!["slower here?", "move this?"]);
    assert!(r["lastWorked"]["sceneAt"].as_i64().unwrap() > 0);
    assert!(r["lastWorked"]["latestScene"].is_string());
    assert!(b.err("agents/catch_up", json!({ "path": "nowhere.md" })).contains("manuscript scenes"));

    // With AI: facts first, no call; then the summary, from scenes 1–3 only.
    b.ok("ai/config_set", json!({ "provider": "openai-compat", "baseUrl": base, "fastModel": "mock", "deepModel": "mock", "ledgerOnSave": false }));
    let r = b.ok("agents/catch_up", json!({ "path": "Two/3 Tide.md", "summary": false }));
    assert_eq!(r["summary"], "pending");
    assert!(captured.lock().unwrap().is_empty());
    let r = b.ok("agents/catch_up", json!({ "path": "Two/3 Tide.md" }));
    assert_eq!(r["summary"], "ready", "{r}");
    assert_eq!(r["storySoFar"], "Maren has found the letter and waits for the tide.");
    let user = captured.lock().unwrap()[0].clone();
    assert!(user.contains("Maren patrols the harbour."), "synopsis of scene 1: {user}");
    assert!(user.contains("sealed with green wax"), "text of scene 2 (no synopsis): {user}");
    assert!(user.contains("The tide turns"), "the current scene: {user}");
    assert!(!user.contains("LATER") && !user.contains("ship"), "a later scene leaked: {user}");
    assert!(!user.contains("slower here?"), "margin notes leaked: {user}");

    // Unchanged: cached, no second call; refresh forces one.
    let r = b.ok("agents/catch_up", json!({ "path": "Two/3 Tide.md", "summary": false }));
    assert_eq!(r["summary"], "ready");
    assert_eq!(captured.lock().unwrap().len(), 1);
    b.ok("agents/catch_up", json!({ "path": "Two/3 Tide.md", "refresh": true }));
    assert_eq!(captured.lock().unwrap().len(), 2);
    // An edit before here invalidates it.
    b.ok("document/save", json!({ "path": "One/2 Letter.md", "content": "Maren burns the letter." }));
    assert_eq!(b.ok("agents/catch_up", json!({ "path": "Two/3 Tide.md", "summary": false }))["summary"], "pending");

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
