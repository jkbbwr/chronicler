import { type Component, createEffect, createResource, createSignal, For, Show } from "solid-js";
import { Inbox } from "lucide-solid";

// Codex browser (right panel): a glanceable index of the world bible.
// Editing happens in center tabs (entity sheets / the Discovered inbox).

export const KINDS = ["character", "place", "item", "faction", "creature", "event", "lore"] as const;

interface Entity {
  id: number;
  name: string;
  kind: string;
  summary: string;
  aliases: string[];
  mentionCount: number;
}

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

export const CodexView: Component<CodexViewProps> = (props) => {
  const [filter, setFilter] = createSignal("");

  const [entities, { refetch: refetchEntities }] = createResource(async () => {
    try {
      const res = await window.chronicler.invoke("codex/list");
      return res.entities as Entity[];
    } catch {
      return [] as Entity[];
    }
  });
  const [inboxCount, { refetch: refetchInbox }] = createResource(async () => {
    try {
      const res = await window.chronicler.invoke("codex/candidates");
      return (res.candidates as unknown[]).length;
    } catch {
      return 0;
    }
  });

  createEffect((prev: number | undefined) => {
    const v = props.refreshVersion;
    if (prev !== undefined && v !== prev) {
      refetchEntities();
      refetchInbox();
    }
    return v;
  });

  // Editor selection promoted via context menu / Cmd+Shift+K
  createEffect(() => {
    const draft = props.promoteDraft;
    if (!draft) return;
    (async () => {
      try {
        await window.chronicler.invoke("codex/suggest", {
          name: draft.name,
          file: props.activeFile ?? "",
          line: draft.line,
          context: draft.name,
        });
        refetchInbox();
        props.onStatus(`"${draft.name}" added to Discovered`);
        props.onOpenInbox();
      } catch (err: any) {
        props.onStatus(`Promote failed: ${err.message}`);
      } finally {
        props.onDraftHandled();
      }
    })();
  });

  const grouped = () => {
    const q = filter().toLowerCase().trim();
    const matches = (e: Entity) =>
      !q ||
      e.name.toLowerCase().includes(q) ||
      e.aliases.some(a => a.toLowerCase().includes(q)) ||
      e.summary.toLowerCase().includes(q);
    const groups = new Map<string, Entity[]>();
    for (const e of (entities() ?? []).filter(matches)) {
      const list = groups.get(e.kind) ?? [];
      list.push(e);
      groups.set(e.kind, list);
    }
    return KINDS.filter(k => groups.has(k)).map(k => [k, groups.get(k)!] as const);
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "12px" }}>
      <div style={{ padding: "10px 12px 6px" }}>
        <input
          type="text"
          placeholder="Filter entities..."
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          style={{
            width: "100%", padding: "6px 8px", background: "var(--bg-color)",
            border: "1px solid var(--border-color)", color: "var(--text-main)",
            "border-radius": "4px", outline: "none", "font-size": "12px",
          }}
        />
      </div>

      <div
        onClick={props.onOpenInbox}
        style={{
          margin: "4px 12px 8px", padding: "7px 10px", display: "flex", "align-items": "center", gap: "8px",
          border: "1px solid var(--border-color)", "border-radius": "5px", cursor: "pointer",
          color: (inboxCount() ?? 0) > 0 ? "var(--accent)" : "var(--text-muted)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--hover-bg)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        <Inbox size={13} />
        <span style={{ flex: 1 }}>Discovered</span>
        <span style={{ "font-weight": 600 }}>{inboxCount() ?? 0}</span>
      </div>

      <div style={{ "overflow-y": "auto", flex: 1, padding: "0 0 10px" }}>
        <Show when={(entities() ?? []).length === 0}>
          <div style={{ padding: "8px 12px", color: "var(--text-faint)" }}>
            No entities yet. Review the Discovered inbox, or select a name in the editor and press Cmd+Shift+K.
          </div>
        </Show>
        <For each={grouped()}>
          {([kind, list]) => (
            <div style={{ "margin-bottom": "6px" }}>
              <div style={{ padding: "4px 12px", "font-size": "10px", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--text-faint)" }}>
                {kind}
              </div>
              <For each={list}>
                {(e) => (
                  <div
                    onClick={() => props.onOpenEntity(e.id, e.name)}
                    title={e.summary}
                    style={{ padding: "5px 12px", cursor: "pointer", display: "flex", "align-items": "center", gap: "8px" }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.backgroundColor = "var(--hover-bg)")}
                    onMouseLeave={(ev) => (ev.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <span style={{ flex: 1, color: "var(--text-main)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>{e.name}</span>
                    <span style={{ color: "var(--text-faint)", "font-size": "11px" }}>{e.mentionCount}</span>
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
