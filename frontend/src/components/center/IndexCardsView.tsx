import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { Sparkles } from "lucide-solid";
import { stats } from "../../stores/stats";
import { detailsFor, sceneOrder, threadColor, threads } from "../../stores/story";
import { entities } from "../../stores/codex";
import { draftSynopses } from "../../lib/agentActions";
import { Button, Empty } from "../ui";
import "./IndexCardsView.css";
import {
  buildTree,
  buildCompileChapters,
  chapterName,
  ORDER_FILE,
  type FileEntry,
  type OrderMap,
} from "../../lib/binderTree";

// Index cards: a corkboard of every scene with its synopsis and status.
// Synopses live in the project db (scene_meta), not the prose files.

export const STATUSES = [
  { id: "", label: "No status" },
  { id: "idea", label: "Idea" },
  { id: "draft", label: "Draft" },
  { id: "revised", label: "Revised" },
  { id: "final", label: "Final" },
];

interface SceneMeta {
  synopsis: string;
  status: string;
}

interface IndexCardsProps {
  refreshVersion: number;
  onOpenScene: (file: string) => void;
  onStatus: (m: string) => void;
  /** Called after a status/synopsis write so the binder can refresh its dots. */
  onMetaChanged: () => void;
}

const sceneName = (path: string) => chapterName(path.split("/").pop()!.replace(/\.md$/, ""));

