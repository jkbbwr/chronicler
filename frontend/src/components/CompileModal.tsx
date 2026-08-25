import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { X, BookOpen } from "lucide-solid";
import { workbench, setWorkbench } from "../stores/workbench";
import { buildTree, buildCompileChapters, ORDER_FILE, type CompileChapter } from "../lib/binderTree";

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
  include: Record<string, boolean>;
}

const DEFAULT_CONFIG: CompileConfig = {
  title: "",
  author: "",
  paper: "a4",
  fontSize: 12,
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
  include: {},
};

const FORMAT_META: Record<CompileConfig["format"], { label: string; ext: string; filter: string }> = {
  pdf: { label: "PDF (via Typst)", ext: "pdf", filter: "PDF" },
  typst: { label: "Typst source", ext: "typ", filter: "Typst" },
  markdown: { label: "Markdown (single file)", ext: "md", filter: "Markdown" },
};

const labelStyle = { display: "block", "margin-bottom": "5px", "font-size": "12px", color: "var(--text-muted)" } as const;
const inputStyle = {
  width: "100%", padding: "7px 9px", background: "var(--bg-color)",
  border: "1px solid var(--border-color)", color: "var(--text-main)",
  "border-radius": "5px", outline: "none", "font-size": "13px",
} as const;

