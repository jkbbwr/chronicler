//! Background upkeep, driven by filesystem changes.
//!
//! One pipeline, two lanes:
//! - **fast lane** (runs ~300 ms after a burst of changes): drops rows for
//!   vanished paths, reindexes codex mentions, rechecks diagnostics, and
//!   captures the save into history.
//! - **slow lane** (runs after 10 s of quiet): refreshes the agent's
//!   manuscript index, runs NER discovery, and — when enabled — the LLM
//!   scan.
//!
//! Each lane processes its batches one at a time. Work is never dropped:
//! changes that arrive while a lane is busy queue up for its next batch.

use crate::app::App;
use crate::events::Event;
use crate::fsx::{self, is_matter_path, is_research_path};
use crate::{codex, diagnostics, embed};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const FAST_DEBOUNCE: Duration = Duration::from_millis(300);
const SLOW_QUIET: Duration = Duration::from_secs(10);
/// How often idle engines are checked for unloading.
const REAP_EVERY: Duration = Duration::from_secs(60);

/// Feeds changed project-relative paths into the pipeline.
pub struct Handle {
    tx: mpsc::UnboundedSender<Vec<String>>,
}

pub struct Queue {
    rx: mpsc::UnboundedReceiver<Vec<String>>,
}

pub fn channel() -> (Handle, Queue) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Handle { tx }, Queue { rx })
}

impl Handle {
    pub fn changed(&self, paths: Vec<String>) {
        if !paths.is_empty() {
            let _ = self.tx.send(paths);
        }
    }
}

/// Keeps the watcher and background tasks alive; dropping it stops them.
pub struct Background {
    _watcher: notify::RecommendedWatcher,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Background {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// Start the watcher, both lanes, engine warm-up and idle reaping.
pub fn start(app: Arc<App>, queue: Queue) -> anyhow::Result<Background> {
    let watcher = watch(&app)?;
    let (slow_tx, slow_rx) = mpsc::unbounded_channel();
    let mut tasks = vec![
        tokio::spawn(fast_lane(app.clone(), queue.rx, slow_tx)),
        tokio::spawn(slow_lane(app.clone(), slow_rx)),
    ];

    // Warm the language engine off the hot path so the first check is fast.
    {
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            let app2 = app.clone();
            match tokio::task::spawn_blocking(move || diagnostics::warm(&app2)).await {
                Ok(Ok(())) => app.emit(Event::DiagReady {}),
                Ok(Err(e)) => tracing::warn!("diagnostics warm-up failed: {e:#}"),
                Err(e) => tracing::warn!("diagnostics warm-up panicked: {e}"),
            }
        }));
    }

    {
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            let mut tick = tokio::time::interval(REAP_EVERY);
            loop {
                tick.tick().await;
                app.ner.unload_if_idle();
            }
        }));
    }
    Ok(Background {
        _watcher: watcher,
        tasks,
    })
}

/// Visible, project-relative form of a watcher path; `None` for anything
/// outside the root or under a hidden component (.chronicler, .jj, temp files).
fn visible_rel(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(n) => {
                let s = n.to_str()?;
                if s.starts_with('.') {
                    return None;
                }
                parts.push(s);
            }
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn watch(app: &Arc<App>) -> anyhow::Result<notify::RecommendedWatcher> {
    let root = app.root.clone();
    let weak = Arc::downgrade(app);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let Some(app) = weak.upgrade() else { return };
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter_map(|p| visible_rel(&root, p))
            .collect();
        app.indexer.changed(paths);
    })?;
    notify::Watcher::watch(&mut watcher, &app.root, notify::RecursiveMode::Recursive)?;
    Ok(watcher)
}

async fn fast_lane(
    app: Arc<App>,
    mut rx: mpsc::UnboundedReceiver<Vec<String>>,
    slow: mpsc::UnboundedSender<Vec<String>>,
) {
    while let Some(first) = rx.recv().await {
        let mut batch: BTreeSet<String> = first.into_iter().collect();
        let deadline = tokio::time::Instant::now() + FAST_DEBOUNCE;
        while let Ok(Some(more)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            batch.extend(more);
        }
        if batch.is_empty() {
            continue;
        }
        let paths: Vec<String> = batch.into_iter().collect();
        app.emit(Event::ProjectChanged {
            paths: paths.clone(),
        });

        let worker = app.clone();
        match tokio::task::spawn_blocking(move || fast_pass(&worker, &paths)).await {
            Ok(outcome) => {
                if !outcome.diagnostics.is_empty() {
                    app.emit(Event::DiagUpdated {
                        files: outcome.diagnostics,
                    });
                }
                if outcome.history_captured {
                    app.emit(Event::HistoryChanged {});
                }
                if !outcome.scenes.is_empty() {
                    let _ = slow.send(outcome.scenes);
                }
            }
            Err(e) => tracing::error!("indexer fast lane panicked: {e}"),
        }
    }
}

