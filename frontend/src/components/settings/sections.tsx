import { type Component, createMemo, createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Search, X } from "lucide-solid";
import { workbench, updateSettings, THEMES, type ThemeId } from "../../stores/workbench";
import { commandList, formatKeybinding } from "../../commands";
import { project, setProject, notifyError } from "../../stores/app";
import { saveProjectMeta, type BookBrief } from "../../lib/project";
import { targets, saveTargets } from "../../stores/stats";
import { invoke } from "../../lib/rpc";
import type { Dialect as BackendDialect, IgnoredView, StyleChecks } from "../../rpc.gen";
import { recheck } from "../../stores/diagnostics";
import { Button, IconButton, Segmented } from "../ui";

// Settings sections. Each says whether it applies to every book or this one.

export const Row: Component<{ name: string; hint?: string; children: JSX.Element }> = (props) => (
  <div class="settings-row">
    <div class="settings-label">
      <label>{props.name}</label>
      <Show when={props.hint}><div class="hint">{props.hint}</div></Show>
    </div>
    <div class="settings-control">{props.children}</div>
  </div>
);

export const Check: Component<{ checked: boolean; onChange: (v: boolean) => void; children: JSX.Element }> = (props) => (
  <label class="checkbox-row">
    <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
    <span>{props.children}</span>
  </label>
);

// ---------------- Writing ----------------

