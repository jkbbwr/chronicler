import { createEffect, createRoot, on } from "solid-js";
import { invoke } from "../lib/rpc";
import { project } from "./app";
import { workbench, setWorkbench, DEFAULT_LAYOUT, type Mode, type PlanView, type ReviewSection, type Layout } from "./workbench";
import { docs, ensureLoaded, getContent, recent, reference, scene, setRecent, setReference, openScene } from "./documents";

// Per-project session: where you were (mode, scene, layout), kept in the
// browser's storage, and a journal of unsaved edits, kept by the backend in
// the project (so it survives crashes and isn't capped like localStorage).

interface SessionData {
  mode: Mode;
  scene: string | null;
  recent: string[];
  reference: string | null;
  planView: PlanView;
  reviewSection: ReviewSection;
  layout: Layout;
}

const sessionKey = (root: string) => `chronicler-session:v2:${root}`;

const read = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode: best-effort
  }
};

export async function restoreSession(root: string) {
  const s = read<SessionData>(sessionKey(root));
  // Unsaved work first: every journaled doc reopens dirty with its text.
  try {
    const { entries } = await invoke("journal/read");
    for (const e of entries) {
      await ensureLoaded(e.path, e.content);
      journaled.add(e.path);
    }
  } catch {
    // backend restarting; nothing to restore
  }
  if (!s) return;
  setWorkbench({
    mode: s.mode ?? "write",
    planView: s.planView ?? "cards",
    reviewSection: s.reviewSection ?? "problems",
    layout: { ...DEFAULT_LAYOUT, ...s.layout },
  });
  setRecent((s.recent ?? []).slice(0, 30));
  if (s.scene) await openScene(s.scene);
  if (s.reference && (await ensureLoaded(s.reference))) setReference(s.reference);
}

let sessionTimer: ReturnType<typeof setTimeout> | undefined;
let journalTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSession: (() => void) | null = null;

/** Paths the backend journal currently holds. */
const journaled = new Set<string>();

function writeJournal(root: string) {
  if (root !== project.root) return;
  const dirty = Object.values(docs).filter((d) => d.dirty && !d.loading);
  const dirtyPaths = new Set(dirty.map((d) => d.path));
  for (const d of dirty) {
    journaled.add(d.path);
    void invoke("journal/write", { path: d.path, content: getContent(d.path) }).catch(() => {});
  }
  for (const path of [...journaled]) {
    if (dirtyPaths.has(path)) continue;
    journaled.delete(path);
    void invoke("journal/clear", { path }).catch(() => {});
  }
}

/** Forget the journal bookkeeping (project closed). */
export function resetJournal() {
  journaled.clear();
}

/** Write any debounced session/journal state now (before switching projects or quitting). */
export function flushSession() {
  clearTimeout(sessionTimer);
  clearTimeout(journalTimer);
  pendingSession?.();
  pendingSession = null;
  // Always from the live text: the last keystrokes may not be mirrored yet.
  if (project.root) writeJournal(project.root);
}

createRoot(() => {
  createEffect(() => {
    const root = project.root;
    if (!root) return;
    const data: SessionData = {
      mode: workbench.mode,
      scene: scene(),
      recent: recent(),
      reference: reference(),
      planView: workbench.planView,
      reviewSection: workbench.reviewSection,
      layout: { ...workbench.layout },
    };
    clearTimeout(sessionTimer);
    pendingSession = () => write(sessionKey(root), data);
    sessionTimer = setTimeout(() => { pendingSession?.(); pendingSession = null; }, 400);
  });

  // Journal: re-derived when any doc's dirty flag or mirrored text changes.
  createEffect(on(
    () => Object.values(docs).map((d) => `${d.path}:${d.dirty}:${d.content.length}`).join("|"),
    () => {
      const root = project.root;
      if (!root) return;
      clearTimeout(journalTimer);
      journalTimer = setTimeout(() => writeJournal(root), 800);
    },
  ));
});

window.addEventListener("beforeunload", flushSession);
