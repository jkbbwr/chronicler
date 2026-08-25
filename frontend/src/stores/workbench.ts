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

export interface WorkbenchState {
  zenMode: boolean;
  isSettingsOpen: boolean;
  panels: Record<PanelId, PanelState>;
}

export const [workbench, setWorkbench] = createStore<WorkbenchState>({
  zenMode: false,
  isSettingsOpen: false,
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
