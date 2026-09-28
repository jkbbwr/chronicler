import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { ChevronDown } from "lucide-solid";
import { Button, Segmented } from "../ui";
import { Row, Check } from "./sections";
import { invoke } from "../../lib/rpc";
import { notify, notifyError } from "../../stores/app";

// AI, for every book: the provider, two model tiers (quick extraction vs
// careful judgement), per-task overrides, and what runs automatically.

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  /** USD per million tokens. */
  inputPrice?: number;
  outputPrice?: number;
}

export interface AiSettings {
  provider: "openrouter" | "openai-compat";
  baseUrl: string;
  fastModel: string;
  deepModel: string;
  embedModel: string;
  /** Per-task model ids; absent = the task's tier default. */
  overrides: Record<string, string>;
  /** Suggest codex entries from new names (uses AI credits). */
  discovery: boolean;
  /** Keep the fact ledger current as you write. */
  ledgerOnSave: boolean;
  /** Check each saved scene for continuity against what came before. */
  liveContinuity: boolean;
  /** Added to the conversation prompt. */
  chatInstructions: string;
  /** Replaces the built-in conversation prompt ("" = built-in). */
  chatPrompt: string;
  hasKey: boolean;
}

/** Every AI task, which tier it defaults to, and what it does. */
export const AI_TASKS: { id: string; label: string; tier: "fast" | "deep"; what: string }[] = [
  { id: "chat", label: "Conversation", tier: "deep", what: "Answering your questions in the Agent tab" },
  { id: "continuity", label: "Continuity", tier: "deep", what: "Finding contradictions between scenes" },
  { id: "critique", label: "Reading critique", tier: "deep", what: "Reading scenes against your brief" },
  { id: "voice", label: "Character voice", tier: "deep", what: "How a character sounds across the book" },
  { id: "timeline", label: "Timeline", tier: "deep", what: "Ordering events in story time" },
  { id: "relations", label: "Relationships", tier: "deep", what: "Who is connected to whom" },
  { id: "hygiene", label: "Codex check", tier: "deep", what: "Auditing the codex against the manuscript" },
  { id: "ledger", label: "Fact ledger", tier: "fast", what: "Noting what each scene establishes" },
  { id: "discovery", label: "Name discovery", tier: "fast", what: "Spotting new characters and places" },
  { id: "synopses", label: "Synopses", tier: "fast", what: "Drafting index-card synopses" },
  { id: "fill", label: "Codex drafting", tier: "fast", what: "Drafting codex summaries and notes" },
  { id: "catch_up", label: "Catch me up", tier: "fast", what: "Summing up the story so far when you come back" },
];

const price = (m?: ModelInfo) =>
  m?.inputPrice === undefined
    ? ""
    : m.outputPrice === undefined
      ? `$${m.inputPrice.toFixed(2)} per M in`
      : `$${m.inputPrice.toFixed(2)} / $${m.outputPrice.toFixed(2)} per M`;
const context = (m?: ModelInfo) => (m?.contextLength ? `${Math.round(m.contextLength / 1000)}k context` : "");

