//! Read aloud against a local mock of the AI provider (never the real APIs).

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

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
    let dir = std::env::temp_dir().join(format!("chronicler-test-tts-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    /// Path and query.
    target: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

type Log = Arc<Mutex<Vec<Seen>>>;
/// (status, content-type, body) for each request.
type Respond = Arc<dyn Fn(&Seen) -> (u16, &'static str, Vec<u8>) + Send + Sync>;

/// A tiny HTTP server that records every request.
fn mock(respond: Respond) -> (String, Log) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let log: Log = Default::default();
    let seen_log = log.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let respond = respond.clone();
            let log = seen_log.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    return;
                }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("").to_string();
                let mut headers = Vec::new();
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let l = line.trim_end();
                    if l.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = l.split_once(':') {
                        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
                        if k == "content-length" {
                            len = v.parse().unwrap_or(0);
                        }
                        headers.push((k, v));
                    }
                }
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).unwrap();
                let seen = Seen { method, target, headers, body: serde_json::from_slice(&body).unwrap_or(Value::Null) };
                let (status, ctype, out) = respond(&seen);
                log.lock().unwrap().push(seen);
                let mut s = stream;
                let _ = write!(s, "HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", out.len());
                let _ = s.write_all(&out);
            });
        }
    });
    (format!("http://{addr}"), log)
}

fn log_len(log: &Log) -> usize {
    log.lock().unwrap().len()
}

fn decode(b64: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(b64).unwrap()
}

const MP3: &[u8] = b"ID3\x03fake-mp3-frames";
const PCM: &[u8] = &[0, 1, 2, 3];

fn models_json() -> Vec<u8> {
    json!({ "data": [
        { "id": "google/gemini-3.8-flash-tts", "name": "Gemini 3.8 Flash TTS",
          "pricing": { "prompt": "0.0000005", "completion": "0.000009" },
          "supported_voices": ["Zephyr", "Charon"] },
        { "id": "hexgrad/kokoro-82m", "pricing": { "prompt": "0.000004", "completion": "0" },
          "supported_voices": ["af_heart"] }
    ]})
    .to_string()
    .into_bytes()
}

