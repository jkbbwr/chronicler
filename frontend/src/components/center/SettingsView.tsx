import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { workbench, updateSettings, THEMES } from "../../stores/workbench";

// Settings as a center tab (VS Code-style page), replacing the old modal.

const label = {
  display: "block", "margin-bottom": "6px", "font-size": "13px",
  color: "var(--text-main)", "font-weight": 500,
} as const;

const hint = { "font-size": "12px", color: "var(--text-faint)", "margin-top": "5px" } as const;

const input = {
  width: "100%", padding: "9px 11px", background: "var(--panel-bg)",
  border: "1px solid var(--border-color)", color: "var(--text-main)",
  "border-radius": "6px", outline: "none", "font-size": "13px",
} as const;

const Section: Component<{ title: string; children: any }> = (props) => (
  <div style={{ "margin-bottom": "40px" }}>
    <h2 style={{ "font-size": "16px", "font-weight": 600, color: "var(--text-main)", margin: "0 0 4px" }}>{props.title}</h2>
    <div style={{ height: "1px", background: "var(--border-color)", margin: "10px 0 18px" }} />
    {props.children}
  </div>
);

const Row: Component<{ name: string; hint?: string; children: any }> = (props) => (
  <div style={{ display: "grid", "grid-template-columns": "240px 1fr", gap: "24px", "margin-bottom": "20px", "align-items": "start" }}>
    <div>
      <label style={label}>{props.name}</label>
      <Show when={props.hint}><div style={hint}>{props.hint}</div></Show>
    </div>
    <div>{props.children}</div>
  </div>
);

export const SettingsView: Component<{ onStatus: (m: string) => void }> = (props) => {
  const [ai, setAi] = createStore({ provider: "anthropic", model: "claude-opus-5", baseUrl: "", enabled: false, hasKey: false });
  const [keyDraft, setKeyDraft] = createSignal("");

  onMount(() => {
    window.chronicler.invoke("ai/config").then((cfg: any) => setAi(cfg)).catch(() => {});
  });

  const saveAi = async (patch: Partial<typeof ai>) => {
    setAi(patch as any);
    try {
      await window.chronicler.invoke("ai/config_set", { ...ai });
    } catch (err: any) {
      props.onStatus(`AI settings save failed: ${err.message}`);
    }
  };

  const saveKey = async () => {
    const value = keyDraft();
    try {
      await window.chronicler.aiStoreKey(value);
      setAi("hasKey", !!value);
      setKeyDraft("");
      props.onStatus(value ? "API key stored" : "API key cleared");
    } catch (err: any) {
      props.onStatus(`Key store failed: ${err.message}`);
    }
  };

  return (
    <div style={{ height: "100%", "overflow-y": "auto" }}>
      <div style={{ "max-width": "760px", margin: "0 auto", padding: "36px 40px" }}>
        <h1 style={{ "font-size": "22px", "font-weight": 600, color: "var(--text-main)", margin: "0 0 30px" }}>Settings</h1>

        <Section title="Editor">
          <Row name="Font family" hint="Used by the prose editor and preview.">
            <input style={input} type="text" value={workbench.settings.fontFamily} onChange={(e) => updateSettings({ fontFamily: e.currentTarget.value })} />
          </Row>
          <Row name="Font size" hint="Points; 8–72.">
            <input
              style={{ ...input, width: "120px" }} type="number" min="8" max="72"
              value={workbench.settings.fontSize}
              onChange={(e) => {
                const size = parseInt(e.currentTarget.value, 10);
                if (!Number.isNaN(size) && size >= 8 && size <= 72) updateSettings({ fontSize: size });
              }}
            />
          </Row>
          <Row name="Writing modes" hint="Also toggleable from the command palette.">
            <label style={{ display: "flex", gap: "8px", "align-items": "center", color: "var(--text-main)", "font-size": "13px", "margin-bottom": "8px", cursor: "pointer" }}>
              <input type="checkbox" checked={workbench.settings.typewriterMode} onChange={(e) => updateSettings({ typewriterMode: e.currentTarget.checked })} />
              Typewriter scrolling — keep the cursor line centered
            </label>
            <label style={{ display: "flex", gap: "8px", "align-items": "center", color: "var(--text-main)", "font-size": "13px", cursor: "pointer" }}>
              <input type="checkbox" checked={workbench.settings.focusMode} onChange={(e) => updateSettings({ focusMode: e.currentTarget.checked })} />
              Focus mode — dim everything but the current paragraph
            </label>
          </Row>
        </Section>

        <Section title="Appearance">
          <Row name="Theme" hint="System follows your OS light/dark preference.">
            <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
              <For each={THEMES}>
                {(theme) => (
                  <button
                    onClick={() => updateSettings({ theme: theme.id })}
                    style={{
                      padding: "8px 16px",
                      background: workbench.settings.theme === theme.id ? "var(--active-bg)" : "var(--panel-bg)",
                      border: workbench.settings.theme === theme.id ? "1px solid var(--accent)" : "1px solid var(--border-color)",
                      color: "var(--text-main)", "border-radius": "6px", "font-size": "13px", cursor: "pointer",
                    }}
                  >
                    {theme.label}
                  </button>
                )}
              </For>
            </div>
          </Row>
        </Section>

        <Section title="AI">
          <Row name="Provider" hint="Powers codex extraction; more uses to come.">
            <select style={input} value={ai.provider} onChange={(e) => saveAi({ provider: e.currentTarget.value })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (local)</option>
            </select>
          </Row>
          <Row name="Model">
            <input style={input} type="text" value={ai.model} onChange={(e) => saveAi({ model: e.currentTarget.value })} />
          </Row>
          <Row name="Base URL" hint="Optional — proxies or a remote Ollama.">
            <input style={input} type="text" placeholder="provider default" value={ai.baseUrl} onChange={(e) => saveAi({ baseUrl: e.currentTarget.value })} />
          </Row>
          <Show when={ai.provider !== "ollama"}>
            <Row name="API key" hint={ai.hasKey ? "A key is stored (OS-keychain encrypted). Enter a new one to replace it, or store empty to clear." : "Encrypted with the OS keychain; held in memory only by the local backend."}>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  style={input} type="password"
                  placeholder={ai.provider === "anthropic" ? "sk-ant-..." : "sk-..."}
                  value={keyDraft()}
                  onInput={(e) => setKeyDraft(e.currentTarget.value)}
                />
                <button onClick={saveKey} style={{ padding: "0 18px", background: "var(--accent)", color: "#fff", border: "none", "border-radius": "6px", cursor: "pointer", "font-size": "13px" }}>
                  Store
                </button>
              </div>
            </Row>
          </Show>
          <Row name="Auto-scan" hint="Runs the LLM pass on changed scenes when NER finds new names. Debounced; costs tokens.">
            <label style={{ display: "flex", gap: "8px", "align-items": "center", color: "var(--text-main)", "font-size": "13px", cursor: "pointer" }}>
              <input type="checkbox" checked={ai.enabled} onChange={(e) => saveAi({ enabled: e.currentTarget.checked })} />
              Enable automatic AI discovery
            </label>
          </Row>
        </Section>
      </div>
    </div>
  );
};