/** Searchable model picker: type to filter; shows context size and price. */
export const ModelPicker: Component<{
  value: string;
  models: ModelInfo[];
  placeholder?: string;
  allowEmpty?: string;
  onChange: (id: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const current = () => props.models.find((m) => m.id === props.value);
  const shown = createMemo(() => {
    const q = query().toLowerCase().trim();
    return props.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q)).slice(0, 80);
  });
  const pick = (id: string) => {
    props.onChange(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <div class="model-picker" onFocusOut={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <div class="model-picker-field">
        <input
          class="input"
          value={open() ? query() : props.value}
          placeholder={props.value || props.placeholder || "Choose a model…"}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onClick={() => setOpen(true)}
          onInput={(e) => { setQuery(e.currentTarget.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pick(shown()[0]?.id ?? query().trim());
            }
            if (e.key === "Escape") setOpen(false);
          }}
        />
        <ChevronDown size={13} class="model-picker-chevron" />
      </div>
      <Show when={!open() && current()}>
        <div class="hint">{[context(current()), price(current())].filter(Boolean).join(" · ")}</div>
      </Show>
      <Show when={open()}>
        <div class="model-picker-list" tabindex="-1">
          <Show when={props.allowEmpty}>
            <div class="model-option" onMouseDown={(e) => { e.preventDefault(); pick(""); }}>
              <span class="model-id">{props.allowEmpty}</span>
            </div>
          </Show>
          <For each={shown()} fallback={<div class="hint model-option">Press Enter to use “{query()}”.</div>}>
            {(m) => (
              <div class="model-option" classList={{ active: m.id === props.value }} onMouseDown={(e) => { e.preventDefault(); pick(m.id); }}>
                <span class="model-id">{m.id}</span>
                <span class="hint">{[context(m), price(m)].filter(Boolean).join(" · ")}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export const AiSection: Component = () => {
  const [ai, setAi] = createStore<AiSettings>({
    provider: "openrouter", baseUrl: "", fastModel: "", deepModel: "", embedModel: "",
    overrides: {}, discovery: false, ledgerOnSave: true, liveContinuity: false,
    chatInstructions: "", chatPrompt: "", hasKey: false,
  });
  const [models, setModels] = createSignal<ModelInfo[]>([]);
  const [keyDraft, setKeyDraft] = createSignal("");
  const [test, setTest] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [advanced, setAdvanced] = createSignal(false);

  const loadModels = async () => {
    try {
      setModels((await invoke("ai/models")).models ?? []);
    } catch {
      setModels([]);
    }
  };

  onMount(async () => {
    try {
      setAi(reconcile({ ...ai, ...(await invoke("ai/config")) }));
      void loadModels();
    } catch { /* backend restarting */ }
  });

  const save = async (patch: Partial<AiSettings>) => {
    setAi(patch);
    setTest(null);
    try {
      const { hasKey: _, ...config } = ai;
      await invoke("ai/config_set", config);
      if ("provider" in patch || "baseUrl" in patch) void loadModels();
    } catch (err) {
      notifyError("Couldn't save AI settings", err);
    }
  };

  const setOverride = (task: string, model: string) => {
    const next = { ...ai.overrides };
    if (model) next[task] = model;
    else delete next[task];
    void save({ overrides: next });
  };

  const storeKey = async () => {
    const value = keyDraft().trim();
    if (!value) return;
    try {
      await window.chronicler.aiStoreKey(value);
      setAi("hasKey", true);
      setKeyDraft("");
      notify("API key stored", "success");
      void loadModels();
    } catch (err) {
      notifyError("Couldn't store the key", err);
    }
  };

  const clearKey = async () => {
    try {
      await window.chronicler.aiStoreKey("");
      setAi("hasKey", false);
      notify("API key cleared");
    } catch (err) {
      notifyError("Couldn't clear the key", err);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await invoke("ai/test");
      setTest({ ok: true, text: `Both models replied (${res.fast.trim().slice(0, 20)} / ${res.deep.trim().slice(0, 20)})` });
    } catch (err) {
      setTest({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const modelFor = (tier: "fast" | "deep") => (tier === "fast" ? ai.fastModel : ai.deepModel);

  // ---- The conversation prompt ----
  const [builtIn, setBuiltIn] = createSignal("");
  const [replacing, setReplacing] = createSignal(false);
  const [promptDraft, setPromptDraft] = createSignal("");
  onMount(async () => {
    try {
      setBuiltIn((await invoke("ai/default_prompts")).chat);
    } catch { /* backend restarting */ }
  });
  let instructionsTimer: ReturnType<typeof setTimeout> | undefined;
  const editInstructions = (value: string) => {
    setAi("chatInstructions", value);
    clearTimeout(instructionsTimer);
    instructionsTimer = setTimeout(() => void save({ chatInstructions: value }), 600);
  };
  const openReplace = () => {
    setPromptDraft(ai.chatPrompt || builtIn());
    setReplacing(true);
  };

  return (
    <>
      <Row name="Provider">
        <Segmented
          value={ai.provider}
          options={[{ value: "openrouter", label: "OpenRouter" }, { value: "openai-compat", label: "Own server" }]}
          onChange={(v) => void save({ provider: v })}
        />
      </Row>
      <Show when={ai.provider === "openai-compat"}>
        <Row name="Server address" hint="Any OpenAI-compatible /v1 root — Ollama, LM Studio, vLLM, OpenAI itself.">
          <input class="input" placeholder="http://localhost:11434/v1" value={ai.baseUrl} onChange={(e) => void save({ baseUrl: e.currentTarget.value })} />
        </Row>
      </Show>
      <Row
        name="API key"
        hint={ai.hasKey ? "Stored, encrypted by your system keychain." : ai.provider === "openrouter" ? "Required. Encrypted by your system keychain." : "Optional — local servers usually don't need one."}
      >
        <div class="settings-inline">
          <input class="input" type="password" placeholder={ai.hasKey ? "•••••••• (stored)" : "Paste a key"} value={keyDraft()} onInput={(e) => setKeyDraft(e.currentTarget.value)} />
          <Button variant="primary" disabled={!keyDraft().trim()} onClick={() => void storeKey()}>Store</Button>
          <Show when={ai.hasKey}><Button variant="ghost" onClick={() => void clearKey()}>Clear</Button></Show>
        </div>
      </Row>

      <h4 class="settings-group">Models</h4>
      <Row name="Quick model" hint="High-volume reading: noting facts, spotting names, synopses. Small, fast and cheap.">
        <ModelPicker value={ai.fastModel} models={models()} onChange={(id) => void save({ fastModel: id })} />
      </Row>
      <Row name="Careful model" hint="Judgement: continuity, critique, voice, conversation. Your strongest model.">
        <ModelPicker value={ai.deepModel} models={models()} onChange={(id) => void save({ deepModel: id })} />
      </Row>
      <Row name="Search model" hint="Lets the agent find passages by meaning. Changing it means the agent re-reads the book.">
        <ModelPicker value={ai.embedModel} models={models()} allowEmpty="Default" placeholder="Default" onChange={(id) => void save({ embedModel: id })} />
      </Row>
      <Row name="Check" hint="Sends one tiny message to each model.">
        <div class="settings-inline">
          <Button onClick={() => void runTest()} disabled={testing()}>{testing() ? "Testing…" : "Test models"}</Button>
          <Show when={test()}>
            <span class="hint" style={{ color: test()!.ok ? "var(--success)" : "var(--danger)" }}>{test()!.text}</span>
          </Show>
        </div>
      </Row>

      <button type="button" class="settings-disclosure" onClick={() => setAdvanced(!advanced())} aria-expanded={advanced()}>
        <ChevronDown size={13} classList={{ open: advanced() }} /> Choose a model per task
      </button>
      <Show when={advanced()}>
        <div class="task-table">
          <For each={AI_TASKS}>
            {(t) => (
              <div class="task-row">
                <div>
                  <div class="task-label">{t.label}</div>
                  <div class="hint">{t.what}</div>
                </div>
                <ModelPicker
                  value={ai.overrides[t.id] ?? ""}
                  models={models()}
                  allowEmpty={`${t.tier === "fast" ? "Quick" : "Careful"} model${modelFor(t.tier) ? ` (${modelFor(t.tier)})` : ""}`}
                  placeholder={`${t.tier === "fast" ? "Quick" : "Careful"} model`}
                  onChange={(id) => setOverride(t.id, id)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>

      <h4 class="settings-group">Conversation</h4>
      <Row name="Your instructions" hint="Added to the agent's prompt in every conversation, in every book. Per-book notes go in This book.">
        <textarea
          class="input"
          rows={4}
          placeholder="e.g. Be blunt. Use British spelling. When I ask about pacing, look at chapter length first."
          value={ai.chatInstructions}
          onInput={(e) => editInstructions(e.currentTarget.value)}
        />
      </Row>
      <Row
        name="The prompt itself"
        hint={ai.chatPrompt.trim() ? "You're using your own prompt." : "The built-in prompt is in use."}
      >
        <Show
          when={replacing()}
          fallback={
            <div class="settings-inline">
              <Button size="sm" onClick={openReplace}>{ai.chatPrompt.trim() ? "Edit your prompt…" : "Replace the built-in prompt…"}</Button>
              <Show when={ai.chatPrompt.trim()}>
                <Button size="sm" variant="ghost" onClick={() => void save({ chatPrompt: "" })}>Back to built-in</Button>
              </Show>
            </div>
          }
        >
          <textarea class="input prompt-editor" rows={14} value={promptDraft()} onInput={(e) => setPromptDraft(e.currentTarget.value)} />
          <p class="hint">
            This replaces the whole prompt; your instructions above are still added after it. The built-in prompt holds
            the rule that the agent never writes your prose for you — keep that paragraph if you want the rule.
          </p>
          <div class="settings-inline">
            <Button size="sm" variant="primary" onClick={() => { void save({ chatPrompt: promptDraft().trim() === builtIn().trim() ? "" : promptDraft() }); setReplacing(false); }}>
              Use this prompt
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPromptDraft(builtIn())}>Start from built-in</Button>
            <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>Cancel</Button>
          </div>
        </Show>
      </Row>

      <h4 class="settings-group">While you write</h4>
      <div class="settings-checks settings-checks-wide">
        <Check checked={ai.ledgerOnSave} onChange={(v) => void save({ ledgerOnSave: v })}>
          Keep the fact ledger current — note what each scene establishes after you save it (quick model)
        </Check>
        <Check checked={ai.liveContinuity} onChange={(v) => void save({ liveContinuity: v })}>
          Check continuity as you write — flag contradictions with earlier scenes in the margin (careful model)
        </Check>
        <Check checked={ai.discovery} onChange={(v) => void save({ discovery: v })}>
          Suggest codex entries when new names appear (quick model)
        </Check>
      </div>
      <p class="hint">These run a little after you stop typing, only on scenes that changed. They use your AI credits.</p>
    </>
  );
};
