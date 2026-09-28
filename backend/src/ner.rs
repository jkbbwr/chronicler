use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokenizers::Tokenizer;

// Named-entity recognition via a quantized BERT NER model (dslim/bert-base-NER,
// ONNX conversion) running on onnxruntime. The model is downloaded once into
// a user-level cache and loaded lazily; when absent, discovery falls back to
// heuristics alone until `ner/ensure` fetches it. The loaded model (~110 MB
// resident) is dropped again after a few idle minutes.

/// Unload the model after this long without use.
const IDLE_UNLOAD: Duration = Duration::from_secs(5 * 60);

const MODEL_REPO: &str = "https://huggingface.co/Xenova/bert-base-NER/resolve/main";
const MODEL_FILES: [(&str, &str); 3] = [
    ("model_quantized.onnx", "onnx/model_quantized.onnx"),
    ("tokenizer.json", "tokenizer.json"),
    ("config.json", "config.json"),
];

pub fn model_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".cache")
        .join("chronicler")
        .join("models")
        .join("bert-base-NER")
}

pub fn is_ready() -> bool {
    let dir = model_dir();
    MODEL_FILES
        .iter()
        .all(|(local, _)| dir.join(local).exists())
}

/// Download the model files (idempotent). ~110MB on first run.
pub async fn ensure_model() -> Result<()> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).context("creating model cache dir")?;
    let client = reqwest::Client::new();
    for (local, remote) in MODEL_FILES {
        let target = dir.join(local);
        if target.exists() {
            continue;
        }
        let url = format!("{}/{}", MODEL_REPO, remote);
        let resp = client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("downloading {}", url))?;
        if !resp.status().is_success() {
            bail!("download failed for {}: HTTP {}", url, resp.status());
        }
        let bytes = resp
            .bytes()
            .await
            .with_context(|| format!("reading {}", url))?;
        let tmp = dir.join(format!(".{}.tmp", local));
        std::fs::write(&tmp, &bytes).context("writing model file")?;
        std::fs::rename(&tmp, &target).context("moving model file into place")?;
        tracing::info!("Downloaded {} ({} bytes)", local, bytes.len());
    }
    Ok(())
}

pub struct NerSpan {
    pub text: String,
    /// Mapped into codex kinds: character | place | faction | "" (unknown)
    pub kind: String,
    pub line: usize,
}

struct NerModel {
    session: ort::session::Session,
    tokenizer: Tokenizer,
    id2label: Vec<String>,
}

/// The lazily loaded model and when it was last used.
#[derive(Default)]
pub struct Ner {
    slot: Mutex<Option<(NerModel, Instant)>>,
}

impl Ner {
    pub fn is_ready(&self) -> bool {
        is_ready()
    }

    pub fn is_loaded(&self) -> bool {
        self.slot.lock().is_some()
    }

    /// Run NER over a document, line by line (prose lines are short enough
    /// that per-line inference stays comfortably under the model's
    /// 512-token window while giving us line numbers for free).
    pub fn extract(&self, content: &str) -> Result<Vec<NerSpan>> {
        if !is_ready() {
            bail!("NER model not downloaded");
        }
        let mut slot = self.slot.lock();
        if slot.is_none() {
            *slot = Some((load_model()?, Instant::now()));
        }
        let (model, last_used) = slot.as_mut().expect("model just loaded");
        *last_used = Instant::now();

        let mut spans = Vec::new();
        for (line_no, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.chars().count() < 3 {
                continue;
            }
            for (text, label) in run_line(model, line)? {
                spans.push(NerSpan {
                    text,
                    kind: ner_label_to_kind(&label),
                    line: line_no + 1,
                });
            }
        }
        Ok(spans)
    }

    /// Drop the model if it has sat unused for a while.
    pub fn unload_if_idle(&self) {
        let mut slot = self.slot.lock();
        if slot
            .as_ref()
            .is_some_and(|(_, t)| t.elapsed() >= IDLE_UNLOAD)
        {
            tracing::info!("unloading idle NER model");
            *slot = None;
        }
    }
}

