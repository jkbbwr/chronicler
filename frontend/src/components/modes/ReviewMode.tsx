import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { RefreshCw } from "lucide-solid";
import { ReviewDoc } from "./review/ReviewDoc";
import { NotesList } from "./review/NotesList";
import { ProseReport } from "./review/ProseReport";
import { HistoryView } from "../sidebar/HistoryView";
import { DiffView, type DiffSpec } from "../center/DiffView";
import { CritiqueView } from "../sidebar/CritiqueView";
import { Button, Empty, IconButton, Resizer, Segmented, Tabs } from "../ui";
import { setMode, setWorkbench, workbench, type ReviewSection } from "../../stores/workbench";
import { allDiags, diagKey, diagsFor, recheck, SOURCE_LABEL, type Diag } from "../../stores/diagnostics";
import { chapterOf, openScene, scene, sceneName } from "../../stores/documents";
import { createQuery, invoke, topicVersion } from "../../lib/rpc";
import { notify, setOverlays } from "../../stores/app";
import { renderMarkdown, parseSceneHref } from "../../lib/markdown";
import { registerCommands } from "../../commands";

// Review: work through what needs attention — findings in the margin of
// the scene, version history with diffs, and the reading critique.

const [active, setActive] = createSignal<string | null>(null);
const [diffSpec, setDiffSpec] = createSignal<DiffSpec | null>(null);

const byPosition = (a: Diag, b: Diag) => a.file.localeCompare(b.file) || a.line - b.line || a.colStart - b.colStart;

/** The findings queue in reading order, for the current scope. */
const queue = () => {
  const list = workbench.reviewScope === "scene" ? diagsFor(scene()) : allDiags();
  return [...list].sort(byPosition);
};

/** Move through the queue, opening the finding's scene if needed. */
export function stepFinding(delta: 1 | -1) {
  const q = queue();
  if (q.length === 0) return;
  const i = q.findIndex((d) => diagKey(d) === active());
  const next = q[(i + delta + q.length) % q.length];
  activate(next);
}

function activate(d: Diag) {
  setActive(diagKey(d));
  if (d.file !== scene()) void openScene(d.file, { line: d.line, colStart: d.colStart, colEnd: d.colEnd, focus: false });
}

const engine = createQuery(["diags"], async () => {
  try {
    return await invoke("diag/status");
  } catch {
    return { ready: false };
  }
});

