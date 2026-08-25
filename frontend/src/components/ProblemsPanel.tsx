import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { Download, RefreshCw, CircleAlert, CircleX, Sparkles } from "lucide-solid";
import { type Diag } from "./editor/diagSquiggles";

// The bottom panel: Problems (spelling / grammar / assistant diagnostics,
// grouped, click-to-jump, with dictionary/suppression actions) and Output
// (the app's operation log).

export interface LogEntry {
  time: string;
  message: string;
}

interface ProblemsPanelProps {
  diagnostics: Record<string, Diag[]>;
  logs: LogEntry[];
  onJump: (d: Diag) => void;
  onAddWord: (d: Diag) => void;
  onIgnore: (d: Diag, global: boolean) => void;
  onRecheck: () => void;
  onStatus: (m: string) => void;
}

const GROUPS: { source: Diag["source"]; label: string; color: string }[] = [
  { source: "spelling", label: "Spelling", color: "#e06c75" },
  { source: "grammar", label: "Grammar", color: "#61afef" },
  { source: "assistant", label: "Assistant", color: "#b689e0" },
];

const smallBtn = {
  padding: "2px 8px", background: "transparent", color: "var(--text-muted)",
  border: "1px solid var(--border-color)", "border-radius": "4px",
  cursor: "pointer", "font-size": "11px", "flex-shrink": 0,
} as const;

export const ProblemsPanel: Component<ProblemsPanelProps> = (props) => {
  const [tab, setTab] = createSignal<"problems" | "output">("problems");
  const [busy, setBusy] = createSignal(false);

  const [status, { refetch: refetchStatus }] = createResource(async () => {
    try {
      return await window.chronicler.invoke("diag/status");
    } catch {
      return { ready: false };
    }
  });

  const all = () => Object.values(props.diagnostics).flat();
  const bySource = (source: string) => all().filter(d => d.source === source);

  const download = async () => {
    setBusy(true);
    props.onStatus("Downloading language models (~16 MB)...");
    try {
      await window.chronicler.invoke("diag/ensure");
      props.onStatus("Language models ready");
      refetchStatus();
      props.onRecheck();
    } catch (err: any) {
      props.onStatus(`Language model download failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "12px" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "14px", padding: "6px 15px", "border-bottom": "1px solid var(--border-color)", "min-height": "32px" }}>
        <span
          onClick={() => setTab("problems")}
          style={{ cursor: "pointer", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.5px", "font-size": "11px", color: tab() === "problems" ? "var(--text-main)" : "var(--text-faint)" }}
        >
          Problems{all().length > 0 ? ` (${all().length})` : ""}
        </span>
        <span
          onClick={() => setTab("output")}
          style={{ cursor: "pointer", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.5px", "font-size": "11px", color: tab() === "output" ? "var(--text-main)" : "var(--text-faint)" }}
        >
          Output
        </span>
        <div style={{ flex: 1 }} />
        <Show when={tab() === "problems"}>
          <Show when={status()?.ready} fallback={
            <button style={{ ...smallBtn, color: "var(--accent)", "border-color": "var(--accent)" }} disabled={busy()} onClick={download}>
              <Download size={11} style={{ "vertical-align": "-2px" }} /> Get language models
            </button>
          }>
            <button style={smallBtn} onClick={props.onRecheck} title="Re-run spelling and grammar checks">
              <RefreshCw size={11} style={{ "vertical-align": "-2px" }} /> Recheck
            </button>
          </Show>
        </Show>
      </div>

      <Show when={tab() === "problems"}>
        <div style={{ "overflow-y": "auto", flex: 1 }}>
          <Show when={all().length === 0}>
            <div style={{ padding: "10px 15px", color: "var(--text-faint)" }}>
              {status()?.ready ? "No problems found." : "Download the language models to enable spelling and grammar checks."}
            </div>
          </Show>
          <For each={GROUPS.filter(g => bySource(g.source).length > 0)}>
            {(group) => (
              <div>
                <div style={{ padding: "6px 15px 2px", display: "flex", "align-items": "center", gap: "7px", "font-size": "11px", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--text-muted)" }}>
                  {group.source === "assistant" ? <Sparkles size={11} color={group.color} /> : group.source === "spelling" ? <CircleX size={11} color={group.color} /> : <CircleAlert size={11} color={group.color} />}
                  {group.label} ({bySource(group.source).length})
                </div>
                <For each={bySource(group.source)}>
                  {(d) => (
                    <div
                      onClick={() => props.onJump(d)}
                      style={{ display: "flex", "align-items": "center", gap: "10px", padding: "3px 15px 3px 33px", cursor: "pointer" }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--hover-bg)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <span style={{ color: "var(--text-main)", "flex-shrink": 0, "font-weight": 600 }}>{d.text}</span>
                      <span style={{ color: "var(--text-muted)", overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis", flex: 1 }}>
                        {d.message}
                        <Show when={d.replacements?.length}>
                          <span style={{ color: "var(--text-faint)" }}> — try {d.replacements!.slice(0, 3).join(", ")}</span>
                        </Show>
                      </span>
                      <Show when={d.source === "spelling"}>
                        <button style={smallBtn} onClick={(e) => { e.stopPropagation(); props.onAddWord(d); }} title="Add to project dictionary">
                          + Dictionary
                        </button>
                      </Show>
                      <button style={smallBtn} onClick={(e) => { e.stopPropagation(); props.onIgnore(d, false); }} title={d.source === "spelling" ? "Ignore this word in this file" : "Ignore this rule at this text in this file"}>
                        Ignore
                      </button>
                      <Show when={d.source === "grammar"}>
                        <button style={smallBtn} onClick={(e) => { e.stopPropagation(); props.onIgnore(d, true); }} title="Disable this grammar rule everywhere">
                          Disable rule
                        </button>
                      </Show>
                      <span style={{ color: "var(--text-faint)", "flex-shrink": 0, "font-size": "11px" }}>
                        {d.file}:{d.line}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={tab() === "output"}>
        <div style={{ "overflow-y": "auto", flex: 1, padding: "6px 15px", "font-family": "ui-monospace, Menlo, monospace", "font-size": "11.5px", "line-height": "1.7" }}>
          <Show when={props.logs.length === 0}>
            <div style={{ color: "var(--text-faint)", "font-family": "inherit" }}>Compile, scan, and app events will appear here.</div>
          </Show>
          <For each={props.logs}>
            {(entry) => (
              <div style={{ color: "var(--text-muted)" }}>
                <span style={{ color: "var(--text-faint)" }}>{entry.time}</span>  {entry.message}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
