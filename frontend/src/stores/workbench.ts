import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";

// App-wide UI state: settings (global, persisted), the active mode, and the
// shell layout (per project, persisted by the session store).

/** Task modes: each has a layout built for its job. */
export type Mode = "write" | "plan" | "review" | "codex";

export const MODES: { id: Mode; label: string; key: string }[] = [
  { id: "write", label: "Write", key: "1" },
  { id: "plan", label: "Plan", key: "2" },
  { id: "review", label: "Review", key: "3" },
  { id: "codex", label: "Codex", key: "4" },
];

export type PlanView = "cards" | "threads" | "timeline" | "graph" | "ledger";
export type ReviewSection = "problems" | "notes" | "prose" | "history" | "critique";
export type InspectorTab = "scene" | "agent";

/** "live" hides markdown syntax as you write; "code" shows it. */
export type EditorMode = "code" | "live";

export type ThemeId =
  | "system"
  | "dark" | "midnight" | "nocturne" | "evergreen" | "ember" | "ink"
  | "oxblood" | "graphite" | "tidepool"
  | "light" | "sepia" | "parchment" | "linen" | "mist"
  | "vellum" | "fog" | "blossom";
export type ResolvedTheme = Exclude<ThemeId, "system">;

/**
 * The one place a theme is declared: `light` drives both the picker's grouping
 * and the editor's syntax chrome, so a new palette can't be half-registered.
 * Every id here needs a matching `:root[data-theme="..."]` block in
 * styles/themes.css ("dark" is the bare `:root` default).
 */
export const THEMES: { id: ThemeId; label: string; light?: boolean }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "midnight", label: "Midnight" },
  { id: "nocturne", label: "Nocturne" },
  { id: "evergreen", label: "Evergreen" },
  { id: "ember", label: "Ember" },
  { id: "ink", label: "Ink" },
  { id: "oxblood", label: "Oxblood" },
  { id: "graphite", label: "Graphite" },
  { id: "tidepool", label: "Tidepool" },
  { id: "light", label: "Light", light: true },
  { id: "sepia", label: "Sepia", light: true },
  { id: "parchment", label: "Parchment", light: true },
  { id: "linen", label: "Linen", light: true },
  { id: "mist", label: "Mist", light: true },
  { id: "vellum", label: "Vellum", light: true },
  { id: "fog", label: "Fog", light: true },
  { id: "blossom", label: "Blossom", light: true },
];

const LIGHT_THEMES = new Set(THEMES.filter(t => t.light).map(t => t.id));

export const isLightTheme = (t: ResolvedTheme) => LIGHT_THEMES.has(t);

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Line length in ems. ~38em ≈ 66 characters. */
  measure: number;
  /** Width of reading pages (codex, history, reports) in rem (16px); 0 = fill the window. */
  pageWidth: number;
  paragraphStyle: "spaced" | "indent";
  editorMode: EditorMode;
  theme: ThemeId;
  typewriterMode: boolean;
  focusMode: boolean;
  smartTypography: boolean;
  /** Codex names: "hover" = quiet until Cmd/Ctrl is held; "always" = always tinted. */
  entityHighlight: "hover" | "always";
}

export interface Layout {
  binderOpen: boolean;
  binderWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorTab: InspectorTab;
  /** Write shows the whole chapter as one continuous page. */
  chapterView: boolean;
}

export interface WorkbenchState {
  mode: Mode;
  /** Write-mode distraction-free: only the page and a fading word count. */
  zenMode: boolean;
  isCompileOpen: boolean;
  planView: PlanView;
  reviewSection: ReviewSection;
  /** Review: findings for the current scene only, or the whole book. */
  reviewScope: "scene" | "book";
  settings: EditorSettings;
  layout: Layout;
}

const DEFAULT_SETTINGS: EditorSettings = {
  fontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
  fontSize: 18,
  lineHeight: 1.65,
  measure: 38,
  pageWidth: 56,
  paragraphStyle: "spaced",
  editorMode: "live",
  theme: "dark",
  typewriterMode: false,
  focusMode: false,
  smartTypography: true,
  entityHighlight: "hover",
};

export const DEFAULT_LAYOUT: Layout = {
  binderOpen: true,
  binderWidth: 260,
  inspectorOpen: false,
  inspectorWidth: 320,
  inspectorTab: "scene",
  chapterView: false,
};

const SETTINGS_KEY = "chronicler-settings";

const loadSettings = (): EditorSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const loaded = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    if ((loaded.editorMode as string) === "preview") loaded.editorMode = "live"; // retired mode
    return loaded;
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const [workbench, setWorkbench] = createStore<WorkbenchState>({
  mode: "write",
  zenMode: false,
  isCompileOpen: false,
  planView: "cards",
  reviewSection: "problems",
  reviewScope: "scene",
  settings: loadSettings(),
  layout: { ...DEFAULT_LAYOUT },
});

export const updateSettings = (patch: Partial<EditorSettings>) => {
  setWorkbench("settings", patch);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...workbench.settings }));
  } catch {
    // Persistence is best-effort; the in-memory value still applies
  }
  if (patch.theme !== undefined) applyTheme();
  if (patch.fontFamily !== undefined) applyProseFont();
  if (patch.measure !== undefined || patch.pageWidth !== undefined) applyWidths();
};

export const setMode = (mode: Mode) => {
  setWorkbench("mode", mode);
  if (mode !== "write") setWorkbench("zenMode", false);
};

export const toggleBinder = () => setWorkbench("layout", "binderOpen", (v) => !v);

/** Open the inspector on `tab`; toggles it closed if that tab is already showing. */
export const toggleInspector = (tab?: InspectorTab) => {
  const l = workbench.layout;
  if (tab && l.inspectorOpen && l.inspectorTab !== tab) {
    setWorkbench("layout", "inspectorTab", tab);
    return;
  }
  if (tab) setWorkbench("layout", "inspectorTab", tab);
  setWorkbench("layout", "inspectorOpen", !l.inspectorOpen);
};

export const showInspector = (tab: InspectorTab) => {
  setWorkbench("layout", { inspectorOpen: true, inspectorTab: tab });
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

/** Surfaces outside the editor (diffs, codex pages, peek cards) share the prose face. */
function applyProseFont() {
  document.documentElement.style.setProperty("--font-prose", workbench.settings.fontFamily);
}

/** Line length and page width as CSS variables for every surface. */
function applyWidths() {
  const root = document.documentElement.style;
  root.setProperty("--prose-measure", `${workbench.settings.measure}em`);
  root.setProperty("--page-measure", workbench.settings.pageWidth > 0 ? `${workbench.settings.pageWidth}rem` : "none");
}

systemDark.addEventListener("change", () => {
  if (workbench.settings.theme === "system") applyTheme();
});

applyTheme();
applyProseFont();
applyWidths();
