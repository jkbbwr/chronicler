export {};

declare global {
  interface Window {
    chronicler: {
      invoke<T = any>(method: string, params?: any): Promise<T>;
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
      createProject(): Promise<void>;
      removeRecent(path: string): Promise<{ path: string; openedAt: string }[]>;
      showSaveDialog(options: {
        title?: string;
        defaultPath?: string;
        filters?: { name: string; extensions: string[] }[];
      }): Promise<{ canceled: boolean; filePath?: string }>;
      exportCompiled(source: string, dest: string): Promise<{ success: boolean }>;
      aiStoreKey(key: string): Promise<{ stored: boolean }>;
      onEvent(callback: (event: any) => void): void;
      onMenuAction(callback: (action: string) => void): void;
    };
  }
}
