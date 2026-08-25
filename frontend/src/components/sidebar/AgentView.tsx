import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Send, Trash2, Sparkles, Paperclip, X, Wrench, Database } from "lucide-solid";

// The rig: Chronicler's writing agent. Chat streams token-by-token; the
// model can call tools (RAG search, grep, codex, scene reads) and each call
// shows up as a chip on the reply. Conversation state lives at module level
// so switching panel tabs doesn't lose the thread.

interface ToolUse {
  name: string;
  done: boolean;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  streaming?: boolean;
  tools?: ToolUse[];
}

const [thread, setThread] = createStore<{ msgs: ChatMsg[]; runId: string | null }>({
  msgs: [],
  runId: null,
});

let onThreadUpdate: (() => void) | null = null;

/** Routed here from the app-level backend event listener. */
export const handleRigEvent = (method: string, params: any) => {
  if (!params || params.id !== thread.runId) return;
  const idx = thread.msgs.length - 1;
  if (idx < 0 || thread.msgs[idx].role !== "assistant") return;
  if (method === "agents/delta") {
    setThread("msgs", idx, "content", (c) => c + (params.text ?? ""));
  } else if (method === "agents/tool") {
    setThread("msgs", idx, "tools", (t) => [...(t ?? []), { name: params.name, done: false }]);
  } else if (method === "agents/tool_done") {
    setThread("msgs", idx, "tools", (t) => {
      const list = [...(t ?? [])];
      const i = list.findIndex((x) => x.name === params.name && !x.done);
      if (i >= 0) list[i] = { ...list[i], done: true };
      return list;
    });
  }
  onThreadUpdate?.();
};

const TOOL_LABELS: Record<string, string> = {
  search_manuscript: "searching manuscript",
  grep_manuscript: "grepping",
  query_codex: "checking codex",
  read_scene: "reading scene",
};

interface AgentViewProps {
  /** The scene the writer has open, for optional context attachment. */
  activeScene: () => { file: string; content: string } | null;
  onStatus: (m: string) => void;
  onOpenSettings: () => void;
}

