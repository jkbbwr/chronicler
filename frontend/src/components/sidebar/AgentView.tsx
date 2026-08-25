import { type Component, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Send, Trash2, Sparkles } from "lucide-solid";

// The rig: Chronicler's writing assistant. This panel is its chat surface —
// conversation state lives at module level so switching panel tabs (or
// collapsing the panel) doesn't lose the thread.

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

const [thread, setThread] = createStore<{ msgs: ChatMsg[] }>({ msgs: [] });

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
  let scroller: HTMLDivElement | undefined;

  const scrollDown = () => {
    queueMicrotask(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
  };

  const send = async () => {
    const text = draft().trim();
    if (!text || busy()) return;
    setDraft("");
    setThread("msgs", thread.msgs.length, { role: "user", content: text });
    scrollDown();
    setBusy(true);
    try {
      const scene = attachScene() ? props.activeScene() : null;
      const context = scene
        ? `The writer currently has the scene "${scene.file}" open:\n---\n${scene.content}\n---`
        : undefined;
      const res = await window.chronicler.invoke("ai/chat", {
        // Error turns are display-only; the model never sees them
        messages: thread.msgs.filter(m => !m.error).map(m => ({ role: m.role, content: m.content })),
        context,
      });
      setThread("msgs", thread.msgs.length, { role: "assistant", content: res.text });
    } catch (err: any) {
      setThread("msgs", thread.msgs.length, { role: "assistant", content: err.message, error: true });
    } finally {
      setBusy(false);
      scrollDown();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "12.5px" }}>
      <div ref={scroller} style={{ flex: 1, "overflow-y": "auto", padding: "12px", display: "flex", "flex-direction": "column", gap: "10px" }}>
        <Show when={thread.msgs.length === 0}>
          <div style={{ color: "var(--text-faint)", "line-height": "1.6", padding: "4px" }}>
            <Sparkles size={13} style={{ "vertical-align": "-2px", "margin-right": "5px" }} />
            The rig reads the scene you're working on and talks craft — continuity, pacing, phrasing, what a
            character would really say. Configure a provider in{" "}
            <span onClick={props.onOpenSettings} style={{ color: "var(--accent)", cursor: "pointer" }}>Settings → AI</span>, then ask away.
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
              "white-space": "pre-wrap", "line-height": "1.55", "user-select": "text",
            }}>
              {m.content}
            </div>
          )}
        </For>
        <Show when={busy()}>
          <div style={{ color: "var(--text-faint)", padding: "0 4px" }}>thinking…</div>
        </Show>
      </div>

      <div style={{ "border-top": "1px solid var(--border-color)", padding: "10px 12px", "flex-shrink": 0 }}>
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
            Attach current scene
          </label>
          <div style={{ flex: 1 }} />
          <Show when={thread.msgs.length > 0}>
            <Trash2
              size={14} color="var(--text-faint)" style={{ cursor: "pointer" }}
              onClick={() => setThread("msgs", [])}
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
      </div>
    </div>
  );
};
