import { type Component, createEffect, createResource, createSignal, For, Show } from "solid-js";
import { Download, ScanSearch, Sparkles, X } from "lucide-solid";
import { KINDS } from "../sidebar/CodexView";

// The Discovered inbox as a center tab: full-width review queue for
// NER / LLM / manually promoted candidates.

type ContextRef = string | { file: string; line: number; text: string };

interface CandidateRow {
  name: string;
  kindGuess: string;
  count: number;
  files: string[];
  contexts: ContextRef[];
  source: string;
  summary: string;
}

const contextText = (c?: ContextRef) => (typeof c === "string" ? c : c?.text ?? "");
const contextTarget = (c?: ContextRef) =>
  typeof c === "object" && c && c.file && c.line > 0 ? c : null;

interface InboxViewProps {
  activeFile: string | null;
  refreshVersion: number;
  onStatus: (message: string) => void;
  /** Bump shared codex state (panel badge, entity lists) after changes. */
  onChanged: () => void;
  onOpenEntity: (id: number, title: string) => void;
  onOpenFile: (file: string, line: number) => void;
}

const btn = {
  display: "flex", "align-items": "center", gap: "6px", padding: "6px 12px",
  background: "transparent", color: "var(--text-main)",
  border: "1px solid var(--border-color)", "border-radius": "5px",
  cursor: "pointer", "font-size": "12px",
} as const;