const FONTS = [
  { label: "Book serif", value: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif" },
  { label: "Iowan Old Style", value: "'Iowan Old Style', 'Palatino Linotype', Palatino, serif" },
  { label: "Palatino", value: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif" },
  { label: "Charter", value: "Charter, 'Bitstream Charter', Georgia, serif" },
  { label: "Baskerville", value: "Baskerville, 'Libre Baskerville', 'Baskerville Old Face', serif" },
  { label: "System sans", value: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" },
  { label: "Monospace", value: "ui-monospace, 'SF Mono', Menlo, monospace" },
];

const SAMPLE = [
  "The fog came in off the water before dawn, thick as wet wool, and by the time Maren reached the harbour wall she could no longer see the lighthouse.",
  "She had been told to wait by the third bollard. Nobody had told her how long.",
  "Somewhere out in the grey a bell was ringing, slow and uneven, as if whoever rang it had forgotten the rhythm halfway through.",
];

/** The page as it will look, updating live as settings change. */
const TypePreview: Component = () => {
  const s = () => workbench.settings;
  return (
    <div class="type-preview" aria-label="Preview">
      <div
        class="type-preview-page"
        classList={{ indent: s().paragraphStyle === "indent" }}
        style={{
          "font-family": s().fontFamily,
          "font-size": `${s().fontSize}px`,
          "line-height": String(s().lineHeight),
          "max-width": `${s().measure}em`,
        }}
      >
        <For each={SAMPLE}>{(p) => <p>{p}</p>}</For>
      </div>
    </div>
  );
};

export const WritingSection: Component = () => {
  const s = () => workbench.settings;
  const knownFont = () => FONTS.some((f) => f.value === s().fontFamily);
  return (
    <>
      <TypePreview />
      <Row name="Typeface" hint="For the page and anywhere your prose is shown.">
        <select class="input" value={knownFont() ? s().fontFamily : "custom"} onChange={(e) => { if (e.currentTarget.value !== "custom") updateSettings({ fontFamily: e.currentTarget.value }); }}>
          <For each={FONTS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
          <option value="custom">Custom…</option>
        </select>
        <Show when={!knownFont()}>
          <input class="input" style={{ "margin-top": "6px" }} value={s().fontFamily} placeholder="Any installed font name" onChange={(e) => updateSettings({ fontFamily: e.currentTarget.value })} />
        </Show>
      </Row>
      <Row name="Size" hint={`${s().fontSize}px`}>
        <input type="range" min="13" max="28" value={s().fontSize} onInput={(e) => updateSettings({ fontSize: +e.currentTarget.value })} />
      </Row>
      <Row name="Line spacing" hint={s().lineHeight.toFixed(2)}>
        <input type="range" min="1.3" max="2.2" step="0.05" value={s().lineHeight} onInput={(e) => updateSettings({ lineHeight: +e.currentTarget.value })} />
      </Row>
      <Row name="Line length" hint={`About ${Math.round(s().measure * 1.75)} characters per line of prose`}>
        <input type="range" min="28" max="90" value={s().measure} onInput={(e) => updateSettings({ measure: +e.currentTarget.value })} />
      </Row>
      <Row name="Paragraphs">
        <Segmented
          value={s().paragraphStyle}
          options={[{ value: "spaced", label: "Spaced" }, { value: "indent", label: "Book (indented)" }]}
          onChange={(v) => updateSettings({ paragraphStyle: v })}
        />
      </Row>
      <Row name="Markdown" hint="Hidden shows formatting as it will read. ⌘⇧M toggles.">
        <Segmented
          value={s().editorMode}
          options={[{ value: "live", label: "Hidden" }, { value: "code", label: "Visible" }]}
          onChange={(v) => updateSettings({ editorMode: v })}
        />
      </Row>
      <Row name="Codex names" hint="Characters and places from the codex, in the text.">
        <Segmented
          value={s().entityHighlight}
          options={[{ value: "hover", label: "Show while ⌘ held" }, { value: "always", label: "Always tinted" }]}
          onChange={(v) => updateSettings({ entityHighlight: v })}
        />
      </Row>
      <Row name="Aids">
        <div class="settings-checks">
          <Check checked={s().typewriterMode} onChange={(v) => updateSettings({ typewriterMode: v })}>Typewriter scrolling — keep the line you're on centred</Check>
          <Check checked={s().focusMode} onChange={(v) => updateSettings({ focusMode: v })}>Focus — dim everything but the current paragraph</Check>
          <Check checked={s().smartTypography} onChange={(v) => updateSettings({ smartTypography: v })}>Smart typography — curly quotes, em dashes from --, … from ...</Check>
        </div>
      </Row>
    </>
  );
};

// ---------------- Appearance ----------------

const Swatch: Component<{ id: ThemeId; label: string }> = (props) => {
  const preview = () => (props.id === "system" ? undefined : props.id);
  return (
    <button
      type="button"
      class="swatch"
      classList={{ active: workbench.settings.theme === props.id }}
      aria-pressed={workbench.settings.theme === props.id}
      onClick={() => updateSettings({ theme: props.id })}
    >
      <Show
        when={preview()}
        fallback={
          <div class="swatch-page swatch-split">
            <div data-theme-preview="light" class="swatch-half"><span class="swatch-line" /><span class="swatch-line short" /></div>
            <div data-theme-preview="dark" class="swatch-half"><span class="swatch-line" /><span class="swatch-line short" /></div>
          </div>
        }
      >
        <div class="swatch-page" data-theme-preview={preview()}>
          <span class="swatch-accent" />
          <span class="swatch-line" />
          <span class="swatch-line" />
          <span class="swatch-line short" />
        </div>
      </Show>
      <span class="swatch-label">{props.label}</span>
    </button>
  );
};

export const AppearanceSection: Component = () => (
  <>
    <Row name="Page width" hint={workbench.settings.pageWidth > 0 ? `Codex pages, history and reports: up to about ${workbench.settings.pageWidth * 16}px wide` : "Codex pages, history and reports fill the window"}>
      <input
        type="range"
        min="40"
        max="140"
        step="4"
        disabled={workbench.settings.pageWidth === 0}
        value={workbench.settings.pageWidth || 56}
        onInput={(e) => updateSettings({ pageWidth: +e.currentTarget.value })}
      />
      <Check checked={workbench.settings.pageWidth === 0} onChange={(v) => updateSettings({ pageWidth: v ? 0 : 56 })}>
        Use the full width
      </Check>
    </Row>
    <h4 class="settings-group">Follow the system</h4>
    <div class="swatch-grid">
      <Swatch id="system" label="System" />
    </div>
    <h4 class="settings-group">Light</h4>
    <div class="swatch-grid">
      <For each={THEMES.filter((t) => t.light)}>{(t) => <Swatch id={t.id} label={t.label} />}</For>
    </div>
    <h4 class="settings-group">Dark</h4>
    <div class="swatch-grid">
      <For each={THEMES.filter((t) => t.id !== "system" && !t.light)}>{(t) => <Swatch id={t.id} label={t.label} />}</For>
    </div>
  </>
);

// ---------------- Spelling & grammar ----------------

type Dialect = BackendDialect;

type IgnoredRule = IgnoredView;

export const SpellingSection: Component = () => {
  const [dialect, { mutate: setDialectLocal }] = createResource(async () => {
    try {
      return (await invoke("diag/get_dialect")).dialect;
    } catch {
      return null;
    }
  });
  const [words, { refetch: refetchWords }] = createResource(async () => {
    try {
      return (await invoke("diag/dictionary")).words;
    } catch {
      return null;
    }
  });
  const [ignored, { refetch: refetchIgnored }] = createResource(async () => {
    try {
      return (await invoke("diag/ignored")).ignored;
    } catch {
      return null;
    }
  });
  const [style, { mutate: setStyleLocal }] = createResource(async () => {
    try {
      return await invoke("diag/style_get");
    } catch {
      return null;
    }
  });
  const [filter, setFilter] = createSignal("");

  const setStyle = async (patch: Partial<StyleChecks>) => {
    const prev = style();
    if (prev) setStyleLocal({ ...prev, ...patch });
    try {
      setStyleLocal(await invoke("diag/style_set", patch));
      void recheck();
    } catch (err) {
      setStyleLocal(prev);
      notifyError("Couldn't change the style checks", err);
    }
  };

  const setDialect = async (d: Dialect) => {
    setDialectLocal(d);
    try {
      await invoke("diag/set_dialect", { dialect: d });
      void recheck();
    } catch (err) {
      notifyError("Couldn't change the dialect", err);
    }
  };
  const removeWord = async (word: string) => {
    try {
      await invoke("diag/remove_word", { word });
      void refetchWords();
      void recheck();
    } catch (err) {
      notifyError("Couldn't remove the word", err);
    }
  };
  const unignore = async (r: IgnoredRule) => {
    try {
      await invoke("diag/unignore", { ruleId: r.ruleId, file: r.file, text: r.text });
      void refetchIgnored();
      void recheck();
    } catch (err) {
      notifyError("Couldn't turn it back on", err);
    }
  };

  const shownWords = () => (words() ?? []).filter((w) => w.toLowerCase().includes(filter().toLowerCase()));

  return (
    <>
      <Row name="English" hint="Which spellings count as correct.">
        <Show when={dialect() !== null} fallback={<span class="hint">Available once a project is open.</span>}>
          <Segmented<Dialect>
            value={dialect() ?? "american"}
            options={[
              { value: "british", label: "British" },
              { value: "american", label: "American" },
              { value: "canadian", label: "Canadian" },
              { value: "australian", label: "Australian" },
              { value: "indian", label: "Indian" },
            ]}
            onChange={(v) => void setDialect(v)}
          />
        </Show>
      </Row>
      <Row name="Style" hint="Gentle hints about habits in the prose. They appear in Review alongside spelling and grammar.">
        <Show when={style()} fallback={<span class="hint">Available once a project is open.</span>}>
          {(st) => (
            <div class="settings-checks">
              <Check checked={st().echoes} onChange={(v) => void setStyle({ echoes: v })}>
                Echoes — the same word used again within a few lines
              </Check>
              <Check checked={st().adverbTags} onChange={(v) => void setStyle({ adverbTags: v })}>
                Adverbs on dialogue — “said softly”, “angrily asked”
              </Check>
              <Check checked={st().rhythm} onChange={(v) => void setStyle({ rhythm: v })}>
                Rhythm — five or more sentences in a row of the same length
              </Check>
              <Check checked={st().filterWords} onChange={(v) => void setStyle({ filterWords: v })}>
                Filter words — “just”, “really”, “suddenly” and the like
              </Check>
            </div>
          )}
        </Show>
      </Row>
      <Row name="Your dictionary" hint="Words you've added. Codex names are always accepted.">
        <Show when={words() !== null} fallback={<span class="hint">Unavailable.</span>}>
          <div class="settings-list">
            <div class="settings-list-search">
              <Search size={13} />
              <input placeholder={`Filter ${words()?.length ?? 0} words…`} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
            </div>
            <div class="settings-list-body">
              <For each={shownWords()} fallback={<div class="hint settings-list-empty">No words yet.</div>}>
                {(w) => (
                  <div class="list-row">
                    <span class="settings-word">{w}</span>
                    <span class="row-actions"><IconButton size="sm" label={`Remove “${w}”`} onClick={() => void removeWord(w)}><X size={12} /></IconButton></span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Row>
      <Row name="Turned off" hint="Rules and words you've told the checker to ignore.">
        <Show when={ignored() !== null} fallback={<span class="hint">Unavailable.</span>}>
          <div class="settings-list">
            <div class="settings-list-body">
              <For each={ignored() ?? []} fallback={<div class="hint settings-list-empty">Nothing turned off.</div>}>
                {(r) => (
                  <div class="list-row">
                    <span class="settings-rule">
                      <span>{r.label}</span>
                      <span class="hint">{r.file === "*" ? "everywhere" : `“${r.text}” in ${r.file.split("/").pop()!.replace(/\.md$/, "")}`}</span>
                    </span>
                    <span class="row-actions"><Button size="sm" variant="ghost" onClick={() => void unignore(r)}>Turn back on</Button></span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Row>
    </>
  );
};

// ---------------- Goals ----------------

export const GoalsSection: Component = () => {
  const set = (patch: Partial<ReturnType<typeof targets>>) => void saveTargets({ ...targets(), ...patch });
  return (
    <>
      <Row name="Daily goal" hint="Words written per day. Shown as the ring in the footer.">
        <input class="input settings-number" type="number" min="0" step="50" value={targets().dailyTarget} onChange={(e) => set({ dailyTarget: Math.max(0, +e.currentTarget.value || 0) })} />
      </Row>
      <Row name="Book length" hint="Target length for the whole manuscript.">
        <input class="input settings-number" type="number" min="0" step="1000" value={targets().projectTarget} onChange={(e) => set({ projectTarget: Math.max(0, +e.currentTarget.value || 0) })} />
      </Row>
    </>
  );
};

// ---------------- This book ----------------

export const BookSection: Component = () => {
  const meta = () => project.meta;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (patch: { name?: string; author?: string; brief?: BookBrief }) => {
    const current = meta() ?? { name: "" };
    const next = { ...current, ...patch, brief: { ...current.brief, ...patch.brief } };
    setProject("meta", next);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await saveProjectMeta(next);
      } catch (err) {
        notifyError("Couldn't save the book details", err);
      }
    }, 500);
  };
  onCleanup(() => clearTimeout(timer));
  const brief = () => meta()?.brief ?? {};
  const field = (key: keyof BookBrief, placeholder: string, multiline = false) =>
    multiline ? (
      <textarea class="input" rows={4} placeholder={placeholder} value={brief()[key] ?? ""} onInput={(e) => save({ brief: { [key]: e.currentTarget.value } })} />
    ) : (
      <input class="input" placeholder={placeholder} value={brief()[key] ?? ""} onInput={(e) => save({ brief: { [key]: e.currentTarget.value } })} />
    );

  return (
    <Show when={project.root} fallback={<p class="hint">Open a project to edit its details.</p>}>
      <Row name="Title">
        <input class="input settings-title" value={meta()?.name ?? ""} onInput={(e) => save({ name: e.currentTarget.value })} />
      </Row>
      <Row name="Author">
        <input class="input" value={meta()?.author ?? ""} onInput={(e) => save({ author: e.currentTarget.value })} />
      </Row>
      <h4 class="settings-group">About this book</h4>
      <p class="hint settings-intro">
        The agent reads this before everything it does — continuity, critique, chat. It's what lets it tell a
        deliberate mystery from a mistake.
      </p>
      <Row name="Genre">{field("genre", "e.g. literary fantasy, cosy mystery")}</Row>
      <Row name="Readers">{field("audience", "Who it's for — e.g. adult readers of Robin Hobb")}</Row>
      <Row name="Narration" hint="Point of view and tense.">{field("narration", "e.g. close third, past tense, alternating Maren and Ilse")}</Row>
      <Row name="Comparable books">{field("comparables", "e.g. The Night Circus, Piranesi")}</Row>
      <Row name="Tone">{field("tone", "e.g. melancholy, wry, slow-burning")}</Row>
      <Row name="Notes for the agent" hint="Deliberate ambiguities, unreliable narrators, house style.">
        {field("notes", "e.g. The prologue is deliberately misleading. Ilse lies about her age throughout.", true)}
      </Row>
    </Show>
  );
};

// ---------------- Shortcuts ----------------

export const ShortcutsSection: Component = () => {
  const [q, setQ] = createSignal("");
  const bound = createMemo(() =>
    commandList()
      .filter((c) => c.keybinding)
      .filter((c) => c.title.toLowerCase().includes(q().toLowerCase()))
      .sort((a, b) => a.title.localeCompare(b.title)),
  );
  const editorKeys = [
    ["Bold", "Mod+B"], ["Italic", "Mod+I"], ["Find in scene", "Mod+F"], ["Undo", "Mod+Z"], ["Redo", "Mod+Shift+Z"],
  ];
  return (
    <>
      <div class="settings-list-search standalone">
        <Search size={13} />
        <input placeholder="Filter shortcuts…" value={q()} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      <div class="shortcut-table">
        <For each={bound()}>
          {(c) => (
            <div class="shortcut-row">
              <span>{c.title}</span>
              <kbd class="kbd">{formatKeybinding(c.keybinding!)}</kbd>
            </div>
          )}
        </For>
        <Show when={!q()}>
          <h4 class="settings-group">In the text</h4>
          <For each={editorKeys}>
            {([title, key]) => (
              <div class="shortcut-row"><span>{title}</span><kbd class="kbd">{formatKeybinding(key)}</kbd></div>
            )}
          </For>
        </Show>
      </div>
    </>
  );
};

