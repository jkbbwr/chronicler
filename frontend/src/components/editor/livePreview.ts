import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// Obsidian-style live preview: markdown renders styled with its syntax
// hidden, except where the cursor is — there the raw markup is revealed.

class BulletWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.textContent = "•";
    s.className = "cm-lp-bullet";
    return s;
  }
  eq() { return true; }
}

class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-hr";
    return el;
  }
  eq() { return true; }
}

const bulletWidget = new BulletWidget();
const hrWidget = new HrWidget();

const hide = Decoration.replace({});

const headingClass: Record<string, string> = {
  ATXHeading1: "cm-lp-h1", SetextHeading1: "cm-lp-h1",
  ATXHeading2: "cm-lp-h2", SetextHeading2: "cm-lp-h2",
  ATXHeading3: "cm-lp-h3",
  ATXHeading4: "cm-lp-h4",
  ATXHeading5: "cm-lp-h5",
  ATXHeading6: "cm-lp-h6",
};

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const add = (from: number, to: number, deco: Decoration) => {
    if (to > from) ranges.push(deco.range(from, to));
  };
  const { state } = view;
  const doc = state.doc;

  // An element is "active" (shows raw syntax) when any selection endpoint's
  // line overlaps it — line granularity matches how Obsidian feels.
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const fromLine = doc.lineAt(range.from).number;
    const toLine = doc.lineAt(range.to).number;
    for (let l = fromLine; l <= toLine; l++) activeLines.add(l);
  }
  const isActive = (from: number, to: number) => {
    const fromLine = doc.lineAt(from).number;
    const toLine = doc.lineAt(to).number;
    for (let l = fromLine; l <= toLine; l++) {
      if (activeLines.has(l)) return true;
    }
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;

        // Headings: size styling always applies; the #-marks hide when inactive
        if (headingClass[name]) {
          add(node.from, node.to, Decoration.mark({ class: headingClass[name] }));
          return;
        }
        if (name === "HeaderMark") {
          const parent = node.node.parent;
          if (parent && headingClass[parent.name] && !isActive(parent.from, parent.to)) {
            // Also swallow the space after "#" marks (ATX only)
            const after = doc.sliceString(node.to, node.to + 1);
            add(node.from, after === " " ? node.to + 1 : node.to, hide);
          }
          return;
        }

        if (name === "StrongEmphasis") {
          add(node.from, node.to, Decoration.mark({ class: "cm-lp-strong" }));
          return;
        }
        if (name === "Emphasis") {
          add(node.from, node.to, Decoration.mark({ class: "cm-lp-em" }));
          return;
        }
        if (name === "EmphasisMark") {
          const parent = node.node.parent;
          if (parent && !isActive(parent.from, parent.to)) {
            add(node.from, node.to, hide);
          }
          return;
        }

        if (name === "InlineCode") {
          add(node.from, node.to, Decoration.mark({ class: "cm-lp-code" }));
          return;
        }
        if (name === "CodeMark") {
          const parent = node.node.parent;
          if (parent && parent.name === "InlineCode" && !isActive(parent.from, parent.to)) {
            add(node.from, node.to, hide);
          }
          return;
        }

        if (name === "Strikethrough") {
          add(node.from, node.to, Decoration.mark({ class: "cm-lp-strike" }));
          return;
        }
        if (name === "StrikethroughMark") {
          const parent = node.node.parent;
          if (parent && !isActive(parent.from, parent.to)) {
            add(node.from, node.to, hide);
          }
          return;
        }

        if (name === "Link") {
          add(node.from, node.to, Decoration.mark({ class: "cm-lp-link" }));
          return;
        }
        if (name === "LinkMark" || name === "URL") {
          const parent = node.node.parent;
          if (parent && parent.name === "Link" && !isActive(parent.from, parent.to)) {
            add(node.from, node.to, hide);
          }
          return;
        }

        if (name === "QuoteMark") {
          const line = doc.lineAt(node.from);
          if (!activeLines.has(line.number)) {
            // Hide "> " but keep the styled left border via the line class below
            const after = doc.sliceString(node.to, node.to + 1);
            add(node.from, after === " " ? node.to + 1 : node.to, hide);
          }
          return;
        }

        if (name === "ListMark") {
          const text = doc.sliceString(node.from, node.to);
          const line = doc.lineAt(node.from);
          if (/^[-*+]$/.test(text) && !activeLines.has(line.number)) {
            add(node.from, node.to, Decoration.replace({ widget: bulletWidget }));
          }
          return;
        }

        if (name === "HorizontalRule") {
          if (!isActive(node.from, node.to)) {
            add(node.from, node.to, Decoration.replace({ widget: hrWidget }));
          }
          return;
        }
      },
    });
  }

  // Nested/overlapping nodes arrive out of order; sort=true handles it
  return Decoration.set(ranges, true);
}

// Blockquote lines get their border via line decorations, which must be
// supplied separately from the (sorted) inline set to keep ordering valid.
function buildLineDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        if (node.name === "Blockquote") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let l = first; l <= last; l++) {
            const line = state.doc.line(l);
            ranges.push(Decoration.line({ class: "cm-lp-quote" }).range(line.from));
          }
          return false; // don't double-decorate nested quotes
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    lineDecorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
      this.lineDecorations = buildLineDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
        this.lineDecorations = buildLineDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.decorations.of((view) => view.plugin(plugin)?.lineDecorations ?? Decoration.none),
  }
);

const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-h1": { fontSize: "1.7em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h2": { fontSize: "1.45em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h3": { fontSize: "1.25em", fontWeight: "600" },
  ".cm-lp-h4": { fontSize: "1.1em", fontWeight: "600" },
  ".cm-lp-h5": { fontSize: "1em", fontWeight: "700" },
  ".cm-lp-h6": { fontSize: "0.9em", fontWeight: "700", textTransform: "uppercase" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-lp-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.85em",
    backgroundColor: "rgba(128, 128, 128, 0.15)",
    borderRadius: "3px",
    padding: "1px 4px",
  },
  ".cm-lp-link": { color: "var(--accent, #4a90e2)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-lp-bullet": { color: "var(--text-muted, #888)", marginRight: "2px" },
  ".cm-lp-hr": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    verticalAlign: "middle",
    backgroundColor: "var(--border-color, #333)",
  },
  ".cm-lp-quote": {
    borderLeft: "3px solid var(--border-color, #333)",
    paddingLeft: "12px",
    fontStyle: "italic",
  },
});

export function livePreview(): Extension {
  return [livePreviewPlugin, livePreviewTheme];
}
