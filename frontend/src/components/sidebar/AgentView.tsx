import { type Component, createEffect, createRoot, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Send, Square, Trash2, Sparkles, Paperclip, X, BookOpen } from "lucide-solid";
import { parseSceneHref, renderMarkdown } from "../../lib/markdown";
import { invoke, onBackend } from "../../lib/rpc";
import { project } from "../../stores/app";
import { IconButton, Button } from "../ui";
import "./AgentView.css";

// The writing agent. Replies stream in; the agent looks things up (passages,
// exact phrases, the codex, whole scenes) and each lookup shows as a chip.
// The conversation belongs to the project and survives restarts.

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

const [thread, setThread] = createStore<{ msgs: ChatMsg[]; runId: string | null; root: string | null }>({
  msgs: [],
  runId: null,
  root: null,
});

let onThreadUpdate: (() => void) | null = null;

// "Ask about selection": text queued from outside lands in the composer.
const [composerSeed, setComposerSeed] = createSignal<string | null>(null);
export const seedComposer = (text: string) => setComposerSeed(text);

// ---- Persistence, per project ----

let persistTimer: ReturnType<typeof setTimeout> | undefined;

const persistThread = () => {
  const root = thread.root;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!root || root !== project.root) return; // never write one book's chat into another
    try {
      const msgs = thread.msgs.filter((m) => !m.streaming);
      await invoke("db/set", { key: "agentThread", value: JSON.stringify(msgs) });
    } catch { /* backend restarting */ }
  }, 300);
};

createRoot(() => {
  // Switch threads with the project.
  createEffect(on(() => project.root, async (root) => {
    clearTimeout(persistTimer);
    setThread({ msgs: [], runId: null, root });
    if (!root) return;
    try {
      const res = await invoke("db/get", { key: "agentThread" });
      const msgs = res.value ? JSON.parse(res.value) : [];
      if (Array.isArray(msgs) && thread.root === root) setThread("msgs", msgs);
    } catch { /* fresh thread */ }
  }));
});

onBackend("agents/*", (params: { id?: string; method: string; text?: string; name?: string }) => {
  if (!params || params.id !== thread.runId) return;
  const idx = thread.msgs.length - 1;
  if (idx < 0 || thread.msgs[idx].role !== "assistant") return;
  if (params.method === "agents/delta") {
    setThread("msgs", idx, "content", (c) => c + (params.text ?? ""));
  } else if (params.method === "agents/tool") {
    setThread("msgs", idx, "tools", (t) => [...(t ?? []), { name: params.name!, done: false }]);
  } else if (params.method === "agents/tool_done") {
    setThread("msgs", idx, "tools", (t) => {
      const list = [...(t ?? [])];
      const i = list.findIndex((x) => x.name === params.name && !x.done);
      if (i >= 0) list[i] = { ...list[i], done: true };
      return list;
    });
  }
  onThreadUpdate?.();
});

const TOOL_LABELS: Record<string, string> = {
  search_manuscript: "finding passages",
  grep_manuscript: "searching exact words",
  query_codex: "checking the codex",
  read_scene: "reading a scene",
};

/** Markdown for a reply; while streaming, re-rendered at most every 120ms. */
const ReplyBody: Component<{ msg: ChatMsg; onClick: (e: MouseEvent) => void }> = (props) => {
  const [html, setHtml] = createSignal(renderMarkdown(props.msg.content));
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(() => props.msg.content, (content) => {
    if (!props.msg.streaming) {
      clearTimeout(timer);
      timer = undefined;
      setHtml(renderMarkdown(content));
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        setHtml(renderMarkdown(props.msg.content));
      }, 120);
    }
  }));
  createEffect(on(() => props.msg.streaming, (s) => { if (!s) setHtml(renderMarkdown(props.msg.content)); }, { defer: true }));
  onCleanup(() => clearTimeout(timer));
  return <div class="agent-md" innerHTML={html()} onClick={props.onClick} />;
};

interface AgentViewProps {
  /** The scene the writer has open, for optional context attachment. */
  activeScene: () => { file: string; content: string } | null;
  onStatus: (m: string) => void;
  onOpenSettings: () => void;
  /** Open a scene the agent cited (1-based line, when given). */
  onOpenScene: (file: string, line?: number) => void;
}

