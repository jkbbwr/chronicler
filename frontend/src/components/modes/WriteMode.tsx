import { type Component, createEffect, createMemo, For, on, Show } from "solid-js";
import { Columns2, Compass, FilePlus, Volume2, X } from "lucide-solid";
import { SceneEditor } from "../editor/SceneEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { BinderDrawer, triggerCreate } from "../shell/BinderDrawer";
import { ReadAloudBar } from "../readaloud/ReadAloudBar";
import { openCatchUp } from "../shell/CatchUp";
import { ResearchViewer, isEditableNote, isResearchPath } from "../research/ResearchViewer";
import { Button, IconButton, Kbd, Segmented } from "../ui";
import { setWorkbench, workbench } from "../../stores/workbench";
import {
  chapterOf, docs, ensureLoaded, getContent, openScene, recent, reference, scene, sceneName, setReference, viewFor,
} from "../../stores/documents";
import { outline } from "../../stores/story";
import { openPalette } from "../../stores/app";
import { reading, speakable, startReading, stop as stopReading, type ReadAloudItem } from "../../lib/readAloud";

// Write: the page — one scene, or the whole chapter as one continuous page.
// The binder can slide in; everything else stays out of the way.

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? "⌘" : "Ctrl+";

/** The scenes of the chapter `path` belongs to, in binder order. */
export const chapterScenes = (path: string | null): string[] => {
  if (!path) return [];
  const chapter = (outline.latest ?? []).find((c) => c.scenes.includes(path));
  return chapter ? chapter.scenes : [path];
};

const chapterTitle = (path: string | null) =>
  (outline.latest ?? []).find((c) => path && c.scenes.includes(path))?.title ?? "";

/** Paragraphs to read aloud, starting from the cursor's paragraph. */
export function readFromCursor(paths: string[]) {
  const items: ReadAloudItem[] = [];
  for (const path of paths) {
    getContent(path).split("\n").forEach((text, i) => {
      if (speakable(text)) items.push({ path, line: i + 1, text });
    });
  }
  if (items.length === 0) return;
  const current = scene();
  const view = viewFor(current);
  const cursorLine = view ? view.state.doc.lineAt(view.state.selection.main.head).number : 1;
  const from = Math.max(0, items.findIndex((it) => it.path === current && it.line >= cursorLine));
  startReading(items, from);
}