struct FastOutcome {
    diagnostics: BTreeMap<String, Vec<diagnostics::Diagnostic>>,
    history_captured: bool,
    /// Existing manuscript files for the slow lane.
    scenes: Vec<String>,
}

fn fast_pass(app: &App, paths: &[String]) -> FastOutcome {
    let mut md: BTreeSet<String> = BTreeSet::new();
    for rel in paths {
        // Research changes still reach the frontend (project/changed above)
        // and history, but nothing reads them as manuscript.
        if is_research_path(rel) {
            continue;
        }
        let abs = app.root.join(rel);
        if abs.exists() {
            // A folder moved in brings files the watcher may not list.
            md.extend(fsx::md_files_under(&app.root, rel));
        } else if let Err(e) = app.db.tx(|tx| crate::db::delete_path_rows(tx, rel)) {
            tracing::warn!("cleaning up rows for {rel}: {e:#}");
        }
    }
    let md: Vec<String> = md.into_iter().collect();

    let mut diagnostics = BTreeMap::new();
    if !md.is_empty() {
        if let Err(e) = codex::reindex_mentions(app, Some(&md)) {
            tracing::warn!("mention reindex failed: {e:#}");
        }
        match diagnostics::check_files(app, &md) {
            Ok(d) => diagnostics = d,
            Err(e) => tracing::warn!("diagnostics failed: {e:#}"),
        }
    }

    let history_captured = match app.history.capture() {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("history capture failed: {e:#}");
            false
        }
    };
    FastOutcome {
        diagnostics,
        history_captured,
        scenes: md,
    }
}

async fn slow_lane(app: Arc<App>, mut rx: mpsc::UnboundedReceiver<Vec<String>>) {
    let mut pending: BTreeSet<String> = BTreeSet::new();
    loop {
        if pending.is_empty() {
            match rx.recv().await {
                Some(batch) => pending.extend(batch),
                None => return,
            }
        }
        // Wait for a quiet period; every new batch restarts it.
        while let Ok(Some(batch)) = tokio::time::timeout(SLOW_QUIET, rx.recv()).await {
            pending.extend(batch);
        }
        let files: Vec<String> = std::mem::take(&mut pending).into_iter().collect();
        slow_pass(&app, files).await;
    }
}

async fn slow_pass(app: &Arc<App>, files: Vec<String>) {
    let files: Vec<String> = files
        .into_iter()
        .filter(|f| !is_matter_path(f) && !is_research_path(f) && app.root.join(f).is_file())
        .collect();
    if files.is_empty() {
        return;
    }

    // Passage search maintains itself: refresh the changed scenes, or build
    // the whole index the first time (or after the search model changed).
    if embed::is_live(app) {
        match embed::index_files(app, &files).await {
            Ok(n) => tracing::info!("passage search refreshed: {n} passages"),
            Err(e) => tracing::warn!("passage search refresh failed: {e:#}"),
        }
    } else if crate::ai::usable(app)
        && let Ok(_run) = app.runs.try_register("index")
    {
        match embed::reindex_all(app).await {
            Ok((f, c)) => tracing::info!("passage search built: {c} passages across {f} scenes"),
            Err(e) => tracing::warn!("building passage search failed: {e:#}"),
        }
    }

    // Facts, and (when the writer turned it on) continuity, for what changed.
    crate::agents::on_scenes_saved(app, &files).await;

    let worker = app.clone();
    let ner_files = files.clone();
    let found = tokio::task::spawn_blocking(move || codex::discover_files(&worker, &ner_files))
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("NER discovery panicked: {e}")));
    match found {
        Ok(n) if n > 0 => {
            // NER surfaced something new: optionally follow up with the
            // costlier LLM pass on the same files.
            let mut total = n;
            if crate::ai::auto_scan_ready(app) {
                for rel in &files {
                    match crate::ai::scan_file(app, rel).await {
                        Ok(r) => total += r.new_candidates,
                        Err(e) => tracing::warn!("auto LLM scan failed for {rel}: {e:#}"),
                    }
                }
            }
            app.emit(Event::CodexChanged {
                new_candidates: total,
            });
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("NER discovery failed: {e:#}"),
    }
}
