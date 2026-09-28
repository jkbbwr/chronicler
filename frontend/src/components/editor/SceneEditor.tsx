import { type Component, createEffect, on, onCleanup, onMount } from "solid-js";
import { EditorView } from "@codemirror/view";
import { applyReveal, attach, detach, takeReveal } from "../../stores/documents";
import { diagsFor } from "../../stores/diagnostics";
import { configSources, setReadingLine, syncConfig } from "./setup";
import { playing, reading } from "../../lib/readAloud";
import "./setup"; // registers the state factory

// One CodeMirror view that shows whichever scene `path` names, swapping in
// that scene's own EditorState (undo history included) as `path` changes.

interface SceneEditorProps {
  path: string;
  /** Extra class on the host (Review uses a non-scrolling variant). */
  class?: string;
  onView?: (view: EditorView | null) => void;
}

export const SceneEditor: Component<SceneEditorProps> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let current: string | null = null;

  /** Swap `path` in; returns true if a pending reveal was applied (it focuses). */
  const show = (path: string): boolean => {
    if (!view) return false;
    if (current) detach(current, view);
    view.setState(attach(path, view));
    current = path;
    syncConfig(view);
    const reveal = takeReveal(path);
    if (reveal) requestAnimationFrame(() => view && applyReveal(view, reveal));
    return !!reveal;
  };

  onMount(() => {
    view = new EditorView({ parent: host });
    const revealed = show(props.path);
    props.onView?.(view);
    if (!revealed) view.focus();
  });

  createEffect(on(() => props.path, (path) => { if (view && path !== current) show(path); }, { defer: true }));

  for (const [part, source] of Object.entries(configSources)) {
    createEffect(on(source, () => view && syncConfig(view, [part as keyof typeof configSources]), { defer: true }));
  }
  createEffect(on(() => diagsFor(props.path), () => view && syncConfig(view, ["diags"]), { defer: true }));

  // Follow read-aloud: highlight the paragraph being read and keep it in view.
  let highlighted = false;
  createEffect(() => {
    const r = reading();
    if (!view) return;
    if (r && r.path === props.path) {
      const doc = view.state.doc;
      const line = Math.max(1, Math.min(r.line, doc.lines));
      view.dispatch({
        effects: [
          setReadingLine.of(line),
          ...(playing() ? [EditorView.scrollIntoView(doc.line(line).from, { y: "center" })] : []),
        ],
      });
      highlighted = true;
    } else if (highlighted) {
      view.dispatch({ effects: setReadingLine.of(null) });
      highlighted = false;
    }
  });

  onCleanup(() => {
    if (view && current) detach(current, view);
    props.onView?.(null);
    view?.destroy();
    view = undefined;
  });

  return <div ref={host} class={`scene-editor ${props.class ?? ""}`} />;
};
