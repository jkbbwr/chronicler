import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";

export type PanelId = "left" | "right" | "bottom" | "center";
export type ViewId = "binder" | "codex" | "agent" | "editor" | "outliner" | "search" | "terminal" | "history" | "critique";

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

export type ThemeId = "system" | "dark" | "midnight" | "light" | "sepia";
export type ResolvedTheme = Exclude<ThemeId, "system">;

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "midnight", label: "Midnight" },
  { id: "light", label: "Light" },
  { id: "sepia", label: "Sepia" },
];

export const isLightTheme = (t: ResolvedTheme) => t === "light" || t === "sepia";

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  editorMode: EditorMode;
  theme: ThemeId;
  typewriterMode: boolean;
  focusMode: boolean;
  smartTypography: boolean;
}

export interface WorkbenchState {
  zenMode: boolean;
  isCompileOpen: boolean;
  settings: EditorSettings;
  panels: Record<PanelId, PanelState>;
}

const DEFAULT_SETTINGS: EditorSettings = {
  fontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
  fontSize: 16,
  editorMode: "live",
  theme: "dark",
  typewriterMode: false,
  focusMode: false,
  smartTypography: true,
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
  isCompileOpen: false,
  settings: loadSettings(),
  panels: {
    left: {
      id: "left",
      size: 250,
      visible: true,
      activeView: "binder",
      views: ["binder", "outliner", "search", "history", "critique"],
    },
    right: {
      id: "right",
      size: 300,
      visible: true,
      activeView: "codex",
      views: ["agent", "codex"],
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
  if (patch.theme !== undefined) applyTheme();
};

// ---- Theme application ----

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

const resolveTheme = (): ResolvedTheme => {
  const t = workbench.settings.theme;
  if (t === "system") return systemDark.matches ? "dark" : "light";
  return t;
};

export const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>("dark");

export function applyTheme() {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  setResolvedTheme(resolved);
}

systemDark.addEventListener("change", () => {
  if (workbench.settings.theme === "system") applyTheme();
});

applyTheme();

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
