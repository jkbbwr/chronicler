import { type Component, createEffect, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView as CodeMirrorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { workbench } from "../../stores/workbench";

interface EditorProps {
  initialContent: string;
  onSave?: (content: string) => void;
  onChange?: (content: string) => void;
}

export const EditorView: Component<EditorProps> = (props) => {
  let editorRef!: HTMLDivElement;
  let view: CodeMirrorView;

  const themeCompartment = new Compartment();

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
      if (update.docChanged && props.onChange) {
        props.onChange(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: props.initialContent,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        saveKeymap,
        markdown({ base: markdownLanguage }),
        oneDark,
        themeCompartment.of(proseTheme(workbench.settings.fontFamily, workbench.settings.fontSize)),
        CodeMirrorView.lineWrapping,
        updateListener,
      ],
    });

    view = new CodeMirrorView({
      state,
      parent: editorRef,
    });

    // Apply settings changes to the live editor
    createEffect(() => {
      const theme = proseTheme(workbench.settings.fontFamily, workbench.settings.fontSize);
      view.dispatch({ effects: themeCompartment.reconfigure(theme) });
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
