use crate::app::App;
use crate::db;
use crate::fsx::is_matter_path;
use anyhow::{Context, Result};

// Manuscript RAG index. Scenes are chunked into paragraph groups, embedded
// through the configured provider (OpenRouter or any OpenAI-compatible
// server — both expose /embeddings), and stored in the project db. A novel
// is small enough that brute-force cosine over normalized vectors beats
// hauling in an ANN index.

/// Chunk target size in words; small enough to stay specific, big enough to
/// carry a beat of story.
const CHUNK_WORDS: usize = 220;

pub struct Chunk {
    pub start_line: usize, // 1-based, inclusive
    pub end_line: usize,
    pub text: String,
}

/// Split a scene into overlapping paragraph-grouped chunks of roughly
/// CHUNK_WORDS words. The previous chunk's last paragraph leads the next
/// chunk so context never cuts dead at a boundary.
pub fn chunk_text(content: &str) -> Vec<Chunk> {
    // Paragraph = consecutive non-empty lines
    struct Para {
        start: usize,
        end: usize,
        text: String,
        words: usize,
    }
    let mut paras: Vec<Para> = Vec::new();
    let mut cur: Option<Para> = None;
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            if let Some(p) = cur.take() {
                paras.push(p);
            }
        } else {
            match &mut cur {
                Some(p) => {
                    p.end = i + 1;
                    p.text.push('\n');
                    p.text.push_str(line);
                    p.words += line.split_whitespace().count();
                }
                None => {
                    cur = Some(Para {
                        start: i + 1,
                        end: i + 1,
                        text: line.to_string(),
                        words: line.split_whitespace().count(),
                    })
                }
            }
        }
    }
    if let Some(p) = cur.take() {
        paras.push(p);
    }

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut i = 0;
    while i < paras.len() {
        let mut words = 0;
        let start_para = i;
        let mut end_para = i;
        while end_para < paras.len() && (words == 0 || words + paras[end_para].words <= CHUNK_WORDS)
        {
            words += paras[end_para].words;
            end_para += 1;
        }
        let group = &paras[start_para..end_para];
        chunks.push(Chunk {
            start_line: group[0].start,
            end_line: group[group.len() - 1].end,
            text: group
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
        });
        if end_para >= paras.len() {
            break;
        }
        // Overlap: step back one paragraph unless that would stall
        i = if end_para - start_para > 1 {
            end_para - 1
        } else {
            end_para
        };
    }
    chunks
}

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

struct Embedded {
    file: String,
    chunks: Vec<(Chunk, Vec<f32>)>,
}

/// Chunk and embed files through the provider. Nothing is written here, so
/// a failed network call never costs the existing index anything.
async fn embed_files(app: &App, files: &[String]) -> Result<Vec<Embedded>> {
    let mut out = Vec::new();
    for rel in files {
        if is_matter_path(rel) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(app.root.join(rel)) else {
            continue;
        };
        let chunks = chunk_text(&content);
        let vectors = if chunks.is_empty() {
            vec![]
        } else {
            let texts = chunks.iter().map(|c| c.text.clone()).collect();
            crate::agents::embed_texts(app, texts)
                .await
                .with_context(|| format!("embedding {rel}"))?
        };
        out.push(Embedded {
            file: rel.clone(),
            chunks: chunks.into_iter().zip(vectors).collect(),
        });
    }
    Ok(out)
}

