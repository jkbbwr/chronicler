import { Compartment, EditorSelection, EditorState, Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { workbench } from "../../stores/workbench";
import { External, edited, registerStateFactory, save } from "../../stores/documents";
import { entityRefs, openEntity } from "../../stores/codex";
import { diagsFor } from "../../stores/diagnostics";
import { livePreview } from "./livePreview";
import { typewriterScroll, focusMode } from "./writingModes";
import { smartTypography } from "./smartTypography";
import { annotations } from "./annotations";
import { entityLinks } from "./entityLinks";
import { diagSquiggles } from "./diagSquiggles";
import { proseTheme } from "./proseTheme";

// Every manuscript EditorState is built here. Configuration lives in shared
// compartments, so whichever editor shows a scene can bring its (possibly
// parked, stale) state up to date with `syncConfig`. Listeners route by the
// state's own path facet, never by closure, so states move freely between
// editors.

/** The project-relative path a state belongs to. */
export const docPath = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

const compartments = {
  theme: new Compartment(),
  mode: new Compartment(),
  writing: new Compartment(),
  entities: new Compartment(),
  diags: new Compartment(),
};

const themeConfig = () => proseTheme({
  fontFamily: workbench.settings.fontFamily,
  fontSize: workbench.settings.fontSize,
  lineHeight: workbench.settings.lineHeight,
  measure: workbench.settings.measure,
  paragraphStyle: workbench.settings.paragraphStyle,
});
const modeConfig = () => (workbench.settings.editorMode === "live" ? livePreview() : []);
const writingConfig = () => [
  ...(workbench.settings.typewriterMode ? [typewriterScroll()] : []),
  ...(workbench.settings.focusMode ? [focusMode()] : []),
  ...(workbench.settings.smartTypography ? [smartTypography()] : []),
];
const entitiesConfig = () =>
  entityLinks(entityRefs(), (id) => openEntity(id), workbench.settings.entityHighlight === "always");
const diagsConfig = (path: string) => diagSquiggles(diagsFor(path));

// Codex names and aliases complete as you type: two letters in, prefix match.
const codexCompletions = (ctx: CompletionContext): CompletionResult | null => {
  const word = ctx.matchBefore(/[\p{L}][\p{L}'’-]*$/u);
  if (!word || word.to - word.from < 2) return null;
  const q = ctx.state.sliceDoc(word.from, word.to).toLowerCase();
  const seen = new Set<string>();
  const options = [];
  for (const r of entityRefs()) {
    const label = r.display;
    if (!label || seen.has(label) || !label.toLowerCase().startsWith(q) || label.toLowerCase() === q) continue;
    seen.add(label);
    options.push({ label, type: "keyword", detail: r.kind });
  }
  if (options.length === 0) return null;
  options.sort((a, b) => a.label.localeCompare(b.label));
  return { from: word.from, options, validFor: /[\p{L}'’-]*$/u };
};

const editListener = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (update.transactions.every((tr) => tr.annotation(External))) return;
  edited(update.state.facet(docPath));
});

/** Wrap the selection in `mark` (or unwrap it if already wrapped). */
function toggleWrap(mark: string) {
  return (view: EditorView) => {
    const changes = view.state.changeByRange((range) => {
      const before = view.state.sliceDoc(range.from - mark.length, range.from);
      const after = view.state.sliceDoc(range.to, range.to + mark.length);
      if (before === mark && after === mark) {
        return {
          changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
        };
      }
      return {
        changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch(changes);
    return true;
  };
}

const writerKeymap = keymap.of([
  { key: "Mod-s", preventDefault: true, run: (v) => { void save(v.state.facet(docPath)); return true; } },
  { key: "Mod-b", run: toggleWrap("**") },
  { key: "Mod-i", run: toggleWrap("*") },
]);

// Prose has no use for code indentation; Mod-[ / Mod-] toggle the side panels.
const proseDefaultKeymap = defaultKeymap.filter((b) => b.key !== "Mod-[" && b.key !== "Mod-]");

// ---- The paragraph being read aloud ----

/** Set (or clear, with null) the 1-based line being read aloud. */
export const setReadingLine = StateEffect.define<number | null>();

const readingField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setReadingLine)) continue;
      const line = e.value;
      if (line === null || line < 1 || line > tr.state.doc.lines) deco = Decoration.none;
      else deco = Decoration.set([Decoration.line({ class: "cm-reading-line" }).range(tr.state.doc.line(line).from)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const readingTheme = EditorView.baseTheme({
  ".cm-reading-line": {
    backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
    boxShadow: "-12px 0 0 color-mix(in srgb, var(--accent) 12%, transparent), 12px 0 0 color-mix(in srgb, var(--accent) 12%, transparent)",
    borderRadius: "3px",
  },
});

const staticExtensions: Extension = [
  readingField,
  readingTheme,
  history(),
  writerKeymap,
  keymap.of([...proseDefaultKeymap, ...historyKeymap, ...searchKeymap]),
  search({ top: true }),
  markdown({ base: markdownLanguage }),
  autocompletion({ override: [codexCompletions], icons: false }),
  annotations(),
  EditorView.lineWrapping,
  // The diagnostics engine owns spelling; the browser's would double up.
  EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "on", autocapitalize: "on" }),
  editListener,
];

export function createDocState(path: string, text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      docPath.of(path),
      staticExtensions,
      compartments.theme.of(themeConfig()),
      compartments.mode.of(modeConfig()),
      compartments.writing.of(writingConfig()),
      compartments.entities.of(entitiesConfig()),
      compartments.diags.of(diagsConfig(path)),
    ],
  });
}

registerStateFactory(createDocState);

type Part = keyof typeof compartments;

/** Bring a view's configuration up to date (all parts, or just some). */
export function syncConfig(view: EditorView, parts: Part[] = ["theme", "mode", "writing", "entities", "diags"]) {
  const path = view.state.facet(docPath);
  const build: Record<Part, () => Extension> = {
    theme: themeConfig,
    mode: modeConfig,
    writing: writingConfig,
    entities: entitiesConfig,
    diags: () => diagsConfig(path),
  };
  view.dispatch({ effects: parts.map((p) => compartments[p].reconfigure(build[p]())) });
}

/** Tracked readers per part, so editors can react to exactly what changed. */
export const configSources: Record<Exclude<Part, "diags">, () => unknown> = {
  theme: () => [workbench.settings.fontFamily, workbench.settings.fontSize, workbench.settings.lineHeight, workbench.settings.measure, workbench.settings.paragraphStyle],
  mode: () => workbench.settings.editorMode,
  writing: () => [workbench.settings.typewriterMode, workbench.settings.focusMode, workbench.settings.smartTypography],
  entities: () => [entityRefs(), workbench.settings.entityHighlight],
};
