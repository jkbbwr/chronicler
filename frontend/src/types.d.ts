export {};

declare global {
  interface Window {
    chronicler: {
      invoke<T = any>(method: string, params?: any): Promise<T>;
      onEvent(callback: (event: any) => void): void;
      onMenuAction(callback: (action: string) => void): void;
    };
  }
}