export const AgentView: Component<AgentViewProps> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [attachScene, setAttachScene] = createSignal(true);
  const [attached, setAttached] = createSignal<string[]>([]);
  const [picking, setPicking] = createSignal(false);
  const [projectFiles, setProjectFiles] = createSignal<string[]>([]);
  const [ragStatus, setRagStatus] = createSignal<{ indexedFiles: number; chunks: number; embedModel: string; currentModel: boolean } | null>(null);
  const [indexing, setIndexing] = createSignal(false);
  let scroller: HTMLDivElement | undefined;

  const scrollDown = () => {
    queueMicrotask(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
  };
  onThreadUpdate = scrollDown;

  const refreshRag = async () => {
    try {
      setRagStatus(await window.chronicler.invoke("agents/status"));
    } catch { /* backend restarting */ }
  };
  onMount(refreshRag);

  const runIndex = async () => {
    setIndexing(true);
    props.onStatus("Agent: indexing manuscript...");
    try {
      const res = await window.chronicler.invoke("agents/index");
      props.onStatus(`Agent: indexed ${res.chunks} passages across ${res.files} scenes`);
    } catch (err: any) {
      props.onStatus(`Agent index failed: ${err.message}`);
    } finally {
      setIndexing(false);
      refreshRag();
    }
  };

  const openPicker = async () => {
    setPicking(true);
    try {
      const res = await window.chronicler.invoke("project/list_files");
      setProjectFiles(
        (res.files ?? []).filter((f: any) => !f.is_dir).map((f: any) => f.name as string)
      );
    } catch { setProjectFiles([]); }
  };

  const send = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    setDraft("");
    const history = thread.msgs
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    const runId = Math.random().toString(36).slice(2);
    setThread("msgs", thread.msgs.length, { role: "user", content: text });
    const idx = thread.msgs.length;
    setThread("msgs", idx, { role: "assistant", content: "", streaming: true, tools: [] });
    setThread("runId", runId);
    scrollDown();
    setBusy(true);
    try {
      const scene = attachScene() ? props.activeScene() : null;
      const context = scene
        ? `The writer currently has the scene "${scene.file}" open in the editor:\n---\n${scene.content}\n---`
        : undefined;
      const res = await window.chronicler.invoke("agents/chat", {
        id: runId,
        messages: [...history, { role: "user", content: text }],
        context,
        attach: attached(),
      });
      setThread("msgs", idx, { content: res.text, streaming: false });
    } catch (err: any) {
      setThread("msgs", idx, { content: err.message, error: true, streaming: false });
    } finally {
      setBusy(false);
      setThread("runId", null);
      scrollDown();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const chip = {
    display: "inline-flex", "align-items": "center", gap: "4px",
    padding: "1px 7px", "border-radius": "9px", "font-size": "10.5px",
    border: "1px solid var(--border-color)", color: "var(--text-muted)",
  } as const;

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "12.5px" }}>
      <div ref={scroller} style={{ flex: 1, "overflow-y": "auto", padding: "12px", display: "flex", "flex-direction": "column", gap: "10px" }}>
        <Show when={thread.msgs.length === 0}>
          <div style={{ color: "var(--text-faint)", "line-height": "1.6", padding: "4px" }}>
            <Sparkles size={13} style={{ "vertical-align": "-2px", "margin-right": "5px" }} />
            The rig can search your novel by meaning, grep it exactly, consult the codex, and read
            scenes — then talk craft with the receipts in hand. Configure a provider in{" "}
            <span onClick={props.onOpenSettings} style={{ color: "var(--accent)", cursor: "pointer" }}>Settings → AI</span>{" "}
            and index the manuscript below.
          </div>
        </Show>
        <For each={thread.msgs}>
          {(m) => (
            <div style={{
              "align-self": m.role === "user" ? "flex-end" : "flex-start",
              "max-width": "92%",
              background: m.role === "user" ? "var(--active-bg)" : "transparent",
              border: m.role === "user" ? "none" : "1px solid var(--border-color)",
              color: m.error ? "#e06c75" : "var(--text-main)",
              "border-radius": "8px", padding: "7px 10px",
              "line-height": "1.55", "user-select": "text",
            }}>
              <Show when={m.tools?.length}>
                <div style={{ display: "flex", "flex-wrap": "wrap", gap: "5px", "margin-bottom": m.content ? "7px" : 0 }}>
                  <For each={m.tools}>
                    {(t) => (
                      <span style={{ ...chip, opacity: t.done ? 0.75 : 1, color: t.done ? "var(--text-faint)" : "var(--accent)" }}>
                        <Wrench size={10} /> {TOOL_LABELS[t.name] ?? t.name}{t.done ? "" : "…"}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <span style={{ "white-space": "pre-wrap" }}>{m.content}</span>
              <Show when={m.streaming && !m.content}>
                <span style={{ color: "var(--text-faint)" }}>thinking…</span>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div style={{ "border-top": "1px solid var(--border-color)", padding: "10px 12px", "flex-shrink": 0 }}>
        {/* Attached-file chips */}
        <Show when={attached().length > 0}>
          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "5px", "margin-bottom": "7px" }}>
            <For each={attached()}>
              {(f) => (
                <span style={chip} title={f}>
                  <Paperclip size={10} />
                  <span style={{ "max-width": "150px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{f.split("/").pop()}</span>
                  <X size={10} style={{ cursor: "pointer" }} onClick={() => setAttached(attached().filter((x) => x !== f))} />
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={picking()}>
          <div style={{ "margin-bottom": "7px", display: "flex", gap: "6px" }}>
            <input
              list="rig-attach-list" placeholder="Attach a scene by name..."
              autofocus
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (projectFiles().includes(v) && !attached().includes(v)) {
                  setAttached([...attached(), v]);
                }
                e.currentTarget.value = "";
                setPicking(false);
              }}
              onKeyDown={(e) => { if (e.key === "Escape") setPicking(false); }}
              style={{ flex: 1, background: "var(--bg-color)", border: "1px solid var(--border-color)", "border-radius": "6px", color: "var(--text-main)", padding: "5px 8px", "font-size": "12px", outline: "none" }}
            />
            <datalist id="rig-attach-list">
              <For each={projectFiles().filter((f) => !attached().includes(f))}>{(f) => <option value={f} />}</For>
            </datalist>
          </div>
        </Show>

        <textarea
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKey}
          placeholder="Ask the rig… (Enter to send)"
          rows={3}
          style={{
            width: "100%", resize: "none", background: "var(--bg-color)",
            border: "1px solid var(--border-color)", "border-radius": "6px",
            color: "var(--text-main)", padding: "8px", "font-size": "12.5px",
            "font-family": "inherit", outline: "none", "box-sizing": "border-box",
          }}
        />
        <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-top": "6px" }}>
          <label style={{ display: "flex", gap: "5px", "align-items": "center", color: "var(--text-muted)", cursor: "pointer", "font-size": "11.5px" }}>
            <input type="checkbox" checked={attachScene()} onChange={(e) => setAttachScene(e.currentTarget.checked)} />
            Current scene
          </label>
          <Paperclip
            size={14} color="var(--text-muted)" style={{ cursor: "pointer" }}
            onClick={() => (picking() ? setPicking(false) : openPicker())}
          />
          <div style={{ flex: 1 }} />
          <Show when={thread.msgs.length > 0}>
            <Trash2
              size={14} color="var(--text-faint)" style={{ cursor: "pointer" }}
              onClick={() => setThread({ msgs: [], runId: null })}
            />
          </Show>
          <button
            onClick={send} disabled={busy() || !draft().trim()}
            title="Send"
            style={{
              display: "flex", "align-items": "center", gap: "5px", padding: "5px 12px",
              background: "var(--accent)", color: "#fff", border: "none", "border-radius": "6px",
              cursor: "pointer", "font-size": "12px", opacity: busy() || !draft().trim() ? 0.5 : 1,
            }}
          >
            <Send size={12} /> Send
          </button>
        </div>

        {/* RAG index status */}
        <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-top": "8px", "font-size": "11px", color: "var(--text-faint)" }}>
          <Database size={11} />
          <Show when={ragStatus()} fallback={<span>index unavailable</span>}>
            <span style={{ flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>
              {ragStatus()!.chunks > 0
                ? `knows ${ragStatus()!.indexedFiles} scenes (${ragStatus()!.chunks} passages)`
                : "manuscript not indexed yet"}
              {ragStatus()!.chunks > 0 && !ragStatus()!.currentModel ? " — embed model changed, reindex" : ""}
            </span>
            <span
              onClick={() => !indexing() && runIndex()}
              style={{ color: "var(--accent)", cursor: "pointer", "flex-shrink": 0 }}
            >
              {indexing() ? "indexing…" : ragStatus()!.chunks > 0 ? "reindex" : "index now"}
            </span>
          </Show>
        </div>
      </div>
    </div>
  );
};
