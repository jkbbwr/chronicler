import type { Rpc, RpcEvent } from "./rpc.gen";

export {};

declare global {
  interface Window {
    chronicler: {
      invoke<M extends keyof Rpc>(method: M, params?: Rpc[M]["params"]): Promise<Rpc[M]["result"]>;
      showMessageBox(options: {
        type?: "none" | "info" | "error" | "question" | "warning";
        buttons?: string[];
        defaultId?: number;
        cancelId?: number;
        message: string;
        detail?: string;
      }): Promise<{ response: number }>;
      getProject(): Promise<{ path: string | null; recents: { path: string; openedAt: string }[] }>;
      openProject(path?: string): Promise<void>;
      defaultProjectParent(): Promise<string>;
      chooseProjectParent(): Promise<string | null>;
      createProjectIn(parent: string, opts: {
        name: string;
        author?: string;
        scaffold?: boolean;
        chapter?: string;
        scene?: string;
        targets?: { dailyTarget: number; projectTarget: number };
      }): Promise<{ path?: string; error?: string }>;
      /** Reveal a project-relative path (or the root, if omitted) in the OS file manager. */
      revealInFileManager(relPath?: string): Promise<{ error?: string }>;
      /** Main shows an open dialog and copies the picked files into Research/ (new project-relative paths). */
      researchImport(): Promise<{ paths: string[]; errors: string[] }>;
      /** Close the open project and return to the welcome screen. */
      closeProject(): Promise<void>;
      platform: string;
      removeRecent(path: string): Promise<{ path: string; openedAt: string }[]>;
      /** Copy a compiled artifact out of the project; main shows the save dialog. */
      exportCompiled(source: string, options?: { defaultName?: string }): Promise<{ canceled: true } | { canceled: false; path: string }>;
      aiStoreKey(key: string): Promise<{ stored: boolean }>;
      /** Store (encrypted) and send the read-aloud provider key; "" clears it. */
      onEvent(callback: (event: RpcEvent) => void): () => void;
      onMenuAction(callback: (action: string) => void): () => void;
    };
  }
}
