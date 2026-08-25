import { type Component, createEffect, createResource, createSignal, For, Show } from "solid-js";
import { ArrowLeft, Download, ScanSearch, Sparkles, Trash2, X } from "lucide-solid";

// The Codex: the project's world bible. Entities live in .chronicler/db;
// the Discovered inbox collects NER / LLM / manual candidates for review.

export const KINDS = ["character", "place", "item", "faction", "creature", "event", "lore"] as const;

interface Entity {
  id: number;
  name: string;
  kind: string;
  summary: string;
  body: string;
  aliases: string[];
  mentionCount: number;
}

interface CandidateRow {
  name: string;
  kindGuess: string;
  count: number;
  files: string[];
  contexts: string[];
  source: string;
  summary: string;
}

interface CodexViewProps {
  activeFile: string | null;
  refreshVersion: number;
  /** Selection text promoted from the editor, if any. */
  promoteDraft: string | null;
  onDraftHandled: () => void;
  onOpenFile: (file: string, line: number) => void;
  onStatus: (message: string) => void;
}

const inputStyle = {
  width: "100%", padding: "6px 8px", background: "var(--bg-color)",
  border: "1px solid var(--border-color)", color: "var(--text-main)",
  "border-radius": "4px", outline: "none", "font-size": "12px",
} as const;

const badgeStyle = (kind: string) => ({
  "font-size": "10px", padding: "1px 6px", "border-radius": "8px",
  border: "1px solid var(--border-color)", color: "var(--text-muted)",
  "text-transform": "uppercase" as const, "letter-spacing": "0.5px",
  opacity: kind ? 1 : 0.5,
});