export const CompileModal: Component = () => {
  const [chapters, setChapters] = createSignal<CompileChapter[]>([]);
  const [config, setConfig] = createStore<CompileConfig>({ ...DEFAULT_CONFIG });
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; message: string } | null>(null);

  const close = () => setWorkbench("isCompileOpen", false);

  createEffect(() => {
    if (!workbench.isCompileOpen) return;
    setResult(null);
    (async () => {
      // Content structure, in binder order
      try {
        const res = await window.chronicler.invoke("project/list_files");
        let order = {};
        try {
          const o = await window.chronicler.invoke("document/read", { rel_path: ORDER_FILE });
          order = JSON.parse(o.content);
        } catch { /* no manual order yet */ }
        setChapters(buildCompileChapters(buildTree(res.files, order)));
      } catch {
        setChapters([]);
      }
      // Persisted settings from the project db
      try {
        const stored = await window.chronicler.invoke("db/get", { key: "compile" });
        if (stored.value) setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(stored.value) });
      } catch { /* defaults */ }
    })();
  });

  const included = (key: string) => config.include[key] !== false; // default: included

  const persist = () =>
    window.chronicler.invoke("db/set", { key: "compile", value: JSON.stringify({ ...config, include: { ...config.include } }) });

  const compile = async () => {
    const selected = chapters().filter(c => included(c.key));
    if (selected.length === 0) {
      setResult({ ok: false, message: "No chapters selected." });
      return;
    }
    const meta = FORMAT_META[config.format];
    const defaultName = `${(config.title || "manuscript").replace(/[/\\:]/g, "-")}.${meta.ext}`;
    const dialog = await window.chronicler.showSaveDialog({
      title: "Export Compiled Manuscript",
      defaultPath: defaultName,
      filters: [{ name: meta.filter, extensions: [meta.ext] }],
    });
    if (dialog.canceled || !dialog.filePath) return;

    setBusy(true);
    setResult(null);
    try {
      await persist();
      const res = await window.chronicler.invoke("compile/run", {
        chapters: selected.map(c => ({ title: c.title, scenes: c.scenes })),
        settings: { ...config, include: undefined },
      });
      await window.chronicler.exportCompiled(res.output, dialog.filePath);
      setResult({ ok: true, message: `Exported to ${dialog.filePath}` });
    } catch (err: any) {
      setResult({ ok: false, message: err.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={workbench.isCompileOpen}>
      <div
        style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)", "backdrop-filter": "blur(2px)", "z-index": 2000,
          display: "flex", "justify-content": "center", "align-items": "center",
        }}
        onClick={close}
      >
        <div
          style={{
            background: "var(--panel-bg)", width: "860px", height: "600px",
            border: "1px solid var(--border-color)", "border-radius": "10px",
            display: "flex", "flex-direction": "column", overflow: "hidden",
            "box-shadow": "0 15px 50px rgba(0,0,0,0.6)",
          }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ padding: "14px 20px", display: "flex", "align-items": "center", "justify-content": "space-between", "border-bottom": "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", color: "var(--text-main)", "font-size": "14px", "font-weight": 600 }}>
              <BookOpen size={16} /> Compile Manuscript
            </div>
            <X size={18} style={{ cursor: "pointer", color: "var(--text-muted)" }} onClick={close} />
          </div>

          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {/* Contents */}
            <div style={{ width: "300px", "border-right": "1px solid var(--border-color)", display: "flex", "flex-direction": "column" }}>
              <div style={{ padding: "12px 15px 6px", "font-size": "11px", "font-weight": 600, "text-transform": "uppercase", "letter-spacing": "0.5px", color: "var(--text-muted)" }}>
                Contents
              </div>
              <div style={{ "overflow-y": "auto", flex: 1, padding: "0 0 10px" }}>
                <For each={chapters()}>
                  {(chapter, i) => (
                    <label style={{ display: "flex", "align-items": "center", gap: "8px", padding: "6px 15px", cursor: "pointer", "font-size": "13px", color: included(chapter.key) ? "var(--text-main)" : "var(--text-faint)" }}>
                      <input
                        type="checkbox"
                        checked={included(chapter.key)}
                        onChange={(e) => setConfig("include", chapter.key, e.currentTarget.checked)}
                      />
                      <span style={{ flex: 1, "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                        {config.numbering ? `${i() + 1}. ` : ""}{chapter.title || "(untitled)"}
                      </span>
                      <span style={{ "font-size": "11px", color: "var(--text-faint)" }}>
                        {chapter.scenes.length > 1 ? `${chapter.scenes.length} scenes` : ""}
                      </span>
                    </label>
                  )}
                </For>
                <Show when={chapters().length === 0}>
                  <div style={{ padding: "10px 15px", color: "var(--text-faint)", "font-size": "12px" }}>No content found</div>
                </Show>
              </div>
            </div>

            {/* Settings */}
            <div style={{ flex: 1, "overflow-y": "auto", padding: "15px 20px" }}>
              <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "14px" }}>
                <div>
                  <label style={labelStyle}>Title</label>
                  <input style={inputStyle} type="text" value={config.title} onChange={e => setConfig("title", e.currentTarget.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Author</label>
                  <input style={inputStyle} type="text" value={config.author} onChange={e => setConfig("author", e.currentTarget.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Paper</label>
                  <select style={inputStyle} value={config.paper} onChange={e => setConfig("paper", e.currentTarget.value as any)}>
                    <option value="a4">A4</option>
                    <option value="a5">A5</option>
                    <option value="us-letter">US Letter</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Font family (blank = Typst default)</label>
                  <input style={inputStyle} type="text" value={config.fontFamily} placeholder="e.g. Georgia" onChange={e => setConfig("fontFamily", e.currentTarget.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Font size (pt)</label>
                  <input style={inputStyle} type="number" min="8" max="18" step="0.5" value={config.fontSize} onChange={e => setConfig("fontSize", parseFloat(e.currentTarget.value) || 12)} />
                </div>
                <div>
                  <label style={labelStyle}>Line spacing (em)</label>
                  <input style={inputStyle} type="number" min="0.4" max="2" step="0.05" value={config.lineSpacing} onChange={e => setConfig("lineSpacing", parseFloat(e.currentTarget.value) || 0.85)} />
                </div>
                <div>
                  <label style={labelStyle}>Scene separator</label>
                  <input style={inputStyle} type="text" value={config.sceneSeparator} onChange={e => setConfig("sceneSeparator", e.currentTarget.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Format</label>
                  <select style={inputStyle} value={config.format} onChange={e => setConfig("format", e.currentTarget.value as any)}>
                    <For each={Object.entries(FORMAT_META)}>
                      {([value, meta]) => <option value={value}>{meta.label}</option>}
                    </For>
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "8px 14px", "margin-top": "16px" }}>
                <For each={[
                  ["titlePage", "Title page"],
                  ["chapterPageBreaks", "Page break per chapter"],
                  ["numbering", "Number chapters"],
                  ["justify", "Justify text"],
                  ["firstLineIndent", "First-line indent"],
                ] as [keyof CompileConfig, string][]}>
                  {([key, label]) => (
                    <label style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "13px", color: "var(--text-main)", cursor: "pointer" }}>
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

              <div style={{ "margin-top": "18px" }}>
                <label style={labelStyle}>Custom Typst preamble (advanced — appended after generated rules)</label>
                <textarea
                  style={{ ...inputStyle, height: "90px", resize: "vertical", "font-family": "ui-monospace, Menlo, monospace", "font-size": "12px" }}
                  placeholder={"#set par(spacing: 1.2em)\n#show emph: set text(fill: rgb(60, 60, 90))"}
                  value={config.customPreamble}
                  onChange={e => setConfig("customPreamble", e.currentTarget.value)}
                />
              </div>
            </div>
          </div>

          <div style={{ padding: "12px 20px", "border-top": "1px solid var(--border-color)", display: "flex", "align-items": "center", gap: "12px" }}>
            <div style={{ flex: 1, "font-size": "12px", color: result()?.ok ? "var(--accent)" : "#e06c75", "white-space": "pre-wrap", "max-height": "60px", "overflow-y": "auto", "user-select": "text" }}>
              {result()?.message ?? ""}
            </div>
            <button
              onClick={close}
              style={{ padding: "8px 16px", background: "transparent", border: "1px solid var(--border-color)", color: "var(--text-main)", "border-radius": "6px", "font-size": "13px", cursor: "pointer" }}
            >
              Close
            </button>
            <button
              onClick={compile}
              disabled={busy()}
              style={{ padding: "8px 20px", background: "var(--accent)", border: "none", color: "#fff", "border-radius": "6px", "font-size": "13px", cursor: "pointer", opacity: busy() ? 0.6 : 1 }}
            >
              {busy() ? "Compiling..." : "Compile..."}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};
