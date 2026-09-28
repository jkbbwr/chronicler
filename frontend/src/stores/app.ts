import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { loadProjectMeta, projectDisplayName, type ProjectMeta } from "../lib/project";
import type { SettingsSection } from "../components/settings/SettingsSheet";

// Project lifecycle, notifications and overlays: app-level state that isn't
// a document, a finding or a layout.

// ---- Notifications ----

export type NoticeKind = "info" | "success" | "error" | "progress";

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
  time: string;
}

const [notice, setNotice] = createSignal<Notice | null>(null);
const [log, setLog] = createSignal<Notice[]>([]);
let noticeId = 0;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export { notice, log };

/**
 * Show a message in the footer (and keep it in the activity log). Progress
 * notices stay until replaced; others fade after a few seconds.
 */
export function notify(message: string, kind: NoticeKind = "info") {
  const n: Notice = { id: ++noticeId, message, kind, time: new Date().toLocaleTimeString() };
  setNotice(n);
  if (kind !== "progress") setLog((prev) => [...prev.slice(-199), n]);
  clearTimeout(clearTimer);
  if (kind !== "progress") {
    clearTimer = setTimeout(() => setNotice((cur) => (cur?.id === n.id ? null : cur)), kind === "error" ? 9000 : 4000);
  }
}

export const notifyError = (prefix: string, err: unknown) =>
  notify(`${prefix}: ${err instanceof Error ? err.message : String(err)}`, "error");

/** Run an async task with a progress notice, reporting failure. Returns undefined on error. */
export async function withProgress<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
  notify(label, "progress");
  try {
    return await task();
  } catch (err) {
    notifyError(label.replace(/\.\.\.$|…$/, "") + " failed", err);
    return undefined;
  } finally {
    setNotice((cur) => (cur?.kind === "progress" && cur.message === label ? null : cur));
  }
}

// ---- Project ----

export interface Recent { path: string; openedAt: string }

export const [project, setProject] = createStore<{
  root: string | null;
  meta: ProjectMeta | null;
  /** Non-null while the welcome screen shows (no project open). */
  recents: Recent[] | null;
}>({ root: null, meta: null, recents: null });

export const projectName = () => projectDisplayName(project.meta, project.root);

export async function loadProject(): Promise<boolean> {
  const p = await window.chronicler.getProject();
  if (!p.path) {
    setProject({ root: null, meta: null, recents: p.recents });
    return false;
  }
  const info = await window.chronicler.invoke("system/info");
  const meta = await loadProjectMeta();
  setProject({ root: info.root ?? null, meta, recents: null });
  return true;
}

export function resetProject() {
  setProject({ root: null, meta: null, recents: null });
}

// ---- Overlays ----

export const [overlays, setOverlays] = createStore({
  palette: null as null | { initial: string },
  settings: false as false | SettingsSection,
  stats: false,
  critique: false,
  newProject: false,
});

export const openPalette = (initial = "") => setOverlays("palette", { initial });
export const closeOverlays = () =>
  setOverlays({ palette: null, settings: false, stats: false, critique: false, newProject: false });
