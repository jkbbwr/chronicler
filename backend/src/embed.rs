use crate::db;
use anyhow::{Context, Result};
use std::path::Path;

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
            text: group.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n\n"),
        });
        if end_para >= paras.len() {
            break;
        }
        // Overlap: step back one paragraph unless that would stall
        i = if end_para - start_para > 1 { end_para - 1 } else { end_para };
    }
    chunks
}

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// (Re)index the given files: delete their rows, chunk, embed via the
/// provider, insert. Returns the number of chunks written.
pub async fn index_files(root: &Path, files: &[String]) -> Result<usize> {
    let mut written = 0usize;
    for rel in files {
        if crate::is_matter_path(rel) {
            continue;
        }
        {
            let conn = db::open(root)?;
            conn.execute("DELETE FROM embeddings WHERE file = ?1", [rel.as_str()])?;
        }
        let path = match crate::resolve_path(root, rel) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue, // deleted since listing — rows already cleared
        };
        let chunks = chunk_text(&content);
        if chunks.is_empty() {
            continue;
        }
        let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
        let vectors = crate::agents::embed_texts(root, texts)
            .await
            .with_context(|| format!("embedding {}", rel))?;
        let conn = db::open(root)?;
        for (idx, (chunk, vector)) in chunks.iter().zip(vectors.iter()).enumerate() {
            conn.execute(
                "INSERT INTO embeddings (file, chunk, start_line, end_line, text, vector)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    rel,
                    idx as i64,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.text,
                    vec_to_blob(vector)
                ],
            )?;
            written += 1;
        }
    }
    Ok(written)
}

/// Full reindex: wipe everything (an embed-model switch invalidates old
/// vectors), then index every scene. Returns (files, chunks).
pub async fn reindex_all(root: &Path) -> Result<(usize, usize)> {
    let files = crate::list_md_files(root);
    {
        let conn = db::open(root)?;
        conn.execute("DELETE FROM embeddings", [])?;
    }
    let chunks = index_files(root, &files).await?;
    db::set_setting(root, "embedModelUsed", &crate::agents::embed_model_name(root)?)?;
    Ok((files.len(), chunks))
}

/// Incremental indexing is only safe while the configured embedding model
/// matches the one the index was built with.
pub fn index_is_current_model(root: &Path) -> bool {
    match (db::get_setting(root, "embedModelUsed"), crate::agents::embed_model_name(root)) {
        (Ok(Some(used)), Ok(configured)) => used == configured,
        _ => false,
    }
}

pub fn stats(root: &Path) -> Result<(usize, usize)> {
    let conn = db::open(root)?;
    let chunks: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?;
    let files: i64 =
        conn.query_row("SELECT COUNT(DISTINCT file) FROM embeddings", [], |r| r.get(0))?;
    Ok((files as usize, chunks as usize))
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
pub async fn search(root: &Path, query: &str, limit: usize) -> Result<Vec<Hit>> {
    let query_vec = crate::agents::embed_texts(root, vec![query.to_string()])
        .await
        .context("embedding query")?
        .into_iter()
        .next()
        .context("provider returned no query embedding")?;
    let conn = db::open(root)?;
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
    let mut hits: Vec<Hit> = Vec::new();
    for row in rows {
        let (file, start, end, text, blob) = row?;
        let v = blob_to_vec(&blob);
        if v.len() != query_vec.len() {
            continue; // stale rows from a different embedding model
        }
        let score: f32 = v.iter().zip(&query_vec).map(|(a, b)| a * b).sum();
        hits.push(Hit { file, start_line: start as usize, end_line: end as usize, text, score });
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunking_covers_and_overlaps() {
        let paras: Vec<String> =
            (0..10).map(|i| format!("Paragraph {} with some words repeated here.", i)).collect();
        let doc = paras.join("\n\n");
        let chunks = chunk_text(&doc);
        assert!(!chunks.is_empty());
        // Every paragraph appears in at least one chunk
        for p in &paras {
            assert!(chunks.iter().any(|c| c.text.contains(p.as_str())), "missing {}", p);
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
