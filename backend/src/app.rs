//! The one piece of process state: everything a handler, the indexer or an
//! agent needs, owned by an `Arc<App>`.

use crate::events::Event;
use crate::fsx::{self, RelPath, WriteLocks};
use crate::{agents, ai, db::Db, diagnostics, history, indexer, ner};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The single stdout channel: responses and notifications, one JSON value
/// per line, written by a dedicated thread in submission order.
#[derive(Clone)]
pub struct Output {
    tx: Option<std::sync::mpsc::Sender<OutLine>>,
}

pub enum OutLine {
    Line(String),
    Close,
}

impl Output {
    pub fn channel() -> (Output, std::sync::mpsc::Receiver<OutLine>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (Output { tx: Some(tx) }, rx)
    }

    /// Drops everything; for tests that don't care about notifications.
    pub fn discard() -> Output {
        Output { tx: None }
    }

    pub fn send(&self, line: String) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(OutLine::Line(line));
        }
    }

    pub fn close(&self) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(OutLine::Close);
        }
    }
}

pub struct App {
    /// Canonical project root.
    pub root: PathBuf,
    pub db: Db,
    pub out: Output,
    pub ai: ai::AiState,
    pub tts: crate::tts::TtsState,
    pub runs: agents::Runs,
    pub writes: WriteLocks,
    pub lang: diagnostics::Lang,
    pub ner: ner::Ner,
    pub history: history::Repo,
    pub indexer: indexer::Handle,
}

impl App {
    /// Open a project: database (migrated), empty engine slots, and the
    /// indexer queue, whose receiving end the caller hands to
    /// [`indexer::spawn`] once it wants background work to start.
    pub fn open(root: &Path, out: Output) -> Result<(Arc<App>, indexer::Queue)> {
        let root = root.canonicalize().context("resolving project root")?;
        let db = Db::open(&root)?;
        let (indexer, queue) = indexer::channel();
        let app = App {
            history: history::Repo::new(&root),
            root,
            db,
            out,
            ai: ai::AiState::default(),
            tts: crate::tts::TtsState::default(),
            runs: agents::Runs::default(),
            writes: WriteLocks::default(),
            lang: diagnostics::Lang::default(),
            ner: ner::Ner::default(),
            indexer,
        };
        Ok((Arc::new(app), queue))
    }

    pub fn emit(&self, event: Event) {
        self.out.send(event.to_line());
    }

    /// Absolute path for a client-supplied relative path.
    pub fn path(&self, rel: &str) -> Result<(RelPath, PathBuf)> {
        let rel = RelPath::parse(rel)?;
        let abs = rel.to_path(&self.root);
        Ok((rel, abs))
    }

    pub fn read(&self, rel: &RelPath) -> Result<String> {
        fsx::read_text(&self.root, rel)
    }

    pub fn write(&self, rel: &RelPath, content: &str) -> Result<()> {
        fsx::atomic_write(&self.writes, &rel.to_path(&self.root), content)
            .with_context(|| format!("writing {rel}"))
    }

    /// Run synchronous work (file walks, db batches, engines) from async
    /// code without stalling the runtime's workers.
    pub async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&App) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let app = self.clone();
        match tokio::task::spawn_blocking(move || f(&app)).await {
            Ok(r) => r,
            Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
            Err(e) => Err(anyhow::anyhow!("background task cancelled: {e}")),
        }
    }

    pub fn md_files(&self) -> Vec<String> {
        fsx::list_md_files(&self.root)
    }
}
