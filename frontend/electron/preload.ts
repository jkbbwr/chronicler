import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("chronicler", {
  invoke: (method: string, params?: any) => ipcRenderer.invoke("rpc-invoke", method, params),
  showMessageBox: (options: any) => ipcRenderer.invoke("show-message-box", options),
  getProject: () => ipcRenderer.invoke("get-project"),
  openProject: (path?: string) => ipcRenderer.invoke("open-project", path),
  createProject: () => ipcRenderer.invoke("create-project"),
  removeRecent: (path: string) => ipcRenderer.invoke("remove-recent", path),
  showSaveDialog: (options: any) => ipcRenderer.invoke("show-save-dialog", options),
  exportCompiled: (source: string, dest: string) => ipcRenderer.invoke("export-compiled", source, dest),
  aiStoreKey: (key: string) => ipcRenderer.invoke("ai-store-key", key),
  onEvent: (callback: (event: any) => void) => {
    ipcRenderer.on("backend-event", (_event, data) => callback(data));
  },
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on("menu-action", (_event, action) => callback(action));
  }
});
