import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/** Subscribe to a main → renderer channel; returns the unsubscribe function. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("chronicler", {
  /** JSON-RPC call into the backend; see `src/rpc.gen.ts` for every method. */
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke("rpc-invoke", method, params),
  showMessageBox: (options: unknown) => ipcRenderer.invoke("show-message-box", options),
  getProject: () => ipcRenderer.invoke("get-project"),
  openProject: (path?: string) => ipcRenderer.invoke("open-project", path),
  defaultProjectParent: () => ipcRenderer.invoke("default-project-parent"),
  chooseProjectParent: () => ipcRenderer.invoke("choose-project-parent"),
  createProjectIn: (parent: string, opts: unknown) => ipcRenderer.invoke("create-project-in", parent, opts),
  revealInFileManager: (relPath?: string) => ipcRenderer.invoke("reveal-in-file-manager", relPath),
  /** Pick files in a dialog and copy them into Research/; resolves `{ paths, errors }`. */
  researchImport: () => ipcRenderer.invoke("research-import"),
  closeProject: () => ipcRenderer.invoke("close-project"),
  platform: process.platform,
  removeRecent: (path: string) => ipcRenderer.invoke("remove-recent", path),
  /**
   * Copy a compiled artifact (the `output` of `compile/run`) out of the
   * project. Main shows the save dialog; resolves `{ canceled }` or
   * `{ canceled: false, path }`.
   */
  exportCompiled: (source: string, options?: { defaultName?: string }) =>
    ipcRenderer.invoke("export-compiled", source, options),
  aiStoreKey: (key: string) => ipcRenderer.invoke("ai-store-key", key),
  /** Backend notifications (`RpcEvent` in `src/rpc.gen.ts`). Returns an unsubscribe. */
  onEvent: (callback: (event: unknown) => void) => subscribe("backend-event", callback),
  /** Menu actions from the main process. Returns an unsubscribe. */
  onMenuAction: (callback: (action: string) => void) => subscribe("menu-action", callback),
});
