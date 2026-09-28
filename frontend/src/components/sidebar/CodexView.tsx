import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { Inbox, Plus } from "lucide-solid";
import { entities, codexSelection, type Entity } from "../../stores/codex";
import { createQuery, invalidate, invoke } from "../../lib/rpc";
import { IconButton } from "../ui";
import "./CodexView.css";

// The codex index: every entry by kind, the Discovered inbox, and a quick
// way to add someone. Pages open in the main area.

export const KINDS = ["character", "place", "item", "faction", "creature", "event", "lore"] as const;

const KIND_LABEL: Record<string, string> = {
  character: "Characters", place: "Places", item: "Things", faction: "Factions",
  creature: "Creatures", event: "Events", lore: "Lore",
};

interface CodexViewProps {
  activeFile: string | null;
  refreshVersion: number;
  /** Selection promoted from the editor, if any, with its cursor line. */
  promoteDraft: { name: string; line: number } | null;
  onDraftHandled: () => void;
  onOpenEntity: (id: number, title: string) => void;
  onOpenInbox: () => void;
  onStatus: (message: string) => void;
}

const inboxCount = createQuery(["codex"], async () => {
  try {
    return (await invoke("codex/candidates")).candidates.length;
  } catch {
    return 0;
  }
});

export const CodexView: Component<CodexViewProps> = (props) => {
  const [filter, setFilter] = createSignal("");
  const [adding, setAdding] = createSignal(false);

  // A selection sent from the editor lands in Discovered for review.
  createEffect(() => {
    const draft = props.promoteDraft;
    if (!draft) return;
    (async () => {
      try {
        await invoke("codex/suggest", { name: draft.name, file: props.activeFile ?? "", line: draft.line, context: draft.name });
        invalidate("codex");
        props.onStatus(`“${draft.name}” added to Discovered`);
        props.onOpenInbox();
      } catch (err) {
        props.onStatus(`Couldn't add it: ${err instanceof Error ? err.message : err}`);
      } finally {
        props.onDraftHandled();
      }
    })();
  });

  const create = async (name: string, kind: string) => {
    setAdding(false);
    if (!name.trim()) return;
    try {
      const res = await invoke("codex/create", { name: name.trim(), kind, summary: "", aliases: [] });
      invalidate("codex");
      props.onOpenEntity(res.id, name.trim());
    } catch (err) {
      props.onStatus(`Couldn't create the entry: ${err instanceof Error ? err.message : err}`);
    }
  };

  const grouped = () => {
    const q = filter().toLowerCase().trim();
    const matches = (e: Entity) =>
      !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q)) || e.summary.toLowerCase().includes(q);
    const groups = new Map<string, Entity[]>();
    for (const e of (entities.latest ?? []).filter(matches)) {
      if (!groups.has(e.kind)) groups.set(e.kind, []);
      groups.get(e.kind)!.push(e);
    }
    const order = [...KINDS, ...[...groups.keys()].filter((k) => !(KINDS as readonly string[]).includes(k))];
    return order.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)!.sort((a, b) => b.mentionCount - a.mentionCount)] as const);
  };

  const selectedId = () => {
    const s = codexSelection();
    return s?.kind === "entity" ? s.id : null;
  };

  return (
    <div class="codex-index">
      <div class="codex-search">
        <input class="input" placeholder="Find in the codex…" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        <IconButton label="New entry" onClick={() => setAdding(true)}><Plus size={15} /></IconButton>
      </div>

      <Show when={adding()}>
        <form class="codex-add" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void create(String(f.get("name") ?? ""), String(f.get("kind") ?? "character"));
        }}>
          <input class="input" name="name" placeholder="Name" ref={(el) => queueMicrotask(() => el.focus())} onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }} />
          <select class="input" name="kind">
            <For each={KINDS}>{(k) => <option value={k}>{k}</option>}</For>
          </select>
        </form>
      </Show>

      <div class="list-row codex-inbox" classList={{ active: codexSelection()?.kind === "inbox", pending: (inboxCount.latest ?? 0) > 0 }} onClick={props.onOpenInbox}>
        <Inbox size={14} />
        <span>Discovered</span>
        <span class="count-badge">{inboxCount.latest ?? 0}</span>
      </div>

      <div class="codex-list">
        <Show when={(entities.latest ?? []).length === 0}>
          <p class="hint codex-hint">
            Nothing here yet. Review Discovered — names the manuscript has turned up — or select a name in the text and press ⌘⇧K.
          </p>
        </Show>
        <For each={grouped()}>
          {([kind, list]) => (
            <div>
              <div class="section-label">{KIND_LABEL[kind] ?? kind}<span class="row-meta">{list.length}</span></div>
              <For each={list}>
                {(e) => (
                  <div class="list-row codex-entry" classList={{ active: selectedId() === e.id }} title={e.summary} onClick={() => props.onOpenEntity(e.id, e.name)}>
                    <span class="codex-name">{e.name}</span>
                    <span class="row-meta" title="Mentions in the manuscript">{e.mentionCount}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