fn load_model() -> Result<NerModel> {
    let dir = model_dir();
    let session = ort::session::Session::builder()
        .context("creating onnx session builder")?
        .commit_from_file(dir.join("model_quantized.onnx"))
        .context("loading NER model")?;
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|e| anyhow!("loading tokenizer: {}", e))?;
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("config.json"))?)
            .context("parsing model config")?;
    let map = config["id2label"]
        .as_object()
        .context("model config missing id2label")?;
    let mut id2label = vec![String::from("O"); map.len()];
    for (k, v) in map {
        if let (Ok(i), Some(label)) = (k.parse::<usize>(), v.as_str())
            && i < id2label.len()
        {
            id2label[i] = label.to_string();
        }
    }
    Ok(NerModel {
        session,
        tokenizer,
        id2label,
    })
}

fn ner_label_to_kind(label: &str) -> String {
    match label {
        "PER" => "character".into(),
        "LOC" => "place".into(),
        "ORG" => "faction".into(),
        _ => String::new(), // MISC and friends: let the writer or LLM decide
    }
}

fn run_line(model: &mut NerModel, line: &str) -> Result<Vec<(String, String)>> {
    let encoding = model
        .tokenizer
        .encode(line, true)
        .map_err(|e| anyhow!("tokenizing: {}", e))?;
    let ids: Vec<i64> = encoding.get_ids().iter().map(|&i| i as i64).collect();
    let seq = ids.len().min(512);
    if seq == 0 {
        return Ok(vec![]);
    }
    let ids = &ids[..seq];
    let mask: Vec<i64> = encoding.get_attention_mask()[..seq]
        .iter()
        .map(|&i| i as i64)
        .collect();
    let type_ids: Vec<i64> = encoding.get_type_ids()[..seq]
        .iter()
        .map(|&i| i as i64)
        .collect();
    let offsets = encoding.get_offsets();

    let input_ids = ort::value::Tensor::from_array(([1usize, seq], ids.to_vec()))?;
    let attention = ort::value::Tensor::from_array(([1usize, seq], mask))?;
    let token_types = ort::value::Tensor::from_array(([1usize, seq], type_ids))?;

    let outputs = model.session.run(ort::inputs![
        "input_ids" => input_ids,
        "attention_mask" => attention,
        "token_type_ids" => token_types,
    ])?;
    let (shape, logits) = outputs[0].try_extract_tensor::<f32>()?;
    let num_labels = *shape.last().context("bad logits shape")? as usize;

    // Pass 1: regroup wordpiece tokens into whole words by offset continuity
    // ("Vey" + "##ra" share a boundary), taking the FIRST subtoken's label for
    // the word — otherwise unknown fantasy names come out fragmented.
    struct Word {
        start: usize,
        end: usize,
        label: String,
    }
    let mut words: Vec<Word> = Vec::new();
    for t in 0..seq {
        let (off_start, off_end) = offsets[t];
        if off_end <= off_start {
            continue; // special tokens ([CLS]/[SEP]/[PAD]) carry (0, 0)
        }
        let row = &logits[t * num_labels..(t + 1) * num_labels];
        let best = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(0);
        let label = model
            .id2label
            .get(best)
            .cloned()
            .unwrap_or_else(|| "O".into());

        match words.last_mut() {
            Some(w) if w.end == off_start => w.end = off_end, // subword continuation
            _ => words.push(Word {
                start: off_start,
                end: off_end,
                label,
            }),
        }
    }

    // Pass 2: standard BIO merge over whole words
    let mut results: Vec<(String, String)> = Vec::new();
    let mut current: Option<(usize, usize, String)> = None;
    let close = |cur: &mut Option<(usize, usize, String)>, out: &mut Vec<(String, String)>| {
        if let Some((s, e, l)) = cur.take()
            && let Some(text) = line.get(s..e)
        {
            out.push((text.to_string(), l));
        }
    };
    for w in &words {
        if w.label == "O" {
            close(&mut current, &mut results);
            continue;
        }
        let (bio, entity) = w.label.split_once('-').unwrap_or(("B", w.label.as_str()));
        match &mut current {
            Some((_, end, l)) if bio == "I" && l == entity => *end = w.end,
            _ => {
                close(&mut current, &mut results);
                current = Some((w.start, w.end, entity.to_string()));
            }
        }
    }
    close(&mut current, &mut results);

    Ok(results
        .into_iter()
        .filter(|(t, _)| t.chars().count() >= 2)
        .collect())
}
