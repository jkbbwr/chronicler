import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
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
  { id: "", label: "No status", color: "transparent" },
  { id: "idea", label: "Idea", color: "#8b949e" },
  { id: "draft", label: "Draft", color: "#e5c07b" },
  { id: "revised", label: "Revised", color: "#61afef" },
  { id: "final", label: "Final", color: "#98c379" },
];

export const statusColor = (id: string) =>
  STATUSES.find((s) => s.id === id)?.color ?? "transparent";

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

  const [chapters, { refetch }] = createResource(
    () => props.refreshVersion,
    async () => {
      try {
        const res = await window.chronicler.invoke("project/list_files");
        let order: OrderMap = {};
        try {
          const o = await window.chronicler.invoke("document/read", { rel_path: ORDER_FILE });
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
        await window.chronicler.invoke("meta/set", { file, ...merged });
        props.onMetaChanged();
      } catch (err: any) {
        props.onStatus(`Saving scene details failed: ${err.message}`);
      }
    }, debounce));
  };

  const [drafting, setDrafting] = createSignal(false);
  const draftMissing = async () => {
    setDrafting(true);
    props.onStatus("Agent: drafting synopses for scenes without one...");
    try {
      const res = await window.chronicler.invoke("agents/synopses", {});
      props.onStatus(`Drafted ${res.drafted} synopsis(es)`);
      props.onMetaChanged();
    } catch (err: any) {
      props.onStatus(`Synopsis drafting failed: ${err.message}`);
    } finally {
      setDrafting(false);
      refetch();
    }
  };

  return (
    <div style={{ height: "100%", "overflow-y": "auto", padding: "24px 32px" }}>
      <div style={{ display: "flex", "justify-content": "flex-end", "margin-bottom": "12px" }}>
        <button
          onClick={draftMissing} disabled={drafting()}
          title="The agent writes a synopsis for every card that has none"
          style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border-color)", color: "var(--text-muted)", "border-radius": "6px", cursor: "pointer", "font-size": "12px", opacity: drafting() ? 0.6 : 1 }}
        >
          {drafting() ? "Drafting…" : "Draft missing synopses"}
        </button>
      </div>
      <Show when={(chapters() ?? []).length === 0}>
        <div style={{ color: "var(--text-faint)", "font-size": "13px" }}>No scenes yet.</div>
      </Show>
      <For each={chapters() ?? []}>
        {(chapter) => (
          <div style={{ "margin-bottom": "28px" }}>
            <div style={{ "font-size": "12px", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.7px", color: "var(--text-muted)", "margin-bottom": "10px" }}>
              {chapter.title}
            </div>
            <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))", gap: "14px" }}>
              <For each={chapter.scenes}>
                {(file) => (
                  <div style={{
                    border: "1px solid var(--border-color)", "border-radius": "6px",
                    background: "var(--bg-secondary, transparent)", display: "flex",
                    "flex-direction": "column", "min-height": "150px", overflow: "hidden",
                  }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px 10px", "border-bottom": "1px solid var(--border-color)" }}>
                      <span
                        style={{ width: "8px", height: "8px", "border-radius": "50%", "flex-shrink": 0,
                          background: statusColor(meta[file]?.status ?? ""),
                          border: (meta[file]?.status ?? "") === "" ? "1px solid var(--border-color)" : "none" }}
                        title={STATUSES.find(s => s.id === (meta[file]?.status ?? ""))?.label}
                      />
                      <span
                        onClick={() => props.onOpenScene(file)}
                        title={file}
                        style={{ "font-size": "13px", "font-weight": 600, color: "var(--text-main)", cursor: "pointer", overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis", flex: 1 }}
                      >
                        {sceneName(file)}
                      </span>
                      <select
                        value={meta[file]?.status ?? ""}
                        onChange={(e) => saveMeta(file, { status: e.currentTarget.value })}
                        style={{ background: "transparent", color: "var(--text-muted)", border: "none", "font-size": "11px", cursor: "pointer", outline: "none" }}
                      >
                        <For each={STATUSES}>{(s) => <option value={s.id}>{s.label}</option>}</For>
                      </select>
                    </div>
                    <textarea
                      value={meta[file]?.synopsis ?? ""}
                      onInput={(e) => saveMeta(file, { synopsis: e.currentTarget.value }, 600)}
                      placeholder="What happens in this scene?"
                      style={{
                        flex: 1, resize: "none", border: "none", outline: "none", background: "transparent",
                        color: "var(--text-muted)", padding: "10px", "font-size": "12.5px", "line-height": "1.6",
                        "font-family": "inherit", "min-height": "90px",
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
};
