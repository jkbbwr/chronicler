import { invalidate, invoke } from "./rpc";
import { notify, notifyError } from "../stores/app";
import { createScene, docs, flush, forget, openScene, replaceContent, retarget, scene, sceneName, viewFor } from "../stores/documents";

// Manuscript file operations. Pending edits are saved before anything moves,
// and open documents follow renames.

export async function newScene(relPath: string) {
  const title = sceneName(relPath);
  await createScene(relPath, title);
}

export async function newFolder(relPath: string) {
  try {
    await invoke("project/create_folder", { path: relPath });
    invalidate("files");
  } catch (err) {
    notifyError("Couldn't create the folder", err);
  }
}

export async function renamePath(oldPath: string, newPath: string) {
  if (oldPath === newPath) return;
  if (!(await flush(oldPath))) return; // don't move a file with unsaved, unsaveable edits
  try {
    await invoke("project/rename", { from: oldPath, to: newPath });
    retarget(oldPath, newPath);
    invalidate("files", "meta", "codex", "diags");
  } catch (err) {
    notifyError("Couldn't rename", err);
  }
}

export async function deletePath(path: string) {
  const isFolder = !path.endsWith(".md");
  const r = await window.chronicler.showMessageBox({
    type: "warning",
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Delete “${isFolder ? path : sceneName(path)}”?`,
    detail: isFolder
      ? "The folder and every scene in it go to the Trash. Their text also stays in History."
      : "The scene goes to the Trash. Its text also stays in History.",
  });
  if (r.response !== 0) return;
  try {
    await invoke("project/delete", { path });
    forget(path);
    invalidate("files", "meta", "codex", "diags");
  } catch (err) {
    notifyError("Couldn't delete", err);
  }
}

/** Put a file's text on disk into its open editor, quietly (we wrote it). */
async function reload(path: string) {
  if (!docs[path]) return;
  const disk = (await invoke("document/read", { path })).content;
  replaceContent(path, disk);
}

/** Split the current scene at the cursor: everything after it becomes a new
 * scene right after this one, with the same point of view, place and threads. */
export async function splitSceneAtCursor() {
  const path = scene();
  const view = viewFor(path);
  if (!path || !view) {
    notify("Put the cursor in a scene where the new scene should begin");
    return;
  }
  if (!(await flush(path))) return;
  const text = view.state.doc.toString();
  const at = view.state.selection.main.head;
  try {
    const created = (await invoke("scene/split", { path, before: text.slice(0, at), after: text.slice(at) })).path;
    await reload(path);
    invalidate("files", "meta", "codex", "diags");
    await openScene(created, { line: 1 });
    notify(`Split off “${sceneName(created)}” — rename it in the binder`, "success");
  } catch (err) {
    notifyError("Couldn't split the scene", err);
  }
}

/** Fold the next scene in the chapter onto the end of `path`. */
export async function mergeWithNext(path: string) {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
  if (!(await flush(folder))) return;
  try {
    const { merged } = await invoke("scene/merge", { path });
    const wasOpen = scene() === merged;
    forget(merged);
    await reload(path);
    invalidate("files", "meta", "codex", "diags");
    if (wasOpen) await openScene(path);
    notify(`Merged “${sceneName(merged)}” into “${sceneName(path)}”`, "success");
  } catch (err) {
    notifyError("Couldn't merge the scenes", err);
  }
}

export async function revealInFileManager(relPath: string) {
  const res = await window.chronicler.revealInFileManager(relPath);
  if (res?.error) notifyError("Couldn't reveal", res.error);
}