export const InboxView: Component<InboxViewProps> = (props) => {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [kindChoice, setKindChoice] = createSignal<Record<string, string>>({});

  const [candidates, { refetch: refetchCandidates }] = createResource(async () => {
    try {
      const res = await window.chronicler.invoke("codex/candidates");
      return res.candidates as CandidateRow[];
    } catch {
      return [] as CandidateRow[];
    }
  });
  const [entities, { refetch: refetchEntities }] = createResource(async () => {
    try {
      const res = await window.chronicler.invoke("codex/list");
      return res.entities as { id: number; name: string }[];
    } catch {
      return [];
    }
  });
  const [nerStatus, { refetch: refetchNer }] = createResource(async () => {
    try {
      return await window.chronicler.invoke("ner/status");
    } catch {
      return { ready: false };
    }
  });

  createEffect((prev: number | undefined) => {
    const v = props.refreshVersion;
    if (prev !== undefined && v !== prev) {
      refetchCandidates();
      refetchEntities();
    }
    return v;
  });

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      props.onStatus(await fn());
    } catch (err: any) {
      props.onStatus(`${label} failed: ${err.message}`);
    } finally {
      setBusy(null);
      refetchCandidates();
      refetchEntities();
      refetchNer();
      props.onChanged();
    }
  };

  const downloadModel = () =>
    run("Model download", async () => {
      await window.chronicler.invoke("ner/ensure");
      return "NER model ready";
    });

  const scanProject = () =>
    run("Scan", async () => {
      const res = await window.chronicler.invoke("codex/scan", {});
      return `Scan done: ${res.newCandidates} new candidate(s) across ${res.scanned} file(s)`;
    });

  const aiScan = () =>
    run("AI scan", async () => {
      if (!props.activeFile) throw new Error("open a file first");
      const res = await window.chronicler.invoke("ai/scan", { rel_path: props.activeFile });
      return `AI scan: ${res.newCandidates} new, ${res.aliasesAdded} alias(es) attached`;
    });

  const promote = async (c: CandidateRow, opts: { asAliasOf?: number; edit?: boolean } = {}) => {
    try {
      const kind = kindChoice()[c.name] ?? (KINDS.includes(c.kindGuess as any) ? c.kindGuess : "character");
      const res = await window.chronicler.invoke("codex/promote", {
        name: c.name, kind, summary: c.summary ?? "", asAliasOf: opts.asAliasOf,
      });
      refetchCandidates();
      refetchEntities();
      props.onChanged();
      if (res.created && opts.edit) props.onOpenEntity(res.created, c.name);
      else if (res.created) props.onStatus(`"${c.name}" added to the codex`);
    } catch (err: any) {
      props.onStatus(`Promote failed: ${err.message}`);
    }
  };

  const dismiss = async (name: string) => {
    await window.chronicler.invoke("codex/dismiss", { name });
    refetchCandidates();
    props.onChanged();
  };

  return (
    <div style={{ height: "100%", "overflow-y": "auto" }}>
      <div style={{ "max-width": "860px", margin: "0 auto", padding: "32px 40px" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "12px", "margin-bottom": "6px" }}>
          <h1 style={{ "font-size": "20px", "font-weight": 600, color: "var(--text-main)", margin: 0, flex: 1 }}>Discovered</h1>
          <Show when={!nerStatus()?.ready}>
            <button style={{ ...btn, background: "var(--accent)", color: "#fff", border: "none" }} disabled={!!busy()} onClick={downloadModel}>
              <Download size={13} /> Get NER model (~110 MB)
            </button>
          </Show>
          <Show when={nerStatus()?.ready}>
            <button style={btn} disabled={!!busy()} onClick={scanProject}>
              <ScanSearch size={13} /> Scan project
            </button>
          </Show>
          <button style={btn} disabled={!!busy()} onClick={aiScan} title="LLM scan of the active file (Settings > AI)">
            <Sparkles size={13} /> AI scan file
          </button>
        </div>
        <div style={{ color: "var(--text-faint)", "font-size": "13px", "margin-bottom": "20px" }}>
          Names surfaced by NER, AI scans, and editor promotions. Nothing enters the codex until you approve it.
          <Show when={busy()}> <span style={{ color: "var(--accent)" }}>{busy()}…</span></Show>
        </div>

        <Show when={(candidates() ?? []).length === 0}>
          <div style={{ color: "var(--text-faint)", padding: "30px 0" }}>Inbox zero. Write, scan, or select text in the editor and press Cmd+Shift+K.</div>
        </Show>

        <For each={candidates() ?? []}>
          {(c) => (
            <div style={{ padding: "14px 16px", border: "1px solid var(--border-color)", "border-radius": "8px", "margin-bottom": "10px", background: "var(--panel-bg)" }}>
              <div style={{ display: "flex", "align-items": "baseline", gap: "10px" }}>
                <span style={{ "font-size": "15px", "font-weight": 600, color: "var(--text-main)" }}>{c.name}</span>
                <span style={{ "font-size": "11px", color: "var(--text-faint)" }}>
                  {c.source} · {c.count} file{c.count === 1 ? "" : "s"} · {c.files.slice(0, 3).join(", ")}{c.files.length > 3 ? "…" : ""}
                </span>
              </div>
              <Show when={c.summary}>
                <div style={{ color: "var(--text-muted)", "font-size": "13px", "margin-top": "6px" }}>{c.summary}</div>
              </Show>
              <Show when={contextText(c.contexts[0])}>
                <div
                  onClick={() => { const t = contextTarget(c.contexts[0]); if (t) props.onOpenFile(t.file, t.line); }}
                  title={contextTarget(c.contexts[0]) ? `Open ${contextTarget(c.contexts[0])!.file}:${contextTarget(c.contexts[0])!.line}` : undefined}
                  style={{
                    color: "var(--text-muted)", "font-size": "13px", "margin-top": "6px",
                    "font-style": "italic",
                    cursor: contextTarget(c.contexts[0]) ? "pointer" : "default",
                  }}
                  onMouseEnter={(ev) => { if (contextTarget(c.contexts[0])) ev.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(ev) => (ev.currentTarget.style.color = "var(--text-muted)")}
                >
                  “{contextText(c.contexts[0])}”
                </div>
              </Show>
              <div style={{ display: "flex", gap: "8px", "margin-top": "10px", "align-items": "center" }}>
                <select
                  style={{ ...btn, cursor: "pointer" }}
                  value={kindChoice()[c.name] ?? (KINDS.includes(c.kindGuess as any) ? c.kindGuess : "character")}
                  onChange={(ev) => setKindChoice(k => ({ ...k, [c.name]: ev.currentTarget.value }))}
                >
                  <For each={[...KINDS]}>{(k) => <option value={k}>{k}</option>}</For>
                </select>
                <button style={{ ...btn, background: "var(--accent)", color: "#fff", border: "none" }} onClick={() => promote(c)}>
                  Add to codex
                </button>
                <button style={btn} onClick={() => promote(c, { edit: true })} title="Add and open the entity sheet">
                  Add (edit)
                </button>
                <select
                  style={{ ...btn, cursor: "pointer", "max-width": "180px" }}
                  onChange={(ev) => {
                    const id = parseInt(ev.currentTarget.value, 10);
                    if (!Number.isNaN(id)) promote(c, { asAliasOf: id });
                    ev.currentTarget.value = "";
                  }}
                >
                  <option value="">add as alias of…</option>
                  <For each={entities() ?? []}>{(e) => <option value={e.id}>{e.name}</option>}</For>
                </select>
                <div style={{ flex: 1 }} />
                <button style={{ ...btn, border: "none", color: "var(--text-faint)" }} onClick={() => dismiss(c.name)} title="Dismiss — won't be suggested again">
                  <X size={13} /> Dismiss
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