fn store(tx: &rusqlite::Transaction, batch: &[Embedded]) -> Result<usize> {
    let mut del = tx.prepare("DELETE FROM embeddings WHERE file = ?1")?;
    let mut ins = tx.prepare(
        "INSERT INTO embeddings (file, chunk, start_line, end_line, text, vector)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    let mut written = 0;
    for e in batch {
        del.execute([&e.file])?;
        for (idx, (chunk, vector)) in e.chunks.iter().enumerate() {
            ins.execute(rusqlite::params![
                e.file,
                idx as i64,
                chunk.start_line as i64,
                chunk.end_line as i64,
                chunk.text,
                vec_to_blob(vector)
            ])?;
            written += 1;
        }
    }
    Ok(written)
}

/// Re-embed the given files, replacing each file's rows only once its new
/// vectors are in hand. Returns chunks written.
pub async fn index_files(app: &App, files: &[String]) -> Result<usize> {
    let mut written = 0;
    for rel in files {
        let batch = embed_files(app, std::slice::from_ref(rel)).await?;
        written += app.db.tx(|tx| store(tx, &batch))?;
    }
    Ok(written)
}

/// Full reindex (an embed-model switch invalidates old vectors): embed
/// every scene first, then swap the whole index in one transaction.
/// Returns (files, chunks).
pub async fn reindex_all(app: &App) -> Result<(usize, usize)> {
    let files = app.md_files();
    let model = crate::agents::embed_model_name(app)?;
    let batch = embed_files(app, &files).await?;
    let chunks = app.db.tx(|tx| {
        tx.execute("DELETE FROM embeddings", [])?;
        let n = store(tx, &batch)?;
        db::set_setting(tx, "embedModelUsed", &model)?;
        Ok(n)
    })?;
    Ok((batch.len(), chunks))
}

/// Incremental indexing is only safe while the configured embedding model
/// matches the one the index was built with.
pub fn index_is_current_model(app: &App) -> bool {
    match (
        app.db.get_setting("embedModelUsed"),
        crate::agents::embed_model_name(app),
    ) {
        (Ok(Some(used)), Ok(configured)) => used == configured,
        _ => false,
    }
}

/// Is there an index worth keeping fresh?
pub fn is_live(app: &App) -> bool {
    stats(app).map(|(_, chunks)| chunks > 0).unwrap_or(false) && index_is_current_model(app)
}

/// (files, chunks) in the index.
pub fn stats(app: &App) -> Result<(usize, usize)> {
    app.db.with(|conn| {
        let chunks: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?;
        let files: i64 =
            conn.query_row("SELECT COUNT(DISTINCT file) FROM embeddings", [], |r| {
                r.get(0)
            })?;
        Ok((files as usize, chunks as usize))
    })
}

pub struct Hit {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    pub score: f32,
}

/// Semantic search: embed the query, dot-product against every stored chunk
/// (vectors are normalized at write time, so dot product = cosine).
pub async fn search(app: &App, query: &str, limit: usize) -> Result<Vec<Hit>> {
    let query_vec = crate::agents::embed_texts(app, vec![query.to_string()])
        .await
        .context("embedding query")?
        .into_iter()
        .next()
        .context("provider returned no query embedding")?;
    let mut hits = app.db.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT file, start_line, end_line, text, vector FROM embeddings")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Vec<u8>>(4)?,
            ))
        })?;
        let mut hits = Vec::new();
        for row in rows {
            let (file, start, end, text, blob) = row?;
            let v = blob_to_vec(&blob);
            if v.len() != query_vec.len() {
                continue; // stale rows from a different embedding model
            }
            let score: f32 = v.iter().zip(&query_vec).map(|(a, b)| a * b).sum();
            hits.push(Hit {
                file,
                start_line: start as usize,
                end_line: end as usize,
                text,
                score,
            });
        }
        Ok(hits)
    })?;
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(limit);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunking_covers_and_overlaps() {
        let paras: Vec<String> = (0..10)
            .map(|i| format!("Paragraph {} with some words repeated here.", i))
            .collect();
        let doc = paras.join("\n\n");
        let chunks = chunk_text(&doc);
        assert!(!chunks.is_empty());
        // Every paragraph appears in at least one chunk
        for p in &paras {
            assert!(
                chunks.iter().any(|c| c.text.contains(p.as_str())),
                "missing {}",
                p
            );
        }
        // Line ranges are sane and 1-based
        assert_eq!(chunks[0].start_line, 1);
        for c in &chunks {
            assert!(c.start_line <= c.end_line);
        }
    }

    #[test]
    fn big_paragraph_gets_own_chunk() {
        let big = "word ".repeat(500);
        let doc = format!("small one\n\n{}\n\nsmall two", big);
        let chunks = chunk_text(&doc);
        assert!(chunks.iter().any(|c| c.text.contains("small one")));
        assert!(chunks.iter().any(|c| c.text.contains("small two")));
    }

    #[test]
    fn blob_roundtrip() {
        let v = vec![0.25f32, -1.5, 3.75];
        assert_eq!(blob_to_vec(&vec_to_blob(&v)), v);
    }
}
