import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Annotation, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke, invalidate } from "../lib/rpc";
import { notify, notifyError } from "./app";

// Open documents. CodeMirror owns the text: each open scene has one
// EditorState, parked here while no editor shows it and swapped into the
// visible editor on demand (so undo history survives switching scenes, and
// only visible scenes cost a DOM editor). The store mirrors content on a
// debounce for word counts and the inspector.
//
// Saving is race-free by construction: `saved` remembers what's on disk, a
// save only clears `dirty` if nothing was typed meanwhile, and file-watcher
// echoes are recognised by comparing against `saved`, never the live buffer.

export interface DocInfo {
  path: string;
  loading: boolean;
  dirty: boolean;
  /** Debounced mirror of the text, for counts and summaries. Not for saving. */
  content: string;
}

/** Where to put the cursor. `focus: false` selects without stealing keyboard focus. */
export type Reveal = { line: number; colStart?: number; colEnd?: number; focus?: boolean };

/** Marks programmatic replacements so the edit listener doesn't mark them dirty. */
export const External = Annotation.define<boolean>();

const [docs, setDocs] = createStore<Record<string, DocInfo>>({});
export { docs };

const parked = new Map<string, EditorState>();
const views = new Map<string, EditorView>();
const saved = new Map<string, string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const mirrorTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingReveal = new Map<string, Reveal>();

const AUTOSAVE_MS = 1500;
const MIRROR_MS = 300;

/** Builds an EditorState for a document; provided by the editor setup module. */
let makeState: (path: string, text: string) => EditorState = () => {
  throw new Error("editor state factory not registered");
};
export const registerStateFactory = (f: typeof makeState) => (makeState = f);

// ---- Current scene & recents ----

/** The scene Write (and Review) show. */
export const [scene, setSceneRaw] = createSignal<string | null>(null);
/** Most-recently-used scenes, newest first. */
export const [recent, setRecent] = createSignal<string[]>([]);
/** Read-only reference pane beside the Write page. */
export const [reference, setReference] = createSignal<string | null>(null);

const touchRecent = (path: string) => setRecent((r) => [path, ...r.filter((p) => p !== path)].slice(0, 30));

export const sceneName = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
export const chapterOf = (path: string) => path.split("/").slice(0, -1).join(" › ");

// ---- Loading ----

/**
 * Load a document if it isn't open. `journal` is unsaved content from a
 * previous session: if it differs from disk, the doc opens dirty with it.
 */
export async function ensureLoaded(path: string, journal?: string): Promise<boolean> {
  if (docs[path]) return true;
  setDocs(path, { path, loading: true, dirty: false, content: "" });
  let disk: string | null = null;
  try {
    disk = (await invoke("document/read", { path: path })).content;
  } catch (err) {
    if (journal === undefined) {
      setDocs(produce((d) => { delete d[path]; }));
      notifyError(`Couldn't open ${sceneName(path)}`, err);
      return false;
    }
    // Gone from disk but the journal has unsaved work: keep it recoverable.
  }
  if (!docs[path]) return false; // closed while loading
  const text = journal ?? disk ?? "";
  if (disk !== null) saved.set(path, disk);
  parked.set(path, makeState(path, text));
  setDocs(path, { loading: false, content: text, dirty: disk === null || text !== disk });
  return true;
}

export async function openScene(path: string, reveal?: Reveal) {
  if (!(await ensureLoaded(path))) return false;
  setSceneRaw(path);
  touchRecent(path);
  if (reveal) requestReveal(path, reveal);
  return true;
}

export const isOpen = (path: string) => !!docs[path];

// ---- Text access ----

export function getContent(path: string): string {
  const v = views.get(path);
  if (v) return v.state.doc.toString();
  const s = parked.get(path);
  if (s) return s.doc.toString();
  return docs[path]?.content ?? "";
}

/** The mounted editor showing `path`, if any. */
export const viewFor = (path: string | null) => (path ? views.get(path) : undefined);

// ---- Editor mount protocol ----

/** An editor takes over `path`: returns the state to show (and consumes any pending reveal). */
export function attach(path: string, view: EditorView): EditorState {
  const other = views.get(path);
  if (other && other !== view) parked.set(path, other.state);
  const state = parked.get(path) ?? makeState(path, docs[path]?.content ?? "");
  parked.delete(path);
  views.set(path, view);
  return state;
}

