import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { Trash2 } from "lucide-solid";
import { KINDS } from "../sidebar/CodexView";

// A codex entity opened as a center tab: room to actually write about the
// character/place/etc., plus its mention index.

interface EntitySheetProps {
  entityId: number;
  onTitleChange: (title: string) => void;
  onOpenFile: (file: string, line: number) => void;
  onStatus: (message: string) => void;
  onDeleted: () => void;
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
              <input style={input} value={e().summary} placeholder="One line you'd want at a glance" onChange={(ev) => save({ summary: ev.currentTarget.value })} />
            </div>

            <div style={{ "margin-bottom": "28px" }}>
              <label style={fieldLabel}>Notes</label>
              <textarea
                style={{ ...input, "min-height": "260px", resize: "vertical", "line-height": "1.6", "font-family": "inherit" }}
                value={e().body}
                placeholder="Everything the manuscript needs you to remember."
                onChange={(ev) => save({ body: ev.currentTarget.value })}
              />
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
