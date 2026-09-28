import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { ChevronDown, Loader2, Play } from "lucide-solid";
import { Button, IconButton } from "../ui";
import { Row } from "./sections";
import { ModelPicker } from "./AiSection";
import { invoke } from "../../lib/rpc";
import { playUrlOnce, sample, stopPreview } from "../../lib/readAloud";
import { notifyError } from "../../stores/app";
import { openSettings } from "./SettingsSheet";
import type { SpeechModel } from "../../rpc.gen";
import "../readaloud/VoicePicker.css";

// Read aloud, for every book: which speech model and voice narrate the
// book when you proof by listening. It goes through the connection in
// Settings → AI (OpenRouter, or a local server).

interface TtsSettings {
  voice: string;
  model: string;
  speed: number;
}

interface Voice {
  id: string;
  name: string;
  description?: string;
  previewUrl?: string;
}

const SAMPLE = "The tide came in over the flats, and nobody on the quay said a word about the night before.";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Searchable voice picker with a ▶ preview on every voice. */
const VoicePicker: Component<{
  value: string;
  voices: Voice[];
  onChange: (id: string) => void;
  onPreview: (v: Voice) => void;
  previewing: string | null;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const current = () => props.voices.find((v) => v.id === props.value);
  const shown = createMemo(() => {
    const q = query().toLowerCase().trim();
    return props.voices.filter((v) => !q || v.name.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q) || v.id === q);
  });
  const pick = (id: string) => {
    if (id) props.onChange(id);
    setOpen(false);
    setQuery("");
  };
  // `voice` is read at click time: the button beside the field outlives changes of voice.
  const previewButton = (voice: () => Voice) => (
    <IconButton
      size="sm"
      label={`Hear ${voice().name}`}
      // Not the row's mousedown: that picks the voice and closes the list.
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); props.onPreview(voice()); }}
    >
      <Show when={props.previewing === voice().id} fallback={<Play size={12} />}><Loader2 size={12} class="spin" /></Show>
    </IconButton>
  );
  const selected = () => current() ?? (props.value ? { id: props.value, name: props.value } : undefined);
  return (
    <div class="model-picker voice-picker" onFocusOut={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <div class="voice-picker-row">
        <div class="model-picker-field">
          <input
            class="input voice-picker-input"
            value={open() ? query() : current()?.name ?? props.value}
            placeholder={current()?.name ?? (props.value || "Choose a voice…")}
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
        <Show when={selected()}>{previewButton(() => selected()!)}</Show>
      </div>
      <Show when={!open() && current()?.description}>
        <div class="hint">{current()!.description}</div>
      </Show>
      <Show when={open()}>
        <div class="model-picker-list" tabindex="-1">
          <For each={shown()} fallback={<div class="hint model-option">Press Enter to use the voice id “{query()}”.</div>}>
            {(v) => (
              <div class="model-option voice-option" classList={{ active: v.id === props.value }} onMouseDown={(e) => { e.preventDefault(); pick(v.id); }}>
                <div class="voice-option-text">
                  <span class="voice-name">{v.name}</span>
                  <Show when={v.description}><span class="hint">{v.description}</span></Show>
                </div>
                {previewButton(() => v)}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export const VoiceSection: Component = () => {
  const [tts, setTts] = createStore<TtsSettings>({ voice: "", model: "", speed: 1 });
  const [models, setModels] = createSignal<SpeechModel[]>([]);
  const [voices, setVoices] = createSignal<Voice[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [previewing, setPreviewing] = createSignal<string | null>(null);

  const loadVoices = async () => {
    try {
      const list = (await invoke("tts/voices")).voices ?? [];
      setVoices(list);
      // No voice chosen: the model's first is what plays.
      if (!tts.voice && list[0]) setTts("voice", list[0].id);
    } catch {
      setVoices([]);
    }
  };

  onMount(async () => {
    try {
      setTts(reconcile(await invoke("tts/config")));
      setModels((await invoke("tts/models")).models);
      void loadVoices();
    } catch (err) {
      setError(errText(err));
    }
  });
  onCleanup(stopPreview);

  const save = async (patch: Partial<TtsSettings>) => {
    try {
      await invoke("tts/config_set", patch);
      setTts(reconcile(await invoke("tts/config")));
      if ("model" in patch) void loadVoices();
    } catch (err) {
      notifyError("Couldn't save read-aloud settings", err);
    }
  };

  const preview = async (v: Voice) => {
    setPreviewing(v.id);
    try {
      if (v.previewUrl) {
        try {
          await playUrlOnce(v.previewUrl);
          return;
        } catch { /* blocked or gone: synthesize instead */ }
      }
      await sample(SAMPLE, v.id);
    } catch (err) {
      notifyError("Couldn't play a sample", err);
    } finally {
      setPreviewing(null);
    }
  };

  let speedTimer: ReturnType<typeof setTimeout> | undefined;
  const editSpeed = (value: number) => {
    setTts("speed", value);
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => void save({ speed: value }), 400);
  };

  return (
    <>
      <p class="hint settings-intro">
        Hear your scenes read by a natural voice — the fastest way to catch clumsy rhythm and missing words. It uses the
        connection in <a href="#" onClick={(e) => { e.preventDefault(); openSettings("ai"); }}>AI</a>, billed like any
        other model; listening again to a paragraph you haven't changed is free, because the audio is kept with the book.
      </p>
      <Show when={error()}>
        <p class="hint settings-error">{error()}</p>
      </Show>

      <Row name="Speech model" hint="Gemini 3.8 Flash TTS is the default: natural narration, about $0.12 per thousand words.">
        <ModelPicker value={tts.model} models={models()} placeholder="Choose a speech model…" onChange={(id) => void save({ model: id })} />
      </Row>
      <Row name="Voice" hint="Press ▶ to hear a voice before choosing it.">
        <VoicePicker value={tts.voice} voices={voices()} previewing={previewing()} onPreview={(v) => void preview(v)} onChange={(id) => void save({ voice: id })} />
      </Row>
      <Row name="Narration speed" hint={`${tts.speed.toFixed(2)}× — only some models honour this. The player's speed control changes playback without new audio.`}>
        <input type="range" min="0.5" max="2" step="0.05" value={tts.speed} onInput={(e) => editSpeed(+e.currentTarget.value)} />
      </Row>
      <Row name="Check" hint="Reads one sentence with these settings.">
        <Button disabled={previewing() !== null || !tts.model} onClick={() => void preview({ id: tts.voice, name: tts.voice })}>
          {previewing() === tts.voice ? "Reading…" : "Hear a sample"}
        </Button>
      </Row>
    </>
  );
};
