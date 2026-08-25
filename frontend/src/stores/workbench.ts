import { createStore } from "solid-js/store";

export type PanelId = "left" | "right" | "bottom" | "center";
export type ViewId = "binder" | "codex" | "agent" | "editor" | "outliner" | "search" | "terminal";

export interface View {
  id: ViewId;
  title: string;
  icon: string; // lucide icon name
  component: string;
}

export interface PanelState {
  id: PanelId;
  size: number; // width for left/right, height for bottom
  visible: boolean;
  activeView: ViewId | null;
  views: ViewId[];
}

export type EditorMode = "code" | "preview" | "live";

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  editorMode: EditorMode;
}

export interface WorkbenchState {
  zenMode: boolean;
  isSettingsOpen: boolean;
  settings: EditorSettings;
  panels: Record<PanelId, PanelState>;
}

const DEFAULT_SETTINGS: EditorSettings = {
  fontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
  fontSize: 16,
  editorMode: "live",
};

const SETTINGS_KEY = "chronicler-settings";

const loadSettings = (): EditorSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const [workbench, setWorkbench] = createStore<WorkbenchState>({
  zenMode: false,
  isSettingsOpen: false,
  settings: loadSettings(),
  panels: {
    left: {
      id: "left",
      size: 250,
      visible: true,
      activeView: "binder",
      views: ["binder", "search"],
    },
    right: {
      id: "right",
      size: 300,
      visible: true,
      activeView: "agent",
      views: ["agent", "codex", "outliner"],
    },
    bottom: {
      id: "bottom",
      size: 200,
      visible: true,
      activeView: "terminal",
      views: [],
    },
    center: {
      id: "center",
      size: 0, // flex-1
      visible: true,
      activeView: "editor",
      views: ["editor"],
    },
  },
});

export const updateSettings = (patch: Partial<EditorSettings>) => {
  setWorkbench("settings", patch);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...workbench.settings }));
  } catch {
    // Persistence is best-effort; the in-memory value still applies
  }
};

export const togglePanel = (panel: PanelId) => {
  setWorkbench("panels", panel, "visible", (v) => !v);
};

export const setActiveView = (panel: PanelId, view: ViewId) => {
  setWorkbench("panels", panel, "activeView", view);
  setWorkbench("panels", panel, "visible", true);
};

export const moveView = (_view: ViewId, _from: PanelId, _to: PanelId) => {
  // Logic to move a view between panels, enabling VS Code style drag-and-drop
  // customization of the UI.
};