export const IndexCardsView: Component<IndexCardsProps> = (props) => {
  const [meta, setMeta] = createStore<Record<string, SceneMeta>>({});

  // Wrapped: a bare version number of 0 is falsy and would never fetch.
  const [chapters, { refetch }] = createResource(
    () => ({ v: props.refreshVersion }),
    async () => {
      try {
        const res = await window.chronicler.invoke("project/list_files");
        let order: OrderMap = {};
        try {
          const o = await window.chronicler.invoke("document/read", { path: ORDER_FILE });
          order = JSON.parse(o.content);
        } catch { /* no order file yet */ }
        const metaRes = await window.chronicler.invoke("meta/get_all");
        const map: Record<string, SceneMeta> = {};
        for (const row of metaRes.meta) map[row.file] = { synopsis: row.synopsis, status: row.status };
        setMeta(reconcile(map));
        return buildCompileChapters(buildTree(res.files as FileEntry[], order));
      } catch {
        return [];
      }
    }
  );

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, Partial<SceneMeta>>();
  const saveMeta = (file: string, patch: Partial<SceneMeta>, debounce = 0) => {
    setMeta(file, (m) => ({ synopsis: m?.synopsis ?? "", status: m?.status ?? "", ...patch }));
    // Merge into any not-yet-flushed patch: a quick status change followed by
    // synopsis typing must not cancel the status write.
    pending.set(file, { ...pending.get(file), ...patch });
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(async () => {
      const merged = pending.get(file);
      pending.delete(file);
      try {
        await window.chronicler.invoke("meta/set", { path: file, ...merged });
        props.onMetaChanged();
      } catch (err: any) {
        props.onStatus(`Saving scene details failed: ${err.message}`);
      }
    }, debounce));
  };

  const [drafting, setDrafting] = createSignal(false);
  // Through the shared action, so the writer sees what it costs first.
  const draftMissing = async () => {
    setDrafting(true);
    try {
      await draftSynopses();
    } finally {
      setDrafting(false);
      refetch();
    }
  };

  const words = () => Object.fromEntries((stats()?.files ?? []).map((f) => [f.file, f.words]));

  // Filters: point of view, location, thread, status ("" = any).
  const [filter, setFilter] = createStore({ pov: 0, location: 0, thread: 0, status: "" });
  const filtering = () => !!(filter.pov || filter.location || filter.thread || filter.status);
  const shown = (file: string) => {
    const d = detailsFor(file);
    return (!filter.pov || d.pov === filter.pov)
      && (!filter.location || d.location === filter.location)
      && (!filter.thread || d.threads.includes(filter.thread))
      && (!filter.status || (meta[file]?.status ?? "") === filter.status);
  };
  const entityName = (id: number | null) => (id ? (entities.latest ?? []).find((e) => e.id === id)?.name : undefined);
  const used = (key: "pov" | "location") =>
    [...new Set(sceneOrder().map((f) => detailsFor(f)[key]).filter((id): id is number => !!id))]
      .map((id) => ({ id, name: entityName(id) ?? "?" }));

  return (
    <div class="corkboard">
      <div class="corkboard-bar">
        <div class="card-filters">
          <select class="input" value={filter.pov} onChange={(e) => setFilter("pov", +e.currentTarget.value)} aria-label="Point of view">
            <option value={0}>Any point of view</option>
            <For each={used("pov")}>{(o) => <option value={o.id}>{o.name}</option>}</For>
          </select>
          <select class="input" value={filter.location} onChange={(e) => setFilter("location", +e.currentTarget.value)} aria-label="Location">
            <option value={0}>Anywhere</option>
            <For each={used("location")}>{(o) => <option value={o.id}>{o.name}</option>}</For>
          </select>
          <select class="input" value={filter.thread} onChange={(e) => setFilter("thread", +e.currentTarget.value)} aria-label="Thread">
            <option value={0}>Any thread</option>
            <For each={threads.latest ?? []}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
          <select class="input" value={filter.status} onChange={(e) => setFilter("status", e.currentTarget.value)} aria-label="Status">
            <option value="">Any status</option>
            <For each={STATUSES.filter((st) => st.id)}>{(st) => <option value={st.id}>{st.label}</option>}</For>
          </select>
          <Show when={filtering()}>
            <Button size="sm" variant="ghost" onClick={() => setFilter({ pov: 0, location: 0, thread: 0, status: "" })}>Clear</Button>
          </Show>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void draftMissing()} disabled={drafting()} title="The agent writes a synopsis for every card that has none">
          <Sparkles size={12} /> {drafting() ? "Drafting…" : "Draft missing synopses"}
        </Button>
      </div>
      <Show when={(chapters.latest ?? []).length === 0}>
        <Empty title="No scenes yet">Create a scene in Write to start the board.</Empty>
      </Show>
      <For each={chapters.latest ?? []}>
        {(chapter) => (
          <section class="corkboard-chapter">
            <h3>{chapter.title}</h3>
            <div class="corkboard-grid">
              <For each={chapter.scenes.filter(shown)}>
                {(file) => (
                  <article class="index-card" data-status={meta[file]?.status ?? ""}>
                    <header>
                      <button type="button" class="index-card-title" title={`Write ${file}`} onClick={() => props.onOpenScene(file)}>
                        {sceneName(file)}
                      </button>
                      <select
                        class="index-card-status"
                        value={meta[file]?.status ?? ""}
                        onChange={(e) => saveMeta(file, { status: e.currentTarget.value })}
                        aria-label="Status"
                      >
                        <For each={STATUSES}>{(st) => <option value={st.id}>{st.label}</option>}</For>
                      </select>
                    </header>
                    <textarea
                      class="index-card-synopsis"
                      value={meta[file]?.synopsis ?? ""}
                      onInput={(e) => saveMeta(file, { synopsis: e.currentTarget.value }, 600)}
                      placeholder="What happens in this scene?"
                    />
                    <footer class="index-card-foot">
                      <span class="index-card-tags">
                        <Show when={entityName(detailsFor(file).pov)}>{(n) => <span class="card-tag" title="Point of view">{n()}</span>}</Show>
                        <Show when={detailsFor(file).storyTime}><span class="card-tag" title="Story time">{detailsFor(file).storyTime}</span></Show>
                        <For each={detailsFor(file).threads}>
                          {(id) => {
                            const i = () => (threads.latest ?? []).findIndex((t) => t.id === id);
                            const t = () => (threads.latest ?? [])[i()];
                            return <Show when={t()}><span class="card-thread" title={t()!.name} style={{ background: threadColor(t()!, i()) }} /></Show>;
                          }}
                        </For>
                      </span>
                      <span class="hint">
                        {(words()[file] ?? 0).toLocaleString()}
                        <Show when={detailsFor(file).target > 0}> / {detailsFor(file).target.toLocaleString()}</Show> words
                      </span>
                    </footer>
                  </article>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
};
