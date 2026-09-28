import { type Component, createMemo, For, Show } from "solid-js";
import { Check } from "lucide-solid";
import { Empty, IconButton } from "../../ui";
import { createQuery, invalidate, invoke } from "../../../lib/rpc";
import { notifyError } from "../../../stores/app";
import { chapterOf, flush, openScene, sceneName } from "../../../stores/documents";
import { setMode } from "../../../stores/workbench";
import type { Note } from "../../../rpc.gen";
import "./NotesList.css";

// Every margin note in the book, as a revision to-do list. Resolving one
// removes it from the text (it stays in History).

const notes = createQuery(["files"], async () => {
  try {
    return (await invoke("notes/list")).notes;
  } catch {
    return [] as Note[];
  }
});

export const noteCount = () => notes.latest?.length ?? 0;

async function resolve(n: Note) {
  // The text on disk must match what's on screen before it's edited there.
  if (!(await flush(n.file))) return;
  try {
    await invoke("notes/resolve", { path: n.file, line: n.line, text: n.text });
    invalidate("files");
  } catch (err) {
    notifyError("Couldn't resolve the note", err);
  }
}

export const NotesList: Component = () => {
  const groups = createMemo(() => {
    const map = new Map<string, Note[]>();
    for (const n of notes.latest ?? []) {
      if (!map.has(n.file)) map.set(n.file, []);
      map.get(n.file)!.push(n);
    }
    return [...map.entries()];
  });
  return (
    <div class="notes-list">
      <Show
        when={groups().length > 0}
        fallback={
          <Empty title="No notes">
            Leave yourself a note anywhere in the text with ⌘⇧A — it shows up here until you resolve it.
          </Empty>
        }
      >
        <For each={groups()}>
          {([file, list]) => (
            <section>
              <div class="section-label" title={file}>
                <span class="notes-scene">{sceneName(file)}</span>
                <span class="notes-chapter">{chapterOf(file)}</span>
                <span class="row-meta">{list.length}</span>
              </div>
              <For each={list}>
                {(n) => (
                  <div class="note-item" onClick={() => void openScene(n.file, { line: n.line, focus: false })} onDblClick={() => { setMode("write"); void openScene(n.file, { line: n.line }); }} title="Show it in its scene · double-click to write there">
                    <span class="note-text">{n.text}</span>
                    <IconButton size="sm" label="Resolve — remove the note" onClick={(e) => { e.stopPropagation(); void resolve(n); }}>
                      <Check size={13} />
                    </IconButton>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
};
