import { type Component, For } from "solid-js";
import { workbench, setWorkbench, setActiveView, togglePanel } from "../../stores/workbench";
import { Folder, Search, History, Settings } from "lucide-solid";

export const ActivityBar: Component = () => {
  const views = [
    { id: "binder", icon: Folder, tooltip: "Project Binder" },
    { id: "search", icon: Search, tooltip: "Search" },
    { id: "history", icon: History, tooltip: "Snapshots" },
  ];

  const handleIconClick = (viewId: any) => {
    if (workbench.panels.left.activeView === viewId && workbench.panels.left.visible) {
      togglePanel("left");
    } else {
      setActiveView("left", viewId);
    }
  };

  return (
    <div style={{
      width: "48px",
      background: "var(--titlebar-bg)",
      "border-right": "1px solid var(--border-color)",
      display: "flex",
      "flex-direction": "column",
      "align-items": "center",
      padding: "10px 0",
      "z-index": 100
    }}>
      <div style={{ flex: 1, display: "flex", "flex-direction": "column", gap: "15px" }}>
        <For each={views}>
          {(view) => {
            const Icon = view.icon;
            const isActive = () => workbench.panels.left.visible && workbench.panels.left.activeView === view.id;
            return (
              <div
                onClick={() => handleIconClick(view.id)}
                title={view.tooltip}
                style={{
                  cursor: "pointer",
                  color: isActive() ? "var(--text-main)" : "var(--text-muted)",
                  padding: "8px",
                  "border-left": isActive() ? "2px solid var(--accent)" : "2px solid transparent",
                  transition: "color 0.15s"
                }}
                onMouseEnter={(e) => { if (!isActive()) e.currentTarget.style.color = "var(--text-main)"; }}
                onMouseLeave={(e) => { if (!isActive()) e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <Icon size={20} strokeWidth={1.5} />
              </div>
            );
          }}
        </For>
      </div>

      <div style={{ display: "flex", "flex-direction": "column", gap: "15px" }}>
        <div
          onClick={() => setWorkbench("isSettingsOpen", true)}
          title="Settings"
          style={{ cursor: "pointer", color: "var(--text-muted)", padding: "8px" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-main)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        >
          <Settings size={20} strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
};