/** An editor lets go of `path`, parking its state for next time. */
export function detach(path: string, view: EditorView) {
  if (views.get(path) !== view) return;
  parked.set(path, view.state);
  views.delete(path);
}

export function takeReveal(path: string): Reveal | undefined {
  const r = pendingReveal.get(path);
  pendingReveal.delete(path);
  return r;
}

export function applyReveal(view: EditorView, r: Reveal) {
  const doc = view.state.doc;
  const line = doc.line(Math.max(1, Math.min(r.line, doc.lines)));
  const from = Math.min(line.from + (r.colStart ?? 0), line.to);
  const to = r.colEnd !== undefined ? Math.min(line.from + r.colEnd, line.to) : from;
  view.dispatch({
    selection: { anchor: from, head: Math.max(from, to) },
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
  if (r.focus !== false) view.focus();
}

export function requestReveal(path: string, r: Reveal) {
  const v = views.get(path);
  if (v) applyReveal(v, r);
  else pendingReveal.set(path, r);
}

// ---- Edits & saving ----

/** Called by the editor's update listener for user edits. */
export function edited(path: string) {
  if (!docs[path]) return;
  if (!docs[path].dirty) setDocs(path, "dirty", true);
  clearTimeout(mirrorTimers.get(path));
  mirrorTimers.set(path, setTimeout(() => {
    mirrorTimers.delete(path);
    if (docs[path]) setDocs(path, "content", getContent(path));
  }, MIRROR_MS));
  clearTimeout(saveTimers.get(path));
  saveTimers.set(path, setTimeout(() => {
    saveTimers.delete(path);
    void save(path);
  }, AUTOSAVE_MS));
}

const inFlight = new Map<string, Promise<boolean>>();

export async function save(path: string): Promise<boolean> {
  clearTimeout(saveTimers.get(path));
  saveTimers.delete(path);
  if (!docs[path]) return true;
  // Serialize saves per file: the later one always carries the newer text.
  const prior = inFlight.get(path);
  if (prior) await prior;
  const content = getContent(path);
  if (content === saved.get(path)) {
    if (docs[path]) setDocs(path, "dirty", false);
    return true;
  }
  const run = (async () => {
    try {
      await invoke("document/save", { path: path, content });
    } catch (err) {
      notifyError(`Couldn't save ${sceneName(path)}`, err);
      return false;
    }
    saved.set(path, content);
    // Only clean if nothing was typed while the save was in flight.
    if (docs[path]) setDocs(path, { dirty: getContent(path) !== content, content: getContent(path) });
    return true;
  })();
  inFlight.set(path, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(path) === run) inFlight.delete(path);
  }
}

/** Save every dirty doc (optionally only those at or under `prefix`). */
export async function flush(prefix?: string): Promise<boolean> {
  const targets = Object.values(docs).filter(
    (d) => d.dirty && (!prefix || d.path === prefix || d.path.startsWith(prefix + "/")),
  );
  const results = await Promise.all(targets.map((d) => save(d.path)));
  return results.every(Boolean);
}

export const dirtyDocs = () => Object.values(docs).filter((d) => d.dirty);

/** Replace a document's text wholesale (external reload), leaving it clean. */
export function replaceContent(path: string, text: string) {
  const v = views.get(path);
  if (v) {
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, annotations: External.of(true) });
  } else {
    const s = parked.get(path);
    if (s) parked.set(path, s.update({ changes: { from: 0, to: s.doc.length, insert: text }, annotations: External.of(true) }).state);
  }
  saved.set(path, text);
  if (docs[path]) setDocs(path, { content: text, dirty: false });
}

/**
 * Replace a span on a 1-based line if it still holds `expected`, as a user
 * edit (dirty, undoable). Returns null if the doc isn't open, false if stale.
 */
export function replaceRange(path: string, line: number, colStart: number, colEnd: number, expected: string, replacement: string): boolean | null {
  const v = views.get(path);
  const state = v?.state ?? parked.get(path);
  if (!state) return null;
  if (line < 1 || line > state.doc.lines) return false;
  const l = state.doc.line(line);
  const from = l.from + colStart;
  const to = l.from + colEnd;
  if (to > l.to || state.sliceDoc(from, to) !== expected) return false;
  if (v) v.dispatch({ changes: { from, to, insert: replacement } });
  else {
    parked.set(path, state.update({ changes: { from, to, insert: replacement } }).state);
    edited(path);
  }
  return true;
}

