import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { Sparkles, Trash2, AudioLines } from "lucide-solid";
import { KINDS } from "../sidebar/CodexView";
import { parseSceneHref, renderMarkdown } from "../../lib/markdown";
import { createQuery, invalidate, invoke } from "../../lib/rpc";
import { entities } from "../../stores/codex";
import { chapterOf, flush, sceneName } from "../../stores/documents";
import type { RenamePreview } from "../../rpc.gen";
import { Button, Empty, IconButton } from "../ui";
import { RenameModal } from "./RenameModal";
import "./CodexPage.css";

// A codex entry as a page: who or what it is, your notes, and everywhere it
// appears in the manuscript.

interface EntitySheetProps {
  entityId: number;
  onTitleChange: (title: string) => void;
  onOpenFile: (file: string, line: number) => void;
  onStatus: (message: string) => void;
  onDeleted: () => void;
  /** Run the agent's voice analysis for this character. */
  onVoiceReport: (id: number, name: string) => void;
  refreshVersion: number;
}

export const EntitySheet: Component<EntitySheetProps> = (props) => {
  const [filling, setFilling] = createSignal<"summary" | "body" | null>(null);
  const [editingNotes, setEditingNotes] = createSignal(false);

  const entity = () => (entities.latest ?? []).find((e) => e.id === props.entityId) as
    | { id: number; name: string; kind: string; summary: string; body?: string; aliases: string[] }
    | undefined;

  const mentions = createQuery(["codex"], async (id: number) => {
    try {
      return (await invoke("codex/mentions", { id })).mentions;
    } catch {
      return [];
    }
  }, () => props.entityId);

  /** Mentions grouped by scene, in manuscript order. */
  const byScene = createMemo(() => {
    const map = new Map<string, number[]>();
    for (const m of mentions.latest ?? []) {
      if (!map.has(m.file)) map.set(m.file, []);
      map.get(m.file)!.push(m.line);
    }
    return [...map.entries()];
  });

  const save = async (fields: Record<string, unknown>) => {
    try {
      await invoke("codex/update", { id: props.entityId, ...fields });
      if (typeof fields.name === "string") props.onTitleChange(fields.name);
      invalidate("codex");
    } catch (err) {
      props.onStatus(`Couldn't save: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Renaming (or changing one other name) offers to carry the change through
  // the manuscript; with nothing written under the old name it just saves.
  const [renaming, setRenaming] = createSignal<{ from: string; to: string; preview: RenamePreview } | null>(null);
  let nameInput!: HTMLInputElement;
  let aliasInput!: HTMLInputElement;

  const rename = async (from: string, to: string, plain: Record<string, unknown>) => {
    try {
      // The preview reads the saved text; save what's typed first.
      if (!(await flush())) throw new Error("the open scenes couldn't be saved");
      const preview = await invoke("codex/rename_preview", { id: props.entityId, from, to });
      if (preview.total > 0) return setRenaming({ from, to, preview });
    } catch (err) {
      props.onStatus(`Couldn't rename: ${err instanceof Error ? err.message : err}`);
      return cancelRename();
    }
    await save(plain);
  };

  const onName = (value: string) => {
    const from = entity()?.name ?? "";
    const to = value.trim();
    if (!to || to === from) return void (nameInput.value = from);
    void rename(from, to, { name: to });
  };

  const onAliases = (value: string) => {
    const before = entity()?.aliases ?? [];
    const after = value.split(",").map((s) => s.trim()).filter(Boolean);
    const removed = before.filter((a) => !after.includes(a));
    const added = after.filter((a) => !before.includes(a));
    // Exactly one name swapped for another reads as a rename of that name.
    if (removed.length === 1 && added.length === 1) void rename(removed[0], added[0], { aliases: after });
    else void save({ aliases: after });
  };

  const renamed = (from: string, to: string, filesChanged: number, replaced: number) => {
    setRenaming(null);
    if (nameInput.value === to) props.onTitleChange(to);
    props.onStatus(
      replaced > 0
        ? `Renamed “${from}” to “${to}” in ${replaced} place${replaced === 1 ? "" : "s"} across ${filesChanged} scene${filesChanged === 1 ? "" : "s"}`
        : `Renamed “${from}” to “${to}” in the codex`,
    );
  };

  const cancelRename = () => {
    setRenaming(null);
    const e = entity();
    if (!e) return;
    nameInput.value = e.name;
    aliasInput.value = e.aliases.join(", ");
  };

  // The agent drafts a field from the manuscript's own passages.
  const fill = async (field: "summary" | "body") => {
    if (filling()) return;
    setFilling(field);
    props.onStatus(`Reading every mention to draft the ${field === "body" ? "notes" : "summary"}…`);
    try {
      const res = await invoke("agents/fill", { id: props.entityId, field });
      await save({ [field]: res.text });
      props.onStatus(`Drafted the ${field === "body" ? "notes" : "summary"} — edit freely`);
    } catch (err) {
      props.onStatus(`Drafting failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setFilling(null);
    }
  };

  const remove = async () => {
    const e = entity();
    if (!e) return;
    const r = await window.chronicler.showMessageBox({
      type: "warning", buttons: ["Delete", "Cancel"], defaultId: 1, cancelId: 1,
      message: `Delete “${e.name}” from the codex?`,
      detail: "The manuscript itself is untouched.",
    });
    if (r.response !== 0) return;
    await invoke("codex/delete", { id: props.entityId });
    props.onDeleted();
  };

  return (
    <Show when={entity()} fallback={<Empty title="Not found">This entry may have been deleted.</Empty>}>
      {(e) => (
        <div class="codex-page entity-page">
          <header class="entity-header">
            <input ref={nameInput} class="entity-name" value={e().name} onChange={(ev) => onName(ev.currentTarget.value)} aria-label="Name" />
            <div class="entity-tools">
              <Show when={e().kind === "character"}>
                <Button size="sm" variant="ghost" onClick={() => props.onVoiceReport(props.entityId, e().name)} title="How this character sounds across the manuscript">
                  <AudioLines size={13} /> Voice
                </Button>
              </Show>
              <IconButton label="Delete from the codex" onClick={() => void remove()}><Trash2 size={15} /></IconButton>
            </div>
          </header>

          <div class="entity-meta">
            <select class="entity-kind" value={e().kind} onChange={(ev) => void save({ kind: ev.currentTarget.value })} aria-label="Kind">
              <For each={[...KINDS]}>{(k) => <option value={k}>{k}</option>}</For>
            </select>
            <input
              ref={aliasInput}
              class="entity-aliases"
              value={e().aliases.join(", ")}
              placeholder="Also known as… (comma-separated)"
              onChange={(ev) => onAliases(ev.currentTarget.value)}
              aria-label="Other names"
            />
          </div>

          <section class="entity-section">
            <div class="entity-section-head">
              <h4>Summary</h4>
              <Button size="sm" variant="ghost" disabled={!!filling()} onClick={() => void fill("summary")} title="The agent reads every mention and drafts this">
                <Sparkles size={12} /> {filling() === "summary" ? "Reading…" : "Draft from the manuscript"}
              </Button>
            </div>
            <textarea
              class="entity-summary"
              rows={2}
              value={filling() === "summary" ? "Reading the manuscript…" : e().summary}
              disabled={filling() === "summary"}
              placeholder="The line you'd want at a glance"
              onChange={(ev) => void save({ summary: ev.currentTarget.value })}
            />
          </section>

          <section class="entity-section">
            <div class="entity-section-head">
              <h4>Notes</h4>
              <Button size="sm" variant="ghost" disabled={!!filling()} onClick={() => void fill("body")} title="The agent reads every mention and drafts notes">
                <Sparkles size={12} /> {filling() === "body" ? "Reading…" : "Draft from the manuscript"}
              </Button>
            </div>
            <Show
              when={editingNotes() || filling() === "body" || !(e().body ?? "").trim()}
              fallback={
                <div
                  class="agent-md entity-notes selectable"
                  innerHTML={renderMarkdown(e().body ?? "")}
                  title="Click to edit"
                  onClick={(ev) => {
                    const a = (ev.target as HTMLElement).closest("a");
                    if (a) {
                      ev.preventDefault();
                      const scene = parseSceneHref(a.getAttribute("href") ?? "");
                      if (scene) props.onOpenFile(scene.path, scene.line ?? 1);
                      return;
                    }
                    setEditingNotes(true);
                  }}
                />
              }
            >
              <textarea
                class="entity-notes-input"
                ref={(el) => queueMicrotask(() => { if (editingNotes()) el.focus(); })}
                value={filling() === "body" ? "Reading every mention and drafting notes…" : e().body ?? ""}
                disabled={filling() === "body"}
                placeholder="Everything the manuscript needs you to remember. Markdown works."
                onChange={(ev) => void save({ body: ev.currentTarget.value })}
                onBlur={() => setEditingNotes(false)}
              />
            </Show>
          </section>

          <section class="entity-section entity-appears">
            <div class="entity-section-head">
              <h4>Appears in</h4>
              <span class="hint">{(mentions.latest ?? []).length} mention{(mentions.latest ?? []).length === 1 ? "" : "s"}</span>
            </div>
            <Show when={byScene().length > 0} fallback={<p class="hint">Not in the manuscript yet.</p>}>
              <For each={byScene()}>
                {([file, lines]) => (
                  <div class="list-row" onClick={() => props.onOpenFile(file, lines[0])} title={`Open at the first mention (line ${lines[0]})`}>
                    <span class="codex-name">{sceneName(file)}</span>
                    <span class="hint">{chapterOf(file)}</span>
                    <span class="row-meta">{lines.length}</span>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <Show when={renaming()}>
            {(r) => (
              <RenameModal
                entityId={props.entityId}
                from={r().from}
                to={r().to}
                preview={r().preview}
                onDone={(res) => renamed(r().from, r().to, res.filesChanged, res.replaced)}
                onClose={cancelRename}
              />
            )}
          </Show>
        </div>
      )}
    </Show>
  );
};