export const AgentView: Component<AgentViewProps> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [attachScene, setAttachScene] = createSignal(true);
  const [attached, setAttached] = createSignal<string[]>([]);
  const [picking, setPicking] = createSignal(false);
  const [projectFiles, setProjectFiles] = createSignal<string[]>([]);
  const [reading, setReading] = createSignal<{ indexedFiles: number; chunks: number; currentModel: boolean } | null>(null);
  const [indexing, setIndexing] = createSignal(false);
  let scroller: HTMLDivElement | undefined;
  let composerRef: HTMLTextAreaElement | undefined;

  const scrollDown = () => queueMicrotask(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
  onThreadUpdate = scrollDown;
  onCleanup(() => { if (onThreadUpdate === scrollDown) onThreadUpdate = null; });

  const refreshReading = async () => {
    try {
      setReading(await invoke("agents/status"));
    } catch { /* backend restarting */ }
  };

  onMount(() => void refreshReading());

  createEffect(() => {
    const seed = composerSeed();
    if (seed === null) return;
    setDraft(seed);
    setComposerSeed(null);
    queueMicrotask(() => {
      composerRef?.focus();
      composerRef?.setSelectionRange(composerRef.value.length, composerRef.value.length);
    });
  });

  const readBook = async () => {
    setIndexing(true);
    props.onStatus("The agent is reading the manuscript…");
    try {
      const res = await invoke("agents/index");
      props.onStatus(`The agent has read ${res.files} scene(s)`);
    } catch (err) {
      props.onStatus(`Reading failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIndexing(false);
      void refreshReading();
    }
  };

  const openPicker = async () => {
    setPicking(true);
    try {
      const res = await invoke("project/list_files");
      setProjectFiles(res.files.filter((f) => !f.isDir).map((f) => f.path));
    } catch {
      setProjectFiles([]);
    }
  };

  const send = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    setDraft("");
    const history = thread.msgs.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
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
      const res = await invoke("agents/chat", {
        id: runId,
        messages: [...history, { role: "user", content: text }],
        context,
        attach: attached(),
      });
      setThread("msgs", idx, { content: res.stopped && !res.text ? "*(stopped before replying)*" : res.text, streaming: false });
    } catch (err) {
      setThread("msgs", idx, { content: err instanceof Error ? err.message : String(err), error: true, streaming: false });
    } finally {
      setBusy(false);
      setThread("runId", null);
      scrollDown();
      persistThread();
    }
  };

  const stop = async () => {
    const id = thread.runId;
    if (id) await invoke("agents/stop", { id }).catch(() => {});
  };

  const onMdClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const scene = parseSceneHref(a.getAttribute("href") ?? "");
    if (scene) props.onOpenScene(scene.path, scene.line);
  };

  return (
    <div class="agent">
      <div ref={scroller} class="agent-thread selectable">
        <Show when={thread.msgs.length === 0}>
          <div class="agent-intro">
            <Sparkles size={14} />
            <p>
              Ask about your book. The agent finds passages by meaning or exact words, checks the codex and reads
              scenes — then talks craft with the evidence in hand. It never edits your text.
            </p>
            <p class="hint">
              Set up a provider in <a href="#" onClick={(e) => { e.preventDefault(); props.onOpenSettings(); }}>Settings → AI</a>.
            </p>
          </div>
        </Show>
        <For each={thread.msgs}>
          {(m) => (
            <div class={`agent-msg agent-msg-${m.role}`} classList={{ error: !!m.error }}>
              <Show when={m.tools?.length}>
                <div class="agent-tools">
                  <For each={m.tools}>
                    {(t) => <span class="agent-tool" classList={{ done: t.done }}>{TOOL_LABELS[t.name] ?? t.name}{t.done ? "" : "…"}</span>}
                  </For>
                </div>
              </Show>
              <Show when={m.role === "assistant" && !m.error} fallback={<span class="agent-plain">{m.content}</span>}>
                <ReplyBody msg={m} onClick={onMdClick} />
              </Show>
              <Show when={m.streaming && !m.content}><span class="hint">thinking…</span></Show>
            </div>
          )}
        </For>
      </div>

      <div class="agent-composer">
        <Show when={attached().length > 0}>
          <div class="agent-tools">
            <For each={attached()}>
              {(f) => (
                <span class="agent-tool" title={f}>
                  <Paperclip size={10} /> {f.split("/").pop()!.replace(/\.md$/, "")}
                  <X size={10} style={{ cursor: "pointer" }} onClick={() => setAttached(attached().filter((x) => x !== f))} />
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={picking()}>
          <input
            class="input"
            list="agent-attach-list"
            placeholder="Attach a scene by name…"
            ref={(el) => queueMicrotask(() => el.focus())}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (projectFiles().includes(v) && !attached().includes(v)) setAttached([...attached(), v]);
              e.currentTarget.value = "";
              setPicking(false);
            }}
            onKeyDown={(e) => { if (e.key === "Escape") setPicking(false); }}
          />
          <datalist id="agent-attach-list">
            <For each={projectFiles().filter((f) => !attached().includes(f))}>{(f) => <option value={f} />}</For>
          </datalist>
        </Show>
        <textarea
          ref={composerRef}
          class="input agent-input"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Ask about your manuscript…"
          rows={3}
        />
        <div class="agent-bar">
          <label class="checkbox-row">
            <input type="checkbox" checked={attachScene()} onChange={(e) => setAttachScene(e.currentTarget.checked)} />
            Include this scene
          </label>
          <IconButton size="sm" label="Attach another scene" onClick={() => (picking() ? setPicking(false) : void openPicker())}>
            <Paperclip size={13} />
          </IconButton>
          <div style={{ flex: 1 }} />
          <Show when={thread.msgs.length > 0 && !busy()}>
            <IconButton size="sm" label="Clear the conversation" onClick={() => { setThread({ msgs: [], runId: null }); persistThread(); }}>
              <Trash2 size={13} />
            </IconButton>
          </Show>
          <Show
            when={busy()}
            fallback={<Button size="sm" variant="primary" disabled={!draft().trim()} onClick={() => void send()}><Send size={11} /> Send</Button>}
          >
            <Button size="sm" onClick={() => void stop()}><Square size={10} fill="currentColor" /> Stop</Button>
          </Show>
        </div>
        <div class="agent-reading">
          <BookOpen size={11} />
          <Show when={reading()} fallback={<span>Not connected</span>}>
            <span class="agent-reading-text">
              {reading()!.chunks > 0
                ? `Has read ${reading()!.indexedFiles} scene${reading()!.indexedFiles === 1 ? "" : "s"}${reading()!.currentModel ? "" : " — search model changed, read again"}`
                : "Hasn't read the manuscript yet"}
            </span>
            <a href="#" onClick={(e) => { e.preventDefault(); if (!indexing()) void readBook(); }}>
              {indexing() ? "reading…" : reading()!.chunks > 0 ? "Read again" : "Read it now"}
            </a>
          </Show>
        </div>
      </div>
    </div>
  );
};