#[test]
fn openrouter_speech_uses_the_ai_connection() {
    let dir = temp_dir("openrouter");
    let quota = Arc::new(Mutex::new(false));
    let q = quota.clone();
    let (base, log) = mock(Arc::new(move |req: &Seen| {
        if req.header("authorization") != Some("Bearer sk-or") {
            (401, "application/json", br#"{"error":{"message":"No auth credentials found","code":401}}"#.to_vec())
        } else if req.method == "GET" {
            (200, "application/json", models_json())
        } else if *q.lock().unwrap() {
            (402, "application/json", br#"{"error":{"message":"Insufficient credits","code":402}}"#.to_vec())
        } else if req.body["response_format"] == "pcm" {
            (200, "audio/pcm;rate=24000", PCM.to_vec())
        } else {
            (200, "audio/mpeg", MP3.to_vec())
        }
    }));
    let mut b = Backend::spawn(&dir);
    b.ok("ai/config_set", json!({ "provider": "openrouter", "baseUrl": format!("{base}/api/v1") }));

    // Gemini Flash TTS by default; no key yet means nothing is sent.
    let cfg = b.ok("tts/config", Value::Null);
    assert_eq!(cfg["model"], "google/gemini-3.8-flash-tts");
    assert_eq!(cfg["voice"], "");
    assert!(b.err("tts/speak", json!({ "text": "Hello." })).contains("Settings → AI"));
    assert!(log.lock().unwrap().is_empty());

    b.ok("ai/set_key", json!({ "key": "wrong" }));
    assert_eq!(b.err("tts/speak", json!({ "text": "Hello." })), "The AI provider rejected the key — check it in Settings → AI");
    b.ok("ai/set_key", json!({ "key": "sk-or" }));

    // Speech models come with prices and voices.
    let models = b.ok("tts/models", Value::Null)["models"].clone();
    assert_eq!(models[0]["id"], "google/gemini-3.8-flash-tts");
    assert!((models[0]["outputPrice"].as_f64().unwrap() - 9.0).abs() < 1e-9);
    assert_eq!(models[0]["voices"], json!(["Zephyr", "Charon"]));
    assert!(models[1].get("outputPrice").is_none_or(Value::is_null), "a zero output price is no price");
    assert_eq!(log.lock().unwrap().last().unwrap().target, "/api/v1/models?output_modalities=speech");
    let voices = b.ok("tts/voices", Value::Null)["voices"].clone();
    assert_eq!(voices[1]["id"], "Charon");

    // No voice chosen: the model's first. Gemini speaks raw PCM, wrapped as WAV.
    let r = b.ok("tts/speak", json!({ "text": "The tide came in." }));
    let audio = decode(r["audio"].as_str().unwrap());
    assert_eq!((&audio[..4], &audio[44..]), (&b"RIFF"[..], PCM));
    assert_eq!(r["mime"], "audio/wav");
    assert_eq!((r["chars"].clone(), r["cached"].clone()), (json!(17), json!(false)));
    {
        let log = log.lock().unwrap();
        let req = log.last().unwrap();
        assert_eq!((req.method.as_str(), req.target.as_str()), ("POST", "/api/v1/audio/speech"));
        assert_eq!(
            req.body,
            json!({ "model": "google/gemini-3.8-flash-tts", "voice": "Zephyr", "input": "The tide came in.", "response_format": "pcm" })
        );
    }

    // Same text again: from the cache, no call.
    let before = log.lock().unwrap().len();
    assert_eq!(b.ok("tts/speak", json!({ "text": "The tide came in." }))["cached"], true);
    assert_eq!(log.lock().unwrap().len(), before);

    // A new voice or speed is new audio; changing the model clears the voice.
    b.ok("tts/config_set", json!({ "voice": "Charon", "speed": 1.25 }));
    assert_eq!(b.ok("tts/speak", json!({ "text": "The tide came in." }))["cached"], false);
    {
        let log = log.lock().unwrap();
        let body = &log.last().unwrap().body;
        assert_eq!((body["voice"].clone(), body["speed"].clone()), (json!("Charon"), json!(1.25)));
    }
    b.ok("tts/config_set", json!({ "model": "hexgrad/kokoro-82m" }));
    assert_eq!(b.ok("tts/config", Value::Null)["voice"], "");

    // Over one request's limit: split at sentences, audio concatenated.
    let long = "The gulls rose and fell over the grey water all afternoon. ".repeat(120);
    let before = log.lock().unwrap().len();
    let r = b.ok("tts/speak", json!({ "text": long }));
    let pieces: Vec<Seen> = log.lock().unwrap()[before..].iter().filter(|s| s.method == "POST").cloned().collect();
    assert_eq!(pieces.len(), 2);
    assert!(pieces.iter().all(|p| p.body["input"].as_str().unwrap().chars().count() <= 4000));
    assert!(pieces.iter().all(|p| p.body["voice"] == "af_heart"));
    assert_eq!(decode(r["audio"].as_str().unwrap()), [MP3, MP3].concat());

    *quota.lock().unwrap() = true;
    assert!(b.err("tts/speak", json!({ "text": "Something new." })).contains("out of credits"));

    // Guard rails
    assert!(b.err("tts/speak", json!({ "text": "   " })).contains("Nothing to read"));
    assert!(b.err("tts/speak", json!({ "text": "a".repeat(20_001) })).contains("too long"));
    assert!(b.err("tts/config_set", json!({ "speed": 9 })).contains("Speed"));

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_local_server_needs_no_key() {
    let dir = temp_dir("local");
    let (base, log) = mock(Arc::new(|req: &Seen| match req.target.as_str() {
        "/v1/models" => (200, "application/json", br#"{"data":[{"id":"kokoro"}]}"#.to_vec()),
        "/v1/audio/voices" => (200, "application/json", br#"{"voices":["af_bella","bm_george"]}"#.to_vec()),
        _ if req.body["model"] == "raw" && req.body["response_format"] != "pcm" => {
            (400, "application/json", br#"{"error":{"message":"This model only supports response_format=\"pcm\""}}"#.to_vec())
        }
        _ if req.body["model"] == "raw" => (200, "audio/pcm", PCM.to_vec()),
        _ => (200, "audio/mpeg", MP3.to_vec()),
    }));
    let mut b = Backend::spawn(&dir);
    b.ok("ai/config_set", json!({ "provider": "openai-compat", "baseUrl": format!("{base}/v1") }));

    // No default model for a local server.
    assert_eq!(b.ok("tts/config", Value::Null)["model"], "");
    assert!(b.err("tts/speak", json!({ "text": "Hello." })).contains("speech model"));

    assert_eq!(b.ok("tts/models", Value::Null)["models"][0]["id"], "kokoro");
    b.ok("tts/config_set", json!({ "model": "kokoro" }));
    let voices = b.ok("tts/voices", Value::Null)["voices"].clone();
    assert_eq!(voices[1]["id"], "bm_george");

    b.ok("tts/speak", json!({ "text": "Hello.", "voice": "bm_george" }));
    {
        let seen = log.lock().unwrap();
        let req = seen.last().unwrap();
        assert_eq!(req.target, "/v1/audio/speech");
        assert_eq!(req.header("authorization"), None);
        assert_eq!(req.body["voice"], "bm_george");
    }

    // A model that refuses mp3 is asked again for PCM, and remembered.
    b.ok("tts/config_set", json!({ "model": "raw", "voice": "v" }));
    let r = b.ok("tts/speak", json!({ "text": "One." }));
    assert_eq!(r["mime"], "audio/wav");
    let before = log_len(&log);
    b.ok("tts/speak", json!({ "text": "Two." }));
    assert_eq!(log_len(&log) - before, 1, "straight to PCM the second time");

    b.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}
