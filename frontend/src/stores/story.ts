import { createMemo, createRoot } from "solid-js";
import { createQuery, invalidate, invoke } from "../lib/rpc";
import { notifyError } from "./app";
import { buildCompileChapters, buildTree, ORDER_FILE, type CompileChapter, type OrderMap } from "../lib/binderTree";
import type { SceneDetails, Thread } from "../rpc.gen";

// The book's structure: chapters and scenes in binder order, each scene's
// details (status, synopsis, point of view, location, story time, word
// target, plot threads), and the plot threads themselves. Shared by the
// inspector, the index cards and the thread grid.

export type { SceneDetails, Thread };

const data = createRoot(() => {
  const outline = createQuery(["files"], async () => {
    try {
      const res = await invoke("project/list_files");
      let order: OrderMap = {};
      try {
        order = JSON.parse((await invoke("document/read", { path: ORDER_FILE })).content);
      } catch {
        // no manual order yet
      }
      return buildCompileChapters(buildTree(res.files, order));
    } catch {
      return [] as CompileChapter[];
    }
  });

  const details = createQuery(["meta", "files"], async () => {
    try {
      return (await invoke("meta/get_all")).meta;
    } catch {
      return [] as SceneDetails[];
    }
  });

  const threads = createQuery(["meta"], async () => {
    try {
      return (await invoke("threads/list")).threads;
    } catch {
      return [] as Thread[];
    }
  });

  const byFile = createMemo(() => new Map((details.latest ?? []).map((d) => [d.file, d])));
  /** Every scene in reading order. */
  const sceneOrder = createMemo(() => (outline.latest ?? []).flatMap((c) => c.scenes));

  return { outline, details, threads, byFile, sceneOrder };
});

export const outline = data.outline;
export const sceneOrder = data.sceneOrder;
export const threads = data.threads;

const EMPTY: Omit<SceneDetails, "file"> = {
  synopsis: "", status: "", pov: null, location: null, storyTime: "", target: 0, threads: [],
};

/** A scene's details (defaults when none are set). */
export const detailsFor = (path: string | null): SceneDetails =>
  (path && data.byFile().get(path)) || { file: path ?? "", ...EMPTY };

export type DetailsPatch = Partial<Omit<SceneDetails, "file" | "pov" | "location">> & {
  /** 0 clears. */
  pov?: number;
  /** 0 clears. */
  location?: number;
};

export async function setDetails(path: string, patch: DetailsPatch) {
  try {
    await invoke("meta/set", { path, ...patch });
    invalidate("meta");
  } catch (err) {
    notifyError("Couldn't save the scene details", err);
  }
}

export async function createThread(name: string): Promise<number | undefined> {
  try {
    const { id } = await invoke("threads/create", { name });
    invalidate("meta");
    return id;
  } catch (err) {
    notifyError("Couldn't add the thread", err);
    return undefined;
  }
}

export async function updateThread(id: number, patch: { name?: string; color?: string; position?: number }) {
  try {
    await invoke("threads/update", { id, ...patch });
    invalidate("meta");
  } catch (err) {
    notifyError("Couldn't change the thread", err);
  }
}

export async function deleteThread(id: number) {
  try {
    await invoke("threads/delete", { id });
    invalidate("meta");
  } catch (err) {
    notifyError("Couldn't delete the thread", err);
  }
}

/** Add or remove a thread on a scene. */
export function toggleThread(path: string, id: number) {
  const current = detailsFor(path).threads;
  const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
  return setDetails(path, { threads: next });
}

/** Thread colours: semantic tokens, cycled for new threads. */
export const THREAD_COLORS = ["accent", "ai", "success", "warning", "danger", "status-revised", "status-idea", "entity"];
export const threadColor = (t: Thread, index: number) => `var(--${t.color || THREAD_COLORS[index % THREAD_COLORS.length]})`;
