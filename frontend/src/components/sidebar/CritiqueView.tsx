import { type Component, createResource, For, Show } from "solid-js";
import { BookOpenCheck, FileText } from "lucide-solid";

// Left-rail browser for the last reading critique: per-scene notes at a
// glance, click through to scenes, full report and wizard one click away.
// (Panels browse, center edits.)

interface CritiqueScene {
  file: string;
  notes: string;
  problems: number;
}

interface CritiqueResults {
  ranAt: number;
  problems: number;
  scenes: CritiqueScene[];
}

interface CritiqueViewProps {
  refreshVersion: number;
  onOpenScene: (file: string) => void;
  onOpenReport: () => void;
  onRunWizard: () => void;
}

const sceneName = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

export const CritiqueView: Component<CritiqueViewProps> = (props) => {
  const [results] = createResource(
    () => props.refreshVersion,
    async () => {
      try {
        const res = await window.chronicler.invoke("db/get", { key: "critiqueResults" });
        return res.value ? (JSON.parse(res.value) as CritiqueResults) : null;
      } catch {
        return null;
      }
    }
  );

  const button = {
    width: "100%", padding: "7px 12px", background: "transparent",
    border: "1px solid var(--border-color)", color: "var(--text-muted)",
    "border-radius": "6px", cursor: "pointer", "font-size": "12px",
    "margin-bottom": "8px",
  } as const;

  return (
    <div style={{ padding: "12px", "font-size": "12.5px", height: "100%", "overflow-y": "auto" }}>
      <button style={{ ...button, color: "var(--accent)", "border-color": "var(--accent)" }} onClick={props.onRunWizard}>
        <BookOpenCheck size={12} style={{ "vertical-align": "-2px" }} /> Run reading critique…
      </button>
      <Show
        when={results()}
        fallback={
          <div style={{ color: "var(--text-faint)", "line-height": "1.6", padding: "4px" }}>
            No critique yet. Describe your reader in the wizard and the agent reviews every scene
            against that brief.
          </div>
        }
      >
        {(r) => (
          <>
            <button style={button} onClick={props.onOpenReport}>Open full report</button>
            <div style={{ color: "var(--text-faint)", "font-size": "11px", margin: "4px 0 10px" }}>
              {new Date(r().ranAt * 1000).toLocaleString()} — {r().problems} stumbling block(s)
            </div>
            <For each={r().scenes}>
              {(scene) => (
                <div
                  onClick={() => props.onOpenScene(scene.file)}
                  title={scene.file}
                  style={{ padding: "7px 8px", "border-radius": "6px", cursor: "pointer", "margin-bottom": "4px" }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--hover-bg)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                    <FileText size={11} style={{ opacity: 0.6, "flex-shrink": 0 }} />
                    <span style={{ color: "var(--text-main)", "font-weight": 600, flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>
                      {sceneName(scene.file)}
                    </span>
                    <Show when={scene.problems > 0}>
                      <span style={{ "font-size": "10.5px", color: "#b689e0", border: "1px solid #b689e0", "border-radius": "8px", padding: "0 6px", "flex-shrink": 0 }}>
                        {scene.problems}
                      </span>
                    </Show>
                  </div>
                  <div style={{ color: "var(--text-muted)", "margin-top": "3px", "line-height": "1.5", display: "-webkit-box", "-webkit-line-clamp": "3", "-webkit-box-orient": "vertical", overflow: "hidden" }}>
                    {scene.notes}
                  </div>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  );
};