// ---- Outside changes ----

/** Reconcile open docs with files that changed on disk. */
export async function reconcileExternal(paths: string[]) {
  for (const path of paths) {
    const doc = docs[path];
    if (!doc || doc.loading) continue;
    // Our own save may still be in flight; its echo must not look foreign.
    await inFlight.get(path);
    let disk: string;
    try {
      disk = (await invoke("document/read", { path: path })).content;
    } catch {
      continue; // deleted or unreadable: keep the buffer so nothing is lost
    }
    if (!docs[path]) continue;
    if (disk === saved.get(path)) continue; // our own save echoing back
    const current = getContent(path);
    if (disk === current) {
      saved.set(path, disk);
      setDocs(path, "dirty", false);
      continue;
    }
    if (!docs[path].dirty) {
      replaceContent(path, disk);
      notify(`${sceneName(path)} changed on disk — reloaded`);
      continue;
    }
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Keep My Version", "Use the Version on Disk"],
      defaultId: 0,
      cancelId: 0,
      message: `“${sceneName(path)}” changed on disk`,
      detail: "You have unsaved edits in this scene. Using the version on disk discards them (they stay in History if they were saved earlier).",
    });
    if (r.response === 1) replaceContent(path, disk);
    else saved.set(path, disk); // our next save deliberately overwrites it
  }
}

// ---- Rename / close ----

/** Move open docs after a rename (a file, or a folder and everything under it). */
export function retarget(oldPath: string, newPath: string) {
  const map = (p: string) =>
    p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
  const moved = Object.keys(docs).filter((p) => map(p) !== p);
  for (const from of moved) {
    const to = map(from);
    for (const m of [parked, views, saved] as Map<string, unknown>[]) {
      if (m.has(from)) {
        m.set(to, m.get(from));
        m.delete(from);
      }
    }
  }
  setDocs(produce((d) => {
    for (const from of moved) {
      d[map(from)] = { ...d[from], path: map(from) };
      delete d[from];
    }
  }));
  setRecent((r) => r.map(map));
  if (scene()) setSceneRaw(map(scene()!));
  if (reference()) setReference(map(reference()!));
}

/** Forget docs at or under `prefix` (after a delete). Unsaved edits are dropped. */
export function forget(prefix: string) {
  const hit = (p: string) => p === prefix || p.startsWith(prefix + "/");
  for (const p of Object.keys(docs).filter(hit)) {
    clearTimeout(saveTimers.get(p));
    clearTimeout(mirrorTimers.get(p));
    parked.delete(p);
    saved.delete(p);
  }
  setDocs(produce((d) => { for (const p of Object.keys(d)) if (hit(p)) delete d[p]; }));
  setRecent((r) => r.filter((p) => !hit(p)));
  if (scene() && hit(scene()!)) setSceneRaw(recent()[0] ?? null);
  if (reference() && hit(reference()!)) setReference(null);
}

/** Drop everything (project closed). */
export function resetDocuments() {
  for (const t of [...saveTimers.values(), ...mirrorTimers.values()]) clearTimeout(t);
  saveTimers.clear();
  mirrorTimers.clear();
  parked.clear();
  saved.clear();
  pendingReveal.clear();
  setDocs(produce((d) => { for (const p of Object.keys(d)) delete d[p]; }));
  setSceneRaw(null);
  setRecent([]);
  setReference(null);
}

// ---- Creating ----

export async function createScene(path: string, title: string) {
  const file = path.endsWith(".md") ? path : `${path}.md`;
  try {
    await invoke("document/save", { path: file, content: `# ${title}\n\n` });
  } catch (err) {
    notifyError("Couldn't create the scene", err);
    return;
  }
  invalidate("files");
  await openScene(file, { line: 3 });
}

// ---- Counting ----

/** Words in prose, skipping fenced code and HTML comments (annotations). */
export function countWords(text: string): number {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/<!--[\s\S]*?(-->|$)/g, " ");
  const m = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}
