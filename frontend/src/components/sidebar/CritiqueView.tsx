import { type Component, createResource, For, Show } from "solid-js";
import { BookOpenCheck } from "lucide-solid";
import { Button } from "../ui";
import "./CritiqueView.css";

// The last reading critique, scene by scene (Review › Critique). The full
// report shows beside it; clicking a scene opens its findings.

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
  // Wrapped: a bare version number of 0 is falsy and would never fetch.
  const [results] = createResource(
    () => ({ v: props.refreshVersion }),
    async () => {
      try {
        const res = await window.chronicler.invoke("db/get", { key: "critiqueResults" });
        return res.value ? (JSON.parse(res.value) as CritiqueResults) : null;
      } catch {
        return null;
      }
    }
  );

  return (
    <div class="critique-list">
      <Show
        when={results.latest}
        fallback={<p class="hint critique-hint">Write a brief describing your reader, and the agent reads every scene against it.</p>}
      >
        {(r) => (
          <>
            <div class="hint critique-hint">
              {new Date(r().ranAt * 1000).toLocaleString()} · {r().problems} stumbling block{r().problems === 1 ? "" : "s"}
            </div>
            <For each={r().scenes}>
              {(scene) => (
                <div class="critique-scene" title={scene.file} onClick={() => props.onOpenScene(scene.file)}>
                  <div class="critique-scene-head">
                    <span class="critique-scene-name">{sceneName(scene.file)}</span>
                    <Show when={scene.problems > 0}><span class="count-badge critique-count">{scene.problems}</span></Show>
                  </div>
                  <div class="critique-notes">{scene.notes}</div>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
      <div class="critique-actions">
        <Button size="sm" variant={results.latest ? "secondary" : "primary"} onClick={props.onRunWizard}>
          <BookOpenCheck size={12} /> {results.latest ? "New critique…" : "Start a reading critique…"}
        </Button>
      </div>
    </div>
  );
};
