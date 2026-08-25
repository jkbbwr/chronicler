import { type Component, createEffect, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView as CodeMirrorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { workbench, resolvedTheme, isLightTheme } from "../../stores/workbench";
import { livePreview } from "./livePreview";
import { typewriterScroll, focusMode } from "./writingModes";
import { entityLinks, type EntityRef } from "./entityLinks";
import { diagSquiggles, type Diag } from "./diagSquiggles";

// Chrome for light themes; dark themes use oneDark
const cmLight = [
  CodeMirrorView.theme({}, { dark: false }),
  syntaxHighlighting(defaultHighlightStyle),
];

const cmThemeFor = (theme: ReturnType<typeof resolvedTheme>) =>
  isLightTheme(theme) ? cmLight : oneDark;

/** Handle for out-of-band editor operations (external reloads, search jumps). */
export interface EditorApi {
  /** Replace the whole document without marking the tab dirty. */
  setContent(content: string): void;
  /** Move the cursor to a 1-based line and scroll it into view. */
  revealLine(line: number): void;
  /** The currently selected text (empty string when collapsed). */
  getSelection(): string;
  /** 1-based line of the primary cursor. */
  getCursorLine(): number;
  /** Select a span on a 1-based line (char columns) and scroll to it. */
  revealSpan(line: number, colStart: number, colEnd: number): void;
}

interface EditorProps {
  initialContent: string;
  /** Codex entities to highlight, longest-pattern-first. */
  entityRefs?: EntityRef[];
  /** Prose diagnostics for this file (squiggles). */
  diags?: Diag[];
  onSave?: (content: string) => void;
  onChange?: (content: string) => void;
  onReady?: (api: EditorApi) => void;
  onOpenEntity?: (id: number, name: string) => void;
}

export const EditorView: Component<EditorProps> = (props) => {
  let editorRef!: HTMLDivElement;
  let view: CodeMirrorView;
  // True while we replace the doc programmatically, so the update listener
  // doesn't report it as a user edit (which would mark the tab dirty).
  let syncing = false;

  const themeCompartment = new Compartment();
  const modeCompartment = new Compartment();
  const colorCompartment = new Compartment();
  const writingCompartment = new Compartment();
  const entitiesCompartment = new Compartment();
  const diagsCompartment = new Compartment();

  const entityExtension = () =>
    entityLinks(props.entityRefs ?? [], (id, name) => props.onOpenEntity?.(id, name));

  const writingExtensions = () => [
    ...(workbench.settings.typewriterMode ? [typewriterScroll()] : []),
    ...(workbench.settings.focusMode ? [focusMode()] : []),
  ];

  const proseTheme = (fontFamily: string, fontSize: number) => CodeMirrorView.theme({
    "&": {
      fontSize: `${fontSize}px`,
      fontFamily,
      height: "100%",
      backgroundColor: "transparent !important",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      padding: "40px 40px",
    },
    ".cm-content": {
      maxWidth: "800px",
      margin: "0 auto",
      lineHeight: "1.7",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-gutters": {
      backgroundColor: "transparent !important",
      border: "none",
    }
  });

  onMount(() => {
    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: (v) => {
          if (props.onSave) {
            props.onSave(v.state.doc.toString());
          }
          return true;
        }
      }
    ]);

    const updateListener = CodeMirrorView.updateListener.of((update) => {
      if (update.docChanged && !syncing && props.onChange) {
        props.onChange(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: props.initialContent,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        saveKeymap,
        search({ top: true }),
        markdown({ base: markdownLanguage }),
        colorCompartment.of(cmThemeFor(resolvedTheme())),
        themeCompartment.of(proseTheme(workbench.settings.fontFamily, workbench.settings.fontSize)),
        modeCompartment.of(workbench.settings.editorMode === "live" ? livePreview() : []),
        writingCompartment.of(writingExtensions()),
        entitiesCompartment.of(entityExtension()),
        diagsCompartment.of(diagSquiggles(props.diags ?? [])),
        CodeMirrorView.lineWrapping,
        // Native spellcheck stays off: the diagnostics engine owns squiggles
        CodeMirrorView.contentAttributes.of({ spellcheck: "false", autocorrect: "on", autocapitalize: "on" }),
        updateListener,
      ],
    });

    view = new CodeMirrorView({
      state,
      parent: editorRef,
    });

    props.onReady?.({
      setContent: (content: string) => {
        syncing = true;
        try {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        } finally {
          syncing = false;
        }
      },
      revealLine: (line: number) => {
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({
          selection: { anchor: l.from },
          effects: CodeMirrorView.scrollIntoView(l.from, { y: "center" }),
        });
        view.focus();
      },
      getSelection: () => {
        const sel = view.state.selection.main;
        return view.state.sliceDoc(sel.from, sel.to);
      },
      getCursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
      revealSpan: (line: number, colStart: number, colEnd: number) => {
        const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        const from = Math.min(l.from + colStart, l.to);
        const to = Math.min(l.from + colEnd, l.to);
        view.dispatch({
          selection: { anchor: from, head: Math.max(from, to) },
          effects: CodeMirrorView.scrollIntoView(from, { y: "center" }),
        });
        view.focus();
      },
    });

    // Apply settings changes to the live editor
    createEffect(() => {
      const theme = proseTheme(workbench.settings.fontFamily, workbench.settings.fontSize);
      view.dispatch({ effects: themeCompartment.reconfigure(theme) });
    });

    createEffect(() => {
      const ext = workbench.settings.editorMode === "live" ? livePreview() : [];
      view.dispatch({ effects: modeCompartment.reconfigure(ext) });
    });

    createEffect(() => {
      view.dispatch({ effects: colorCompartment.reconfigure(cmThemeFor(resolvedTheme())) });
    });

    createEffect(() => {
      view.dispatch({ effects: writingCompartment.reconfigure(writingExtensions()) });
    });

    createEffect(() => {
      view.dispatch({ effects: entitiesCompartment.reconfigure(entityExtension()) });
    });

    createEffect(() => {
      view.dispatch({ effects: diagsCompartment.reconfigure(diagSquiggles(props.diags ?? [])) });
    });

    onCleanup(() => {
      view.destroy();
    });
  });

  return (
    <div
      ref={editorRef}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
    />
  );
};
