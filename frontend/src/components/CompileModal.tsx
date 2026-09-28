import { type Component, type JSX, createEffect, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { GripVertical } from "lucide-solid";
import { workbench, setWorkbench } from "../stores/workbench";
import { buildTree, buildCompileChapters, buildMatter, chapterName, ORDER_FILE, type CompileChapter, type OrderMap } from "../lib/binderTree";
import { loadProjectMeta } from "../lib/project";
import { Button, Modal } from "./ui";
import "./CompileModal.css";
import { MissingTool } from "./shell/MissingTool";
import { tools } from "../stores/tools";

interface CompileModalProps {
  /** Called after scene reordering writes order.json, so the binder refetches. */
  onOrderChanged?: () => void;
}

// Compile settings mirror the backend's CompileSettings (camelCase over RPC).
interface CompileConfig {
  title: string;
  author: string;
  paper: "a4" | "a5" | "us-letter";
  fontSize: number;
  fontFamily: string;
  lineSpacing: number;
  justify: boolean;
  firstLineIndent: boolean;
  titlePage: boolean;
  chapterPageBreaks: boolean;
  numbering: boolean;
  sceneSeparator: string;
  customPreamble: string;
  format: "pdf" | "typst" | "markdown";
  template: string;
  include: Record<string, boolean>;
}

/** Aesthetic presets; picking one also applies its recommended knob values. */
const TEMPLATES: { id: string; label: string; presets: Partial<CompileConfig> }[] = [
  {
    id: "modern-novel", label: "Modern Novel",
    presets: { paper: "a5", fontSize: 11, fontFamily: "", lineSpacing: 0.85, justify: true, firstLineIndent: true, sceneSeparator: "* * *" },
  },
  {
    id: "classic-manuscript", label: "Classic Manuscript",
    presets: { paper: "us-letter", fontSize: 12, fontFamily: "Courier New", lineSpacing: 1.7, justify: false, firstLineIndent: true, sceneSeparator: "#" },
  },
  {
    id: "elegant-book", label: "Elegant Book",
    presets: { paper: "a5", fontSize: 10.5, fontFamily: "", lineSpacing: 0.95, justify: true, firstLineIndent: true, sceneSeparator: "❦" },
  },
  {
    id: "plain", label: "Plain",
    presets: { paper: "a4", fontSize: 12, fontFamily: "", lineSpacing: 1, justify: false, firstLineIndent: false, sceneSeparator: "* * *" },
  },
];

const DEFAULT_CONFIG: CompileConfig = {
  title: "",
  author: "",
  paper: "a5",
  fontSize: 11,
  fontFamily: "",
  lineSpacing: 0.85,
  justify: true,
  firstLineIndent: true,
  titlePage: true,
  chapterPageBreaks: true,
  numbering: true,
  sceneSeparator: "* * *",
  customPreamble: "",
  format: "pdf",
  template: "modern-novel",
  include: {},
};

const FORMAT_META: Record<CompileConfig["format"], { label: string; ext: string; filter: string }> = {
  pdf: { label: "PDF", ext: "pdf", filter: "PDF" },
  typst: { label: "Typst source (.typ)", ext: "typ", filter: "Typst" },
  markdown: { label: "Markdown (single file)", ext: "md", filter: "Markdown" },
};

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string) => p.split("/").pop()!;