export const CodexView: Component<CodexViewProps> = (props) => {
  const [tab, setTab] = createSignal<"entities" | "inbox">("entities");
  const [selected, setSelected] = createSignal<Entity | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  // Fetchers swallow errors (returning empty) so a panel mounted while the
  // backend is restarting recovers on the next refetch instead of wedging.
  const [entities, { refetch: refetchEntities }] = createResource(async () => {
    try {
      const res = await window.chronicler.invoke("codex/list");
      return res.entities as Entity[];
    } catch {
      return [] as Entity[];
    }
  });
  const [candidates, { refetch: refetchCandidates }] = createResource(async () => {
    try {
      const res = await window.chronicler.invoke("codex/candidates");
      return res.candidates as CandidateRow[];
    } catch {
      return [] as CandidateRow[];
    }
  });
  const [nerStatus, { refetch: refetchNer }] = createResource(async () => {
    try {
      return await window.chronicler.invoke("ner/status");
    } catch {
      return { ready: false };
    }
  });
  const [mentions] = createResource(
    () => selected()?.id,
    async (id) => {
      try {
        const res = await window.chronicler.invoke("codex/mentions", { id });
        return res.mentions as { file: string; line: number }[];
      } catch {
        return [] as { file: string; line: number }[];
      }
    }
  );

  const refreshAll = () => {
    refetchEntities();
    refetchCandidates();
  };

  createEffect((prev: number | undefined) => {
    const v = props.refreshVersion;
    if (prev !== undefined && v !== prev) refreshAll();
    return v;
  });

  // Editor selection promoted via context menu / command
  createEffect(() => {
    const draft = props.promoteDraft;
    if (!draft) return;
    (async () => {
      try {
        await window.chronicler.invoke("codex/suggest", {
          name: draft,
          file: props.activeFile ?? "",
        });
        setTab("inbox");
        refetchCandidates();
        props.onStatus(`"${draft}" added to Discovered`);
      } catch (err: any) {
        props.onStatus(`Promote failed: ${err.message}`);
      } finally {
        props.onDraftHandled();
      }
    })();
  });

  const downloadModel = async () => {
    setBusy("Downloading NER model (~110 MB)...");
    try {
      await window.chronicler.invoke("ner/ensure");
      props.onStatus("NER model ready");
    } catch (err: any) {
      props.onStatus(`Model download failed: ${err.message}`);
    } finally {
      setBusy(null);
      refetchNer();
    }
  };

  const scanProject = async () => {
    setBusy("Scanning project (NER)...");
    try {
      const res = await window.chronicler.invoke("codex/scan", {});
      props.onStatus(`Scan done: ${res.newCandidates} new candidate(s) across ${res.scanned} file(s)`);
      refetchCandidates();
    } catch (err: any) {
      props.onStatus(`Scan failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const aiScan = async () => {
    const file = props.activeFile;
    if (!file) {
      props.onStatus("Open a file to AI-scan it");
      return;
    }
    setBusy(`AI scanning ${file}...`);
    try {
      const res = await window.chronicler.invoke("ai/scan", { rel_path: file });
      props.onStatus(`AI scan: ${res.newCandidates} new, ${res.aliasesAdded} alias(es) attached`);
      refreshAll();
    } catch (err: any) {
      props.onStatus(`AI scan failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const promote = async (c: CandidateRow, asAliasOf?: number) => {
    try {
      await window.chronicler.invoke("codex/promote", {
        name: c.name,
        kind: KINDS.includes(c.kindGuess as any) ? c.kindGuess : "character",
        summary: c.summary ?? "",
        asAliasOf,
      });
      refreshAll();
    } catch (err: any) {
      props.onStatus(`Promote failed: ${err.message}`);
    }
  };

  const dismiss = async (name: string) => {
    await window.chronicler.invoke("codex/dismiss", { name });
    refetchCandidates();
  };

  const saveEntity = async (fields: Partial<Entity> & { aliasesText?: string }) => {
    const e = selected();
    if (!e) return;
    const payload: any = { id: e.id, ...fields };
    if (fields.aliasesText !== undefined) {
      payload.aliases = fields.aliasesText.split(",").map(s => s.trim()).filter(Boolean);
      delete payload.aliasesText;
    }
    await window.chronicler.invoke("codex/update", payload);
    refetchEntities();
  };

  const deleteEntity = async () => {
    const e = selected();
    if (!e) return;
    const r = await window.chronicler.showMessageBox({
      type: "warning", buttons: ["Delete", "Cancel"], defaultId: 1, cancelId: 1,
      message: `Delete "${e.name}" from the codex?`,
      detail: "Mentions are removed too. The manuscript itself is untouched.",
    });
    if (r.response !== 0) return;
    await window.chronicler.invoke("codex/delete", { id: e.id });
    setSelected(null);
    refetchEntities();
  };

  const grouped = () => {
    const groups = new Map<string, Entity[]>();
    for (const e of entities() ?? []) {
      const list = groups.get(e.kind) ?? [];
      list.push(e);
      groups.set(e.kind, list);
    }
    return KINDS.filter(k => groups.has(k)).map(k => [k, groups.get(k)!] as const);
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "12px" }}>
      {/* Entity detail editor */}
      <Show when={selected()}>
        {(e) => (
          <div style={{ display: "flex", "flex-direction": "column", height: "100%", overflow: "hidden" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "10px 12px", "border-bottom": "1px solid var(--border-color)" }}>
              <ArrowLeft size={14} style={{ cursor: "pointer", color: "var(--text-muted)" }} onClick={() => setSelected(null)} />
              <span style={{ flex: 1, color: "var(--text-main)", "font-weight": 600 }}>{e().name}</span>
              <Trash2 size={13} style={{ cursor: "pointer", color: "var(--text-faint)" }} onClick={deleteEntity} />
            </div>
            <div style={{ "overflow-y": "auto", flex: 1, padding: "10px 12px", display: "flex", "flex-direction": "column", gap: "10px" }}>
              <div>
                <label style={{ color: "var(--text-muted)", display: "block", "margin-bottom": "4px" }}>Name</label>
                <input style={inputStyle} value={e().name} onChange={(ev) => saveEntity({ name: ev.currentTarget.value })} />
              </div>
              <div>
                <label style={{ color: "var(--text-muted)", display: "block", "margin-bottom": "4px" }}>Kind</label>
                <select style={inputStyle} value={e().kind} onChange={(ev) => saveEntity({ kind: ev.currentTarget.value })}>
                  <For each={[...KINDS]}>{(k) => <option value={k}>{k}</option>}</For>
                </select>
              </div>
              <div>
                <label style={{ color: "var(--text-muted)", display: "block", "margin-bottom": "4px" }}>Aliases (comma-separated)</label>
                <input style={inputStyle} value={e().aliases.join(", ")} onChange={(ev) => saveEntity({ aliasesText: ev.currentTarget.value })} />
              </div>
              <div>
                <label style={{ color: "var(--text-muted)", display: "block", "margin-bottom": "4px" }}>Summary</label>
                <input style={inputStyle} value={e().summary} onChange={(ev) => saveEntity({ summary: ev.currentTarget.value })} />
              </div>
              <div>
                <label style={{ color: "var(--text-muted)", display: "block", "margin-bottom": "4px" }}>Notes</label>
                <textarea
                  style={{ ...inputStyle, height: "110px", resize: "vertical", "font-family": "inherit" }}
                  value={e().body}
                  onChange={(ev) => saveEntity({ body: ev.currentTarget.value })}
                />
              </div>
              <div>
                <label style={{ color: "var(--text-muted)", display: "block", "margin-bottom": "4px" }}>
                  Mentions ({(mentions() ?? []).length})
                </label>
                <For each={mentions() ?? []}>
                  {(m) => (
                    <div
                      onClick={() => props.onOpenFile(m.file, m.line)}
                      style={{ padding: "3px 0", cursor: "pointer", color: "var(--text-muted)" }}
                      onMouseEnter={(ev) => (ev.currentTarget.style.color = "var(--text-main)")}
                      onMouseLeave={(ev) => (ev.currentTarget.style.color = "var(--text-muted)")}
                    >
                      {m.file}:{m.line}
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* List / inbox */}
      <Show when={!selected()}>
        <div style={{ display: "flex", gap: "12px", padding: "8px 12px", "border-bottom": "1px solid var(--border-color)" }}>
          <span
            onClick={() => setTab("entities")}
            style={{ cursor: "pointer", color: tab() === "entities" ? "var(--text-main)" : "var(--text-faint)", "font-weight": 600 }}
          >
            Entities ({(entities() ?? []).length})
          </span>
          <span
            onClick={() => setTab("inbox")}
            style={{ cursor: "pointer", color: tab() === "inbox" ? "var(--text-main)" : "var(--text-faint)", "font-weight": 600 }}
          >
            Discovered ({(candidates() ?? []).length})
          </span>
        </div>

        <Show when={busy()}>
          <div style={{ padding: "6px 12px", color: "var(--accent)", "border-bottom": "1px solid var(--border-color)" }}>{busy()}</div>
        </Show>

        <Show when={tab() === "entities"}>
          <div style={{ "overflow-y": "auto", flex: 1, padding: "6px 0" }}>
            <Show when={(entities() ?? []).length === 0}>
              <div style={{ padding: "10px 12px", color: "var(--text-faint)" }}>
                No entities yet. Promote discoveries from the inbox, select text in the editor and right-click “Promote to Codex”, or add them as you invent them.
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
                        onClick={() => setSelected(e)}
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
        </Show>

        <Show when={tab() === "inbox"}>
          <div style={{ padding: "8px 12px", display: "flex", gap: "8px", "flex-wrap": "wrap", "border-bottom": "1px solid var(--border-color)" }}>
            <Show when={!nerStatus()?.ready}>
              <button onClick={downloadModel} disabled={!!busy()} style={{ display: "flex", "align-items": "center", gap: "6px", padding: "5px 10px", background: "var(--accent)", color: "#fff", border: "none", "border-radius": "4px", cursor: "pointer", "font-size": "11px" }}>
                <Download size={12} /> Get NER model
              </button>
            </Show>
            <Show when={nerStatus()?.ready}>
              <button onClick={scanProject} disabled={!!busy()} style={{ display: "flex", "align-items": "center", gap: "6px", padding: "5px 10px", background: "transparent", color: "var(--text-main)", border: "1px solid var(--border-color)", "border-radius": "4px", cursor: "pointer", "font-size": "11px" }}>
                <ScanSearch size={12} /> Scan project
              </button>
            </Show>
            <button onClick={aiScan} disabled={!!busy()} title="LLM scan of the active file (configure in Settings > AI)" style={{ display: "flex", "align-items": "center", gap: "6px", padding: "5px 10px", background: "transparent", color: "var(--text-main)", border: "1px solid var(--border-color)", "border-radius": "4px", cursor: "pointer", "font-size": "11px" }}>
                <Sparkles size={12} /> AI scan file
            </button>
          </div>
          <div style={{ "overflow-y": "auto", flex: 1, padding: "6px 0" }}>
            <Show when={(candidates() ?? []).length === 0}>
              <div style={{ padding: "10px 12px", color: "var(--text-faint)" }}>
                Nothing waiting for review. New names found by NER{nerStatus()?.ready ? "" : " (model not downloaded yet)"}, AI scans, and manual promotions land here.
              </div>
            </Show>
            <For each={candidates() ?? []}>
              {(c) => (
                <div style={{ padding: "7px 12px", "border-bottom": "1px solid var(--border-color)" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ flex: 1, color: "var(--text-main)", "font-weight": 600 }}>{c.name}</span>
                    <span style={badgeStyle(c.kindGuess)}>{c.kindGuess || "?"}</span>
                    <span style={{ color: "var(--text-faint)", "font-size": "10px" }}>{c.source}·{c.count}</span>
                  </div>
                  <Show when={c.summary || c.contexts[0]}>
                    <div style={{ color: "var(--text-muted)", "font-size": "11px", "margin-top": "3px", overflow: "hidden", display: "-webkit-box", "-webkit-line-clamp": "2", "-webkit-box-orient": "vertical" }}>
                      {c.summary || c.contexts[0]}
                    </div>
                  </Show>
                  <div style={{ display: "flex", gap: "6px", "margin-top": "5px", "align-items": "center" }}>
                    <select
                      id={`kind-${c.name}`}
                      style={{ ...inputStyle, width: "auto", padding: "3px 5px", "font-size": "11px" }}
                      value={KINDS.includes(c.kindGuess as any) ? c.kindGuess : "character"}
                      onChange={(ev) => (c.kindGuess = ev.currentTarget.value)}
                    >
                      <For each={[...KINDS]}>{(k) => <option value={k}>{k}</option>}</For>
                    </select>
                    <button onClick={() => promote(c)} style={{ padding: "3px 10px", background: "var(--accent)", color: "#fff", border: "none", "border-radius": "4px", cursor: "pointer", "font-size": "11px" }}>
                      Add
                    </button>
                    <select
                      style={{ ...inputStyle, width: "auto", "max-width": "110px", padding: "3px 5px", "font-size": "11px" }}
                      onChange={(ev) => {
                        const id = parseInt(ev.currentTarget.value, 10);
                        if (!Number.isNaN(id)) promote(c, id);
                        ev.currentTarget.value = "";
                      }}
                    >
                      <option value="">alias of…</option>
                      <For each={entities() ?? []}>{(e) => <option value={e.id}>{e.name}</option>}</For>
                    </select>
                    <div style={{ flex: 1 }} />
                    <X size={13} style={{ cursor: "pointer", color: "var(--text-faint)" }} onClick={() => dismiss(c.name)} />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
};
