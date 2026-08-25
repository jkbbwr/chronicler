import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Keep the cursor line vertically centered while typing. */
export function typewriterScroll(): Extension {
  return EditorView.updateListener.of((update) => {
    const userEdit = update.transactions.some(
      (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete")
    );
    if (!userEdit) return;
    const head = update.state.selection.main.head;
    // Defer: dispatching inside an update callback is not allowed
    requestAnimationFrame(() => {
      update.view.dispatch({
        effects: EditorView.scrollIntoView(head, { y: "center" }),
      });
    });
  });
}

/** Dim every paragraph except the one holding the cursor. */
const dimmedLine = Decoration.line({ class: "cm-dim-line" });

function buildFocusDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const cursorLine = doc.lineAt(state.selection.main.head).number;

  // Current paragraph: contiguous non-blank lines around the cursor
  let start = cursorLine;
  while (start > 1 && doc.line(start - 1).text.trim() !== "") start--;
  let end = cursorLine;
  while (end < doc.lines && doc.line(end + 1).text.trim() !== "") end++;
  // A blank cursor line focuses only itself
  if (doc.line(cursorLine).text.trim() === "") {
    start = end = cursorLine;
  }

  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let l = first; l <= last; l++) {
      if (l < start || l > end) {
        ranges.push(dimmedLine.range(doc.line(l).from));
      }
    }
  }
  return Decoration.set(ranges);
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFocusDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildFocusDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

const focusTheme = EditorView.baseTheme({
  ".cm-dim-line": { opacity: "0.3", transition: "opacity 0.2s" },
});

export function focusMode(): Extension {
  return [focusPlugin, focusTheme];
}