const NoScene: Component = () => (
  <div class="write-empty">
    <h2>Pick up where you left off</h2>
    <Show when={recent().length > 0} fallback={<p class="hint">No scenes opened yet in this project.</p>}>
      <div class="write-recents">
        <For each={recent().slice(0, 6)}>
          {(p) => (
            <button type="button" class="list-row" onClick={() => void openScene(p)}>
              <span>{sceneName(p)}</span>
              <span class="row-meta">{chapterOf(p)}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
    <div class="write-empty-actions">
      <Button onClick={() => openPalette("")}>Go to scene <Kbd>{mod}P</Kbd></Button>
      <Button variant="ghost" onClick={() => triggerCreate("file")}><FilePlus size={14} /> New scene</Button>
      <Show when={recent().length > 0}>
        <Button variant="ghost" title={`Open ${sceneName(recent()[0])} and sum up where you are`} onClick={() => { const p = recent()[0]; void openScene(p).then((ok) => ok && openCatchUp(p)); }}>
          <Compass size={14} /> Catch me up
        </Button>
      </Show>
    </div>
  </div>
);

/** Every scene of the chapter, stacked and editable, one scroll. */
const ChapterPage: Component<{ path: string }> = (props) => {
  const scenes = createMemo(() => chapterScenes(props.path));
  // Load them all (each keeps its own file, saves and undo).
  createEffect(on(scenes, (list) => { for (const p of list) void ensureLoaded(p); }));
  return (
    <div class="chapter-page">
      <For each={scenes()}>
        {(path, i) => (
          <section class="chapter-scene" classList={{ current: path === scene() }}>
            <Show when={i() > 0}><div class="chapter-break" aria-hidden="true">⁂</div></Show>
            <button type="button" class="chapter-scene-name" onClick={() => void openScene(path)} title="Make this the current scene">
              {sceneName(path)}
            </button>
            <Show when={docs[path] && !docs[path].loading}>
              <div onFocusIn={() => { if (scene() !== path) void openScene(path); }}>
                <SceneEditor path={path} class="flow" />
              </div>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
};

/** Beside the page: another scene (read-only) or a research item. */
const ReferencePane: Component<{ path: string }> = (props) => {
  const editableNote = () => isResearchPath(props.path) && isEditableNote(props.path);
  createEffect(on(() => props.path, (p) => { if (editableNote()) void ensureLoaded(p); }));
  return (
    <aside class="reference-pane">
      <Show
        when={!isResearchPath(props.path) || editableNote()}
        fallback={<ResearchViewer path={props.path} onClose={() => setReference(null)} />}
      >
        <div class="side-header">
          <span class="reference-title">{sceneName(props.path)}</span>
          <span class="hint">{editableNote() ? "research note" : "reference"}</span>
          <IconButton label="Close" size="sm" onClick={() => setReference(null)}><X size={13} /></IconButton>
        </div>
        <Show
          when={editableNote()}
          fallback={<div class="reference-body selectable"><MarkdownPreview content={docs[props.path]?.content ?? ""} /></div>}
        >
          <Show when={docs[props.path] && !docs[props.path].loading}>
            <div class="reference-body reference-note"><SceneEditor path={props.path} /></div>
          </Show>
        </Show>
      </Show>
    </aside>
  );
};

export const WriteMode: Component = () => {
  const chapterView = () => workbench.layout.chapterView;
  const readingHere = () => !!reading();
  const toggleRead = () => {
    if (readingHere()) stopReading();
    else readFromCursor(chapterView() ? chapterScenes(scene()) : scene() ? [scene()!] : []);
  };
  return (
    <div class="mode-surface write-mode">
      <Show when={workbench.layout.binderOpen && !workbench.zenMode}>
        <BinderDrawer />
      </Show>
      <div class="page-column">
        <Show when={scene()} fallback={<NoScene />}>
          <Show when={!workbench.zenMode}>
            <div class="page-header">
              <span class="page-crumb">
                <Show
                  when={chapterView()}
                  fallback={<><Show when={chapterOf(scene()!)}><span class="page-chapter">{chapterOf(scene()!)} › </span></Show>{sceneName(scene()!)}</>}
                >
                  {chapterTitle(scene()) || chapterOf(scene()!) || sceneName(scene()!)}
                  <span class="page-chapter"> · {chapterScenes(scene()).length} scenes</span>
                </Show>
              </span>
              <div class="page-actions">
                <Segmented
                  class="page-view-switch"
                  value={chapterView() ? "chapter" : "scene"}
                  options={[
                    { value: "scene", label: "Scene", title: "One scene at a time" },
                    { value: "chapter", label: "Chapter", title: `The whole chapter as one page (${mod}⇧C)` },
                  ]}
                  onChange={(v) => setWorkbench("layout", "chapterView", v === "chapter")}
                />
                <IconButton size="sm" label="Catch me up — the story so far and where you left off" onClick={() => openCatchUp()}>
                  <Compass size={13} />
                </IconButton>
                <IconButton size="sm" label={readingHere() ? "Stop reading aloud" : "Read aloud from the cursor"} active={readingHere()} onClick={toggleRead}>
                  <Volume2 size={13} />
                </IconButton>
                <IconButton
                  size="sm"
                  label={`Open beside as reference (${mod}\\)`}
                  active={reference() === scene()}
                  onClick={() => setReference(reference() === scene() ? null : scene())}
                >
                  <Columns2 size={13} />
                </IconButton>
              </div>
            </div>
          </Show>
          <Show
            when={chapterView()}
            fallback={<Show when={!docs[scene()!]?.loading}><SceneEditor path={scene()!} /></Show>}
          >
            <ChapterPage path={scene()!} />
          </Show>
        </Show>
        <ReadAloudBar sceneName={sceneName} />
      </div>
      <Show when={reference() && !workbench.zenMode && (docs[reference()!] || isResearchPath(reference()!))}>
        <ReferencePane path={reference()!} />
      </Show>
    </div>
  );
};
