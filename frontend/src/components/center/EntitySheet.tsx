import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { Search, Trash2 } from "lucide-solid";
import { KINDS } from "../sidebar/CodexView";
import { parseSceneHref, renderMarkdown } from "../../lib/markdown";

// A codex entity opened as a center tab: room to actually write about the
// character/place/etc., plus its mention index.

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

const fieldLabel = {
  display: "block", "margin-bottom": "6px", "font-size": "12px",
  color: "var(--text-muted)", "text-transform": "uppercase" as const,
  "letter-spacing": "0.5px", "font-weight": 600,
} as const;

const input = {
  width: "100%", padding: "9px 11px", background: "var(--panel-bg)",
  border: "1px solid var(--border-color)", color: "var(--text-main)",
  "border-radius": "6px", outline: "none", "font-size": "14px",
} as const;

export const EntitySheet: Component<EntitySheetProps> = (props) => {
  const [saved, setSaved] = createSignal("");
  const [filling, setFilling] = createSignal<"summary" | "body" | null>(null);
  // Notes are markdown: rendered at rest, raw while editing
  const [editingNotes, setEditingNotes] = createSignal(false);

  const [entity, { refetch }] = createResource(
    () => [props.entityId, props.refreshVersion] as const,
    async ([id]) => {
      try {
        const res = await window.chronicler.invoke("codex/list");
        return (res.entities as any[]).find(e => e.id === id) ?? null;
      } catch {
        return null;
      }
    }
  );

  const [mentions] = createResource(
    () => [props.entityId, props.refreshVersion] as const,
    async ([id]) => {
      try {
        const res = await window.chronicler.invoke("codex/mentions", { id });
        return res.mentions as { file: string; line: number }[];
      } catch {
        return [];
      }
    }
  );

  const save = async (fields: Record<string, unknown>) => {
    try {
      await window.chronicler.invoke("codex/update", { id: props.entityId, ...fields });
      if (typeof fields.name === "string") props.onTitleChange(fields.name);
      setSaved("Saved");
      setTimeout(() => setSaved(""), 1200);
      refetch();
    } catch (err: any) {
      props.onStatus(`Save failed: ${err.message}`);
    }
  };

  // Ask the agent to draft this field from the manuscript's own passages
  const fill = async (field: "summary" | "body") => {
    if (filling()) return;
    setFilling(field);
    props.onStatus(`Drafting ${field === "body" ? "notes" : "summary"} from the manuscript...`);
    try {
      const res = await window.chronicler.invoke("agents/fill", { id: props.entityId, field });
      await save({ [field]: res.text });
      props.onStatus(`Drafted ${field === "body" ? "notes" : "summary"} — edit freely, nothing is sacred`);
    } catch (err: any) {
      props.onStatus(`Draft failed: ${err.message}`);
    } finally {
      setFilling(null);
    }
  };

  const FillButton: Component<{ field: "summary" | "body" }> = (p) => (
    <button
      onClick={() => fill(p.field)}
      title="Draft from manuscript — the agent reads every mention and fills this in"
      disabled={!!filling()}
      style={{
        position: "absolute", top: "7px", right: "7px",
        display: "flex", "align-items": "center", "justify-content": "center",
        width: "24px", height: "24px", padding: 0,
        background: "var(--panel-bg)", border: "1px solid var(--border-color)",
        "border-radius": "5px", cursor: filling() ? "wait" : "pointer",
        color: filling() === p.field ? "var(--accent)" : "var(--text-faint)",
        opacity: filling() && filling() !== p.field ? 0.4 : 1,
      }}
      onMouseEnter={(ev) => { if (!filling()) ev.currentTarget.style.color = "var(--accent)"; }}
      onMouseLeave={(ev) => { if (!filling()) ev.currentTarget.style.color = "var(--text-faint)"; }}
    >
      <Search
        size={13}
        style={filling() === p.field ? { animation: "pulse 1s ease-in-out infinite" } : {}}
      />
    </button>
  );

  const remove = async () => {
    const e = entity();
    if (!e) return;
    const r = await window.chronicler.showMessageBox({
      type: "warning", buttons: ["Delete", "Cancel"], defaultId: 1, cancelId: 1,
      message: `Delete "${e.name}" from the codex?`,
      detail: "Mentions are removed too. The manuscript itself is untouched.",
    });
    if (r.response !== 0) return;
    await window.chronicler.invoke("codex/delete", { id: props.entityId });
    props.onDeleted();
  };

  return (
    <div style={{ height: "100%", "overflow-y": "auto" }}>
      <Show when={entity()} fallback={<div style={{ padding: "40px", color: "var(--text-faint)" }}>Entity not found — it may have been deleted.</div>}>
        {(e) => (
          <div style={{ "max-width": "720px", margin: "0 auto", padding: "36px 40px" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "12px", "margin-bottom": "28px" }}>
              <input
                style={{ ...input, "font-size": "22px", "font-weight": 600, background: "transparent", border: "none", padding: "0" }}
                value={e().name}
                onChange={(ev) => save({ name: ev.currentTarget.value })}
              />
              <span style={{ "font-size": "12px", color: "var(--accent)", "min-width": "48px" }}>{saved()}</span>
              <Show when={e().kind === "character"}>
                <button
                  onClick={() => props.onVoiceReport(props.entityId, e().name)}
                  title="Agent voice report — how this character sounds across the manuscript"
                  style={{ padding: "5px 12px", background: "transparent", border: "1px solid var(--border-color)", color: "var(--text-muted)", "border-radius": "6px", cursor: "pointer", "font-size": "12px", "flex-shrink": 0 }}
                >
                  Voice report
                </button>
              </Show>
              <Trash2 size={16} style={{ cursor: "pointer", color: "var(--text-faint)", "flex-shrink": 0 }} onClick={remove} />
            </div>

            <div style={{ display: "grid", "grid-template-columns": "180px 1fr", gap: "20px", "margin-bottom": "24px" }}>
              <div>
                <label style={fieldLabel}>Kind</label>
                <select style={input} value={e().kind} onChange={(ev) => save({ kind: ev.currentTarget.value })}>
                  <For each={[...KINDS]}>{(k) => <option value={k}>{k}</option>}</For>
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Aliases <span style={{ "text-transform": "none", "font-weight": 400 }}>(comma-separated — nicknames, titles, epithets)</span></label>
                <input
                  style={input}
                  value={(e().aliases as string[]).join(", ")}
                  onChange={(ev) => save({ aliases: ev.currentTarget.value.split(",").map((s: string) => s.trim()).filter(Boolean) })}
                />
              </div>
            </div>

            <div style={{ "margin-bottom": "24px" }}>
              <label style={fieldLabel}>Summary</label>
              <div style={{ position: "relative" }}>
                <input
                  style={{ ...input, "padding-right": "38px" }}
                  value={filling() === "summary" ? "Reading the manuscript…" : e().summary}
                  disabled={filling() === "summary"}
                  placeholder="One line you'd want at a glance"
                  onChange={(ev) => save({ summary: ev.currentTarget.value })}
                />
                <FillButton field="summary" />
              </div>
            </div>

            <div style={{ "margin-bottom": "28px" }}>
              <label style={fieldLabel}>
                Notes <span style={{ "text-transform": "none", "font-weight": 400 }}>(markdown — click to edit)</span>
              </label>
              <div style={{ position: "relative" }}>
                <Show
                  when={editingNotes() || filling() === "body" || !(e().body ?? "").trim()}
                  fallback={
                    <div
                      class="agent-md"
                      innerHTML={renderMarkdown(e().body)}
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
                      style={{
                        ...input, "min-height": "260px", "padding-right": "38px",
                        cursor: "text", "line-height": "1.6", "font-size": "13.5px",
                      }}
                    />
                  }
                >
                  <textarea
                    ref={(el) => queueMicrotask(() => { if (editingNotes()) el.focus(); })}
                    style={{ ...input, "min-height": "260px", resize: "vertical", "line-height": "1.6", "font-family": "inherit", "padding-right": "38px" }}
                    value={filling() === "body" ? "Reading every mention and drafting notes…" : e().body}
                    disabled={filling() === "body"}
                    placeholder="Everything the manuscript needs you to remember. Markdown renders."
                    onChange={(ev) => save({ body: ev.currentTarget.value })}
                    onBlur={() => setEditingNotes(false)}
                  />
                </Show>
                <FillButton field="body" />
              </div>
            </div>

            <div>
              <label style={fieldLabel}>Mentions ({(mentions() ?? []).length})</label>
              <Show when={(mentions() ?? []).length === 0}>
                <div style={{ color: "var(--text-faint)", "font-size": "13px" }}>Not mentioned in the manuscript yet.</div>
              </Show>
              <For each={mentions() ?? []}>
                {(m) => (
                  <div
                    onClick={() => props.onOpenFile(m.file, m.line)}
                    style={{ padding: "5px 0", cursor: "pointer", color: "var(--text-muted)", "font-size": "13px" }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.color = "var(--accent)")}
                    onMouseLeave={(ev) => (ev.currentTarget.style.color = "var(--text-muted)")}
                  >
                    {m.file} · line {m.line}
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};
