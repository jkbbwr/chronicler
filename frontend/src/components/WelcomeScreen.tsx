import { type Component, For, Show } from "solid-js";
import { FolderOpen, FilePlus } from "lucide-solid";

interface RecentProject {
  path: string;
  openedAt: string;
}

interface WelcomeScreenProps {
  recents: RecentProject[];
}

const basename = (p: string) => p.split("/").pop() || p;

const shortenHome = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

export const WelcomeScreen: Component<WelcomeScreenProps> = (props) => {
  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      background: "var(--bg-color)",
      "z-index": 1000,
      display: "flex",
      "flex-direction": "column",
    }}>
      {/* Keep the frameless window draggable */}
      <div class="titlebar" />

      <div style={{
        flex: 1,
        display: "flex",
        "justify-content": "center",
        "align-items": "center",
        gap: "60px",
        padding: "40px",
      }}>
        <div style={{ "text-align": "center", "min-width": "280px" }}>
          <div style={{
            "font-size": "42px",
            "font-weight": 300,
            color: "var(--text-main)",
            "font-family": "ui-serif, Georgia, serif",
            "margin-bottom": "8px",
          }}>
            Chronicler
          </div>
          <div style={{ color: "var(--text-faint)", "font-size": "13px", "margin-bottom": "40px" }}>
            The IDE for fiction writing
          </div>

          <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "align-items": "center" }}>
            <button
              onClick={() => window.chronicler.createProject()}
              style={{
                display: "flex", "align-items": "center", gap: "10px",
                width: "220px", padding: "10px 16px",
                background: "var(--accent)", color: "#fff",
                border: "none", "border-radius": "6px",
                "font-size": "13px", cursor: "pointer",
              }}
            >
              <FilePlus size={16} /> New Project
            </button>
            <button
              onClick={() => window.chronicler.openProject()}
              style={{
                display: "flex", "align-items": "center", gap: "10px",
                width: "220px", padding: "10px 16px",
                background: "transparent", color: "var(--text-main)",
                border: "1px solid var(--border-color)", "border-radius": "6px",
                "font-size": "13px", cursor: "pointer",
              }}
            >
              <FolderOpen size={16} /> Open Project...
            </button>
          </div>
        </div>

        <Show when={props.recents.length > 0}>
          <div style={{ "min-width": "320px", "max-width": "400px" }}>
            <div style={{
              "font-size": "11px", "font-weight": 600, "text-transform": "uppercase",
              color: "var(--text-muted)", "letter-spacing": "0.5px", "margin-bottom": "12px",
            }}>
              Recent Projects
            </div>
            <For each={props.recents}>
              {(project) => (
                <div
                  onClick={() => window.chronicler.openProject(project.path)}
                  style={{
                    padding: "10px 12px", cursor: "pointer",
                    "border-radius": "6px", "margin-bottom": "4px",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  <div style={{ color: "var(--text-main)", "font-size": "13px", "font-weight": 500 }}>
                    {basename(project.path)}
                  </div>
                  <div style={{
                    color: "var(--text-faint)", "font-size": "11px", "margin-top": "2px",
                    "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis",
                  }}>
                    {shortenHome(project.path)}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};