export const CompileModal: Component<CompileModalProps> = (props) => {
  const [chapters, setChapters] = createSignal<CompileChapter[]>([]);
  const [matter, setMatter] = createSignal<{ front: string[]; back: string[] }>({ front: [], back: [] });
  const [config, setConfig] = createStore<CompileConfig>({ ...DEFAULT_CONFIG });
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; message: string } | null>(null);

  const close = () => setWorkbench("isCompileOpen", false);

  const STARTERS: Record<string, { path: string; content: string }> = {
    "Front Matter": {
      path: "Front Matter/Copyright.md",
      content: "Copyright \u00a9 " + new Date().getFullYear() + " Your Name\n\nAll rights reserved. This is a work of fiction. Names, characters, places, and incidents are products of the author's imagination or are used fictitiously.\n",
    },
    "Back Matter": {
      path: "Back Matter/Acknowledgements.md",
      content: "## Acknowledgements\n\nThank the people who kept you writing.\n",
    },
  };

  const createMatter = async (which: "Front Matter" | "Back Matter") => {
    try {
      await window.chronicler.invoke("project/create_folder", { path: which });
      const starter = STARTERS[which];
      await window.chronicler.invoke("document/save", { path: starter.path, content: starter.content });
      await loadChapters();
      props.onOrderChanged?.();
    } catch (err: any) {
      setResult({ ok: false, message: `Couldn't create ${which}: ${err.message}` });
    }
  };

  const MatterSection: Component<{ label: string; which: "Front Matter" | "Back Matter"; scenes: string[] }> = (mp) => (
    <div>
      <div class="section-label">
        {mp.label}
        <Show when={mp.scenes.length === 0}>
          <button type="button" class="compile-add" onClick={() => createMatter(mp.which)}>+ add</button>
        </Show>
      </div>
      <Show when={mp.scenes.length === 0}>
        <p class="hint compile-note">
          Pages in a "{mp.which}" folder compile {mp.which === "Front Matter" ? "before chapter one, unnumbered" : "after the last chapter"}.
        </p>
      </Show>
      <For each={mp.scenes}>
        {(scene) => (
          <label class="compile-scene matter" classList={{ excluded: !included(scene) }}>
            <input
              type="checkbox"
              checked={included(scene)}
              onChange={(e) => setConfig("include", scene, e.currentTarget.checked)}
            />
            <span>{chapterName(basename(scene))}</span>
          </label>
        )}
      </For>
    </div>
  );

  const loadChapters = async () => {
    try {
      const res = await window.chronicler.invoke("project/list_files");
      let order: OrderMap = {};
      try {
        const o = await window.chronicler.invoke("document/read", { path: ORDER_FILE });
        order = JSON.parse(o.content);
      } catch { /* no manual order yet */ }
      const tree = buildTree(res.files, order);
      setChapters(buildCompileChapters(tree));
      setMatter(buildMatter(tree));
    } catch {
      setChapters([]);
      setMatter({ front: [], back: [] });
    }
  };

  createEffect(() => {
    if (!workbench.isCompileOpen) return;
    setResult(null);
    (async () => {
      await loadChapters();
      // Persisted settings from the project db
      try {
        const stored = await window.chronicler.invoke("db/get", { key: "compile" });
        if (stored.value) setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(stored.value) });
      } catch { /* defaults */ }
      // Never compiled before: the title page starts from what the New Project
      // wizard was told rather than blank.
      if (!config.title && !config.author) {
        const meta = await loadProjectMeta();
        if (meta) setConfig({ title: meta.name, author: meta.author ?? "" });
      }
    })();
  });

  const saveOrderEntry = async (dirPath: string, names: string[]) => {
    let order: OrderMap = {};
    try {
      const o = await window.chronicler.invoke("document/read", { path: ORDER_FILE });
      order = JSON.parse(o.content);
    } catch { /* start fresh */ }
    order[dirPath] = names;
    try {
      await window.chronicler.invoke("document/save", { path: ORDER_FILE, content: JSON.stringify(order, null, 2) });
    } catch { /* non-fatal */ }
    await loadChapters();
    props.onOrderChanged?.();
  };

  /** Reorder a scene within its chapter folder by rewriting order.json. */
  const reorderScene = async (chapter: CompileChapter, fromPath: string, toPath: string, before: boolean) => {
    if (fromPath === toPath) return;
    // Only scenes directly inside the chapter folder can be reordered here
    if (parentOf(fromPath) !== chapter.key || parentOf(toPath) !== chapter.key) return;

    const names = chapter.scenes
      .filter(s => parentOf(s) === chapter.key)
      .map(basename)
      .filter(n => n !== basename(fromPath));
    let idx = names.indexOf(basename(toPath));
    if (idx === -1) idx = names.length;
    if (!before) idx += 1;
    names.splice(idx, 0, basename(fromPath));
    await saveOrderEntry(chapter.key, names);
  };

  /** Reorder chapters (root-level entries) by rewriting order.json's root list. */
  const reorderChapter = async (fromKey: string, toKey: string, before: boolean) => {
    if (fromKey === toKey) return;
    const names = chapters().map(c => basename(c.key)).filter(n => n !== basename(fromKey));
    let idx = names.indexOf(basename(toKey));
    if (idx === -1) idx = names.length;
    if (!before) idx += 1;
    names.splice(idx, 0, basename(fromKey));
    await saveOrderEntry("", names);
  };

  const dropHalf = (e: DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    return e.clientY - el.getBoundingClientRect().top < el.getBoundingClientRect().height / 2;
  };

  /** Show where a drop would land: a rule above or below the row. */
  const markDrop = (e: DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    const before = dropHalf(e);
    el.classList.toggle("drop-before", before);
    el.classList.toggle("drop-after", !before);
  };
  const clearDrop = (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-before", "drop-after");

  const included = (key: string) => config.include[key] !== false; // default: included

  const persist = () =>
    window.chronicler.invoke("db/set", { key: "compile", value: JSON.stringify({ ...config, include: { ...config.include } }) });

  const compile = async () => {
    const selected = chapters()
      .filter(c => included(c.key))
      .map(c => ({ ...c, scenes: c.scenes.filter(s => s === c.key || included(s)) }))
      .filter(c => c.scenes.length > 0);
    if (selected.length === 0) {
      setResult({ ok: false, message: "No chapters selected." });
      return;
    }
    const meta = FORMAT_META[config.format];
    const defaultName = `${(config.title || "manuscript").replace(/[/\\:]/g, "-")}.${meta.ext}`;
    setBusy(true);
    setResult(null);
    try {
      await persist();
      const res = await window.chronicler.invoke("compile/run", {
        chapters: selected.map(c => ({ title: c.title, scenes: c.scenes })),
        frontMatter: matter().front.filter(included),
        backMatter: matter().back.filter(included),
        settings: (({ include: _, ...rest }) => rest)(config),
      });
      // Main shows the save dialog; the renderer never picks a destination path.
      const saved = await window.chronicler.exportCompiled(res.output, { defaultName });
      if (saved.canceled) setResult({ ok: true, message: "Compiled — not exported." });
      else setResult({ ok: true, message: `Exported to ${saved.path}` });
    } catch (err: any) {
      setResult({ ok: false, message: err.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, control: JSX.Element) => (
    <div class="field">
      <label>{label}</label>
      {control}
    </div>
  );

  return (
    <Show when={workbench.isCompileOpen}>
      <Modal
        title="Compile manuscript"
        wide
        onClose={close}
        footer={
          <>
            <div class="compile-result" classList={{ ok: !!result()?.ok, error: !!result() && !result()!.ok }}>
              {result()?.message ?? ""}
            </div>
            <Button variant="ghost" onClick={close}>Close</Button>
            <Button variant="primary" onClick={compile} disabled={busy()}>
              {busy() ? "Compiling…" : "Compile…"}
            </Button>
          </>
        }
      >
        <Show when={config.format === "pdf" && tools() && !tools()!.typst}>
          <MissingTool tool="typst" />
        </Show>
        <div class="compile-layout">
          {/* Contents */}
          <div class="compile-contents">
            <div class="compile-contents-scroll">
              <MatterSection label="Front matter" which="Front Matter" scenes={matter().front} />
              <div class="section-label">Chapters</div>
              <For each={chapters()}>
                {(chapter, i) => (
                  <div>
                    <label
                      class="compile-chapter"
                      classList={{ excluded: !included(chapter.key) }}
                      draggable={true}
                      onDragStart={(e) => e.dataTransfer?.setData("chronicler/chapter", chapter.key)}
                      onDragOver={(e) => { e.preventDefault(); markDrop(e); }}
                      onDragLeave={clearDrop}
                      onDrop={(e) => {
                        e.preventDefault();
                        const before = dropHalf(e);
                        clearDrop(e);
                        const from = e.dataTransfer?.getData("chronicler/chapter");
                        if (from) reorderChapter(from, chapter.key, before);
                      }}
                    >
                      <GripVertical size={12} class="compile-grip" />
                      <input
                        type="checkbox"
                        checked={included(chapter.key)}
                        onChange={(e) => setConfig("include", chapter.key, e.currentTarget.checked)}
                      />
                      <span class="compile-chapter-title">
                        {config.numbering ? `${i() + 1}. ` : ""}{chapter.title || "(untitled)"}
                      </span>
                      <span class="compile-chapter-meta">
                        {chapter.scenes.length > 1 ? `${chapter.scenes.length} scenes` : ""}
                      </span>
                    </label>
                    {/* Scenes: shown for folder chapters, draggable to reorder */}
                    <Show when={chapter.scenes.length > 1 || chapter.key !== chapter.scenes[0]}>
                      <For each={chapter.scenes}>
                        {(scene) => {
                          const draggable = parentOf(scene) === chapter.key;
                          return (
                            <div
                              class="compile-scene"
                              classList={{ draggable, excluded: !included(scene) }}
                              draggable={draggable}
                              onDragStart={(e) => e.dataTransfer?.setData("chronicler/scene", JSON.stringify({ chapter: chapter.key, path: scene }))}
                              onDragOver={(e) => { e.preventDefault(); markDrop(e); }}
                              onDragLeave={clearDrop}
                              onDrop={(e) => {
                                e.preventDefault();
                                const before = dropHalf(e);
                                clearDrop(e);
                                const raw = e.dataTransfer?.getData("chronicler/scene");
                                if (!raw) return;
                                const from = JSON.parse(raw);
                                if (from.chapter === chapter.key) reorderScene(chapter, from.path, scene, before);
                              }}
                              title={draggable ? "Drag to reorder" : "Nested scenes are ordered in the binder"}
                            >
                              <GripVertical size={11} class="compile-grip" />
                              <input
                                type="checkbox"
                                checked={included(scene)}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setConfig("include", scene, e.currentTarget.checked)}
                              />
                              <span>{chapterName(basename(scene))}</span>
                            </div>
                          );
                        }}
                      </For>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={chapters().length === 0}>
                <div class="compile-empty">No chapters yet</div>
              </Show>
              <MatterSection label="Back matter" which="Back Matter" scenes={matter().back} />
            </div>
          </div>

          {/* Settings */}
          <div class="compile-settings">
            <div class="field">
              <label>Template</label>
              <select
                class="input"
                value={config.template}
                onChange={(e) => {
                  const t = TEMPLATES.find(t => t.id === e.currentTarget.value);
                  if (t) setConfig({ template: t.id, ...t.presets });
                }}
              >
                <For each={TEMPLATES}>
                  {(t) => <option value={t.id}>{t.label}</option>}
                </For>
              </select>
              <p class="hint">
                Picking a template applies its recommended settings below — tweak freely after.
              </p>
            </div>

            <div class="compile-grid">
              {field("Title", <input class="input" type="text" value={config.title} onChange={e => setConfig("title", e.currentTarget.value)} />)}
              {field("Author", <input class="input" type="text" value={config.author} onChange={e => setConfig("author", e.currentTarget.value)} />)}
              {field("Paper", (
                <select class="input" value={config.paper} onChange={e => setConfig("paper", e.currentTarget.value as any)}>
                  <option value="a4">A4</option>
                  <option value="a5">A5</option>
                  <option value="us-letter">US Letter</option>
                </select>
              ))}
              {field("Font (blank for the default)", <input class="input" type="text" value={config.fontFamily} placeholder="e.g. Georgia" onChange={e => setConfig("fontFamily", e.currentTarget.value)} />)}
              {field("Font size (pt)", <input class="input" type="number" min="8" max="18" step="0.5" value={config.fontSize} onChange={e => setConfig("fontSize", parseFloat(e.currentTarget.value) || 12)} />)}
              {field("Line spacing (em)", <input class="input" type="number" min="0.4" max="2" step="0.05" value={config.lineSpacing} onChange={e => setConfig("lineSpacing", parseFloat(e.currentTarget.value) || 0.85)} />)}
              {field("Scene separator", <input class="input" type="text" value={config.sceneSeparator} onChange={e => setConfig("sceneSeparator", e.currentTarget.value)} />)}
              {field("Format", (
                <select class="input" value={config.format} onChange={e => setConfig("format", e.currentTarget.value as any)}>
                  <For each={Object.entries(FORMAT_META)}>
                    {([value, meta]) => <option value={value}>{meta.label}</option>}
                  </For>
                </select>
              ))}
            </div>

            <div class="compile-checks">
              <For each={[
                ["titlePage", "Title page"],
                ["chapterPageBreaks", "Page break per chapter"],
                ["numbering", "Number chapters"],
                ["justify", "Justify text"],
                ["firstLineIndent", "First-line indent"],
              ] as [keyof CompileConfig, string][]}>
                {([key, label]) => (
                  <label class="checkbox-row">
                    <input
                      type="checkbox"
                      checked={config[key] as boolean}
                      onChange={(e) => setConfig(key, e.currentTarget.checked as any)}
                    />
                    {label}
                  </label>
                )}
              </For>
            </div>

            {field("Custom Typst rules (advanced — added after the template's own)", (
              <textarea
                class="input compile-preamble"
                placeholder={"#set par(spacing: 1.2em)\n#show emph: set text(fill: rgb(60, 60, 90))"}
                value={config.customPreamble}
                onChange={e => setConfig("customPreamble", e.currentTarget.value)}
              />
            ))}
          </div>
        </div>
      </Modal>
    </Show>
  );
};
