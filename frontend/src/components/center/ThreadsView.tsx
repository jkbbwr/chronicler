import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { Trash2 } from "lucide-solid";
import { Empty, IconButton } from "../ui";
import { createThread, deleteThread, detailsFor, outline, sceneOrder, threadColor, threads, toggleThread, updateThread } from "../../stores/story";
import { entities } from "../../stores/codex";
import { stats } from "../../stores/stats";
import { sceneName } from "../../stores/documents";
import "./ThreadsView.css";

// Plot threads across the book: which scenes carry which thread, where a
// subplot goes quiet, and whose point of view the book spends its time in.

interface ThreadsViewProps {
  onOpenScene: (file: string) => void;
}

/** Words per scene, from the stats the footer already fetches. */
const wordsByFile = () => new Map((stats()?.files ?? []).map((f) => [f.file, f.words]));

const PovBalance: Component = () => {
  const rows = createMemo(() => {
    const words = wordsByFile();
    const byPov = new Map<number | null, { words: number; scenes: number }>();
    for (const file of sceneOrder()) {
      const pov = detailsFor(file).pov;
      const row = byPov.get(pov) ?? { words: 0, scenes: 0 };
      row.words += words.get(file) ?? 0;
      row.scenes += 1;
      byPov.set(pov, row);
    }
    const total = [...byPov.values()].reduce((s, r) => s + r.words, 0) || 1;
    return [...byPov.entries()]
      .map(([id, r]) => ({
        name: id === null ? "Not set" : (entities.latest ?? []).find((e) => e.id === id)?.name ?? "Unknown",
        unset: id === null,
        ...r,
        share: r.words / total,
      }))
      .sort((a, b) => Number(a.unset) - Number(b.unset) || b.words - a.words);
  });
  return (
    <section class="pov-balance">
      <h3>Point of view</h3>
      <For each={rows()}>
        {(r) => (
          <div class="pov-row" classList={{ unset: r.unset }}>
            <span class="pov-name">{r.name}</span>
            <div class="pov-bar"><div class="pov-fill" style={{ width: `${r.share * 100}%` }} /></div>
            <span class="pov-meta">{Math.round(r.share * 100)}% · {r.scenes} scene{r.scenes === 1 ? "" : "s"}</span>
          </div>
        )}
      </For>
    </section>
  );
};

export const ThreadsView: Component<ThreadsViewProps> = (props) => {
  const [adding, setAdding] = createSignal(false);
  const chapters = () => (outline.latest ?? []).filter((c) => c.scenes.length > 0);

  /** Longest run of scenes a thread goes without appearing, after it starts. */
  const longestGap = (id: number) => {
    const order = sceneOrder();
    let started = false;
    let gap = 0;
    let best = 0;
    for (const f of order) {
      if (detailsFor(f).threads.includes(id)) {
        if (started) best = Math.max(best, gap);
        started = true;
        gap = 0;
      } else if (started) gap++;
    }
    return best;
  };

  const add = async (name: string) => {
    setAdding(false);
    if (name.trim()) await createThread(name.trim());
  };

  return (
    <div class="threads-view">
      <PovBalance />

      <section class="thread-grid-wrap">
        <div class="thread-grid-head">
          <h3>Plot threads</h3>
          <Show
            when={adding()}
            fallback={<button type="button" class="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>+ Thread</button>}
          >
            <input
              class="input thread-new"
              placeholder="Thread name, then Enter"
              ref={(el) => queueMicrotask(() => el.focus())}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add(e.currentTarget.value);
                if (e.key === "Escape") setAdding(false);
              }}
              onBlur={(e) => void add(e.currentTarget.value)}
            />
          </Show>
        </div>

        <Show
          when={(threads.latest ?? []).length > 0}
          fallback={
            <Empty title="No plot threads yet">
              Add the storylines you're weaving — the main plot, each subplot, a mystery, a relationship — then mark which
              scenes carry them. Gaps show where a thread goes quiet.
            </Empty>
          }
        >
          <div class="thread-grid" style={{ "--scenes": sceneOrder().length }}>
            {/* Chapter header row */}
            <div class="tg-corner" />
            <For each={chapters()}>
              {(c) => (
                <div class="tg-chapter" style={{ "grid-column": `span ${c.scenes.length}` }} title={c.title}>{c.title}</div>
              )}
            </For>
            <div class="tg-gap-head" title="Longest stretch without this thread">Gap</div>

            <For each={threads.latest ?? []}>
              {(t, i) => (
                <>
                  <div class="tg-thread" style={{ "--thread": threadColor(t, i()) }}>
                    <span class="thread-swatch" />
                    <input
                      class="tg-name"
                      value={t.name}
                      onChange={(e) => void updateThread(t.id, { name: e.currentTarget.value })}
                      aria-label="Thread name"
                    />
                    <IconButton size="sm" label={`Delete “${t.name}”`} onClick={() => void deleteThread(t.id)}>
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                  <For each={sceneOrder()}>
                    {(file) => {
                      const on = () => detailsFor(file).threads.includes(t.id);
                      return (
                        <button
                          type="button"
                          class="tg-cell"
                          classList={{ on: on() }}
                          style={{ "--thread": threadColor(t, i()) }}
                          title={`${sceneName(file)} — ${on() ? "carries" : "doesn't carry"} “${t.name}”`}
                          onClick={() => void toggleThread(file, t.id)}
                          onDblClick={() => props.onOpenScene(file)}
                        />
                      );
                    }}
                  </For>
                  <div class="tg-gap" classList={{ long: longestGap(t.id) >= 5 }}>{longestGap(t.id) || "—"}</div>
                </>
              )}
            </For>
          </div>
          <p class="hint">Click a cell to mark a scene as carrying a thread · double-click to open the scene · a long gap is highlighted.</p>
        </Show>
      </section>
    </div>
  );
};
