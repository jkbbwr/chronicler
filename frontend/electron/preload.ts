import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("chronicler", {
  invoke: (method: string, params?: any) => ipcRenderer.invoke("rpc-invoke", method, params),
  onEvent: (callback: (event: any) => void) => {
    ipcRenderer.on("backend-event", (_event, data) => callback(data));
  },
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on("menu-action", (_event, action) => callback(action));
  }
});