const ProblemsQueue: Component = () => {
  const groups = createMemo(() => {
    const map = new Map<string, Diag[]>();
    for (const d of queue()) {
      if (!map.has(d.file)) map.set(d.file, []);
      map.get(d.file)!.push(d);
    }
    return [...map.entries()];
  });
  return (
    <>
      <div class="review-queue-bar">
        <Segmented
          value={workbench.reviewScope}
          options={[{ value: "scene", label: "This scene" }, { value: "book", label: "Whole book" }]}
          onChange={(v) => setWorkbench("reviewScope", v)}
        />
        <IconButton label="Check again" size="sm" onClick={() => void recheck()}><RefreshCw size={13} /></IconButton>
      </div>
      <Show when={engine.latest && !engine.latest.ready}>
        <p class="hint review-setup">Spelling and grammar are still loading…</p>
      </Show>
      <Show when={queue().length > 0} fallback={
        <Empty title="All clear">
          {workbench.reviewScope === "scene" ? "Nothing flagged in this scene." : "Nothing flagged in the book."}
        </Empty>
      }>
        <For each={groups()}>
          {([file, list]) => (
            <div class="queue-group">
              <Show when={workbench.reviewScope === "book"}>
                <div class="section-label" title={file}>
                  {sceneName(file)}
                  <span class="row-meta">{list.length}</span>
                </div>
              </Show>
              <For each={list}>
                {(d) => (
                  <div class="queue-item" classList={{ active: active() === diagKey(d) }} data-source={d.source} onClick={() => activate(d)}>
                    <span class="queue-dot" />
                    <div class="queue-text">
                      <div class="queue-quote">{d.text || SOURCE_LABEL[d.source]}</div>
                      <div class="queue-message">{d.message}</div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </>
  );
};

const critiqueReport = createQuery(["critique"], async () => {
  try {
    return (await invoke("db/get", { key: "critiqueReport" })).value;
  } catch {
    return null;
  }
});

const openFromReport = (e: MouseEvent) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const target = parseSceneHref(a.getAttribute("href") ?? "");
  if (target) {
    setMode("write");
    void openScene(target.path, target.line ? { line: target.line } : undefined);
  }
};

export const ReviewMode: Component = () => {
  const [queueWidth, setQueueWidth] = createSignal(300);

  onMount(() => {
    // J/K walk the queue when focus isn't in the text.
    const onKey = (e: KeyboardEvent) => {
      if (workbench.reviewSection !== "problems" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof Element && t.closest(".cm-editor, input, textarea, [contenteditable]")) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); stepFinding(1); }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); stepFinding(-1); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="mode-surface review-mode">
      <aside class="side side-left" style={{ width: `${queueWidth()}px` }}>
        <div class="side-header">
          <Tabs<ReviewSection>
            value={workbench.reviewSection}
            options={[
              { value: "problems", label: "Findings" },
              { value: "notes", label: "Notes" },
              { value: "prose", label: "Prose" },
              { value: "history", label: "History" },
              { value: "critique", label: "Critique" },
            ]}
            onChange={(v) => setWorkbench("reviewSection", v)}
          />
        </div>
        <div class="side-body">
          <Show when={workbench.reviewSection === "problems"}><ProblemsQueue /></Show>
          <Show when={workbench.reviewSection === "notes"}><NotesList /></Show>
          <Show when={workbench.reviewSection === "prose"}>
            <p class="hint review-side-note">
              How the book reads line by line, across every scene: words you lean on, words you repeat, and how much your
              sentence lengths vary. Echoes, adverb tags and flat rhythm also show up under Findings as you write.
            </p>
          </Show>
          <Show when={workbench.reviewSection === "history"}>
            <HistoryView activeFile={scene()} version={topicVersion("history")} onStatus={notify} onCompare={setDiffSpec} />
          </Show>
          <Show when={workbench.reviewSection === "critique"}>
            <CritiqueView
              refreshVersion={topicVersion("critique")}
              onOpenScene={(f) => { setWorkbench({ reviewSection: "problems", reviewScope: "scene" }); void openScene(f); }}
              onOpenReport={() => {}}
              onRunWizard={() => setOverlays("critique", true)}
            />
          </Show>
        </div>
      </aside>
      <Resizer side="left" width={queueWidth()} min={240} max={480} onResize={setQueueWidth} />

      <main class="review-main">
        <Show when={workbench.reviewSection === "problems"}>
          <Show when={scene()} fallback={<Empty title="Nothing open">Pick a finding, or open a scene to review it.</Empty>}>
            <div class="review-scene-bar">
              <span class="page-crumb">
                <Show when={chapterOf(scene()!)}><span class="page-chapter">{chapterOf(scene()!)} › </span></Show>
                {sceneName(scene()!)}
              </span>
              <span class="hint">J / K to step through · click a card to act</span>
            </div>
            <ReviewDoc
              path={scene()!}
              findings={diagsFor(scene())}
              active={active()}
              onActivate={setActive}
            />
          </Show>
        </Show>
        <Show when={workbench.reviewSection === "notes"}>
          <Show when={scene()} fallback={<Empty title="Your notes">Pick a note to see it in its scene.</Empty>}>
            <div class="review-scene-bar">
              <span class="page-crumb">
                <Show when={chapterOf(scene()!)}><span class="page-chapter">{chapterOf(scene()!)} › </span></Show>
                {sceneName(scene()!)}
              </span>
            </div>
            <ReviewDoc path={scene()!} findings={[]} active={null} onActivate={() => {}} />
          </Show>
        </Show>
        <Show when={workbench.reviewSection === "prose"}>
          <ProseReport />
        </Show>
        <Show when={workbench.reviewSection === "history"}>
          <Show when={diffSpec()} keyed fallback={<Empty title="Compare versions">Pick a version or a save on the left to see what changed.</Empty>}>
            {(spec) => (
              <DiffView {...spec} onOpenFile={(f) => { setMode("write"); void openScene(f); }} onStatus={notify} />
            )}
          </Show>
        </Show>
        <Show when={workbench.reviewSection === "critique"}>
          <Show
            when={critiqueReport.latest}
            fallback={
              <Empty title="No critique yet">
                <p>The agent reads the book as a first reader would, against a brief you write.</p>
                <Button variant="primary" onClick={() => setOverlays("critique", true)}>Start a reading critique…</Button>
              </Empty>
            }
          >
            <div class="report-page selectable">
              <div class="agent-md report-body" innerHTML={renderMarkdown(critiqueReport.latest ?? "")} onClick={openFromReport} />
            </div>
          </Show>
        </Show>
      </main>
    </div>
  );
};

registerCommands([
  { id: "review.next", title: "Review: Next Finding", keybinding: "F8", run: () => { setMode("review"); setWorkbench("reviewSection", "problems"); stepFinding(1); } },
  { id: "review.prev", title: "Review: Previous Finding", keybinding: "Shift+F8", run: () => { setMode("review"); setWorkbench("reviewSection", "problems"); stepFinding(-1); } },
]);
