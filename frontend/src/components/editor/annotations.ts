import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// Inline annotations: HTML comments styled as writer's margin notes. They
// never compile (stripped in export) and are ignored by diagnostics, so
// they're safe scratch space inside the manuscript.

const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

const annotationTheme = EditorView.baseTheme({
  ".cm-annotation": {
    background: "var(--warning-soft)",
    color: "color-mix(in srgb, var(--warning) 80%, var(--text-muted))",
    fontStyle: "italic",
    borderRadius: "3px",
    padding: "0 2px",
  },
});

export function annotations(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const ranges = [];
        for (const { from, to } of view.visibleRanges) {
          const text = view.state.sliceDoc(from, to);
          for (const m of text.matchAll(COMMENT)) {
            ranges.push(
              Decoration.mark({ class: "cm-annotation" }).range(from + m.index, from + m.index + m[0].length)
            );
          }
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [plugin, annotationTheme];
}

/** Insert an annotation at the cursor (wrapping any selection) and place the
 * cursor inside it. Bound to Mod-Shift-A in the editor. */
export function insertAnnotation(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = `<!-- ${selected} -->`;
  view.dispatch({
    changes: { from, to, insert },
    // Cursor lands just before the closing marker (after any wrapped text)
    selection: { anchor: from + 5 + selected.length },
  });
  return true;
}
