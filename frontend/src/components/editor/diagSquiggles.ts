import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// Squiggly underlines for prose diagnostics, coloured from semantic tokens:
// spelling = danger, grammar = info, style = warning, agent findings = ai.

export interface Diag {
  source: "spelling" | "grammar" | "style" | "assistant";
  severity: "error" | "warning" | "info";
  file: string;
  line: number; // 1-based
  colStart: number;
  colEnd: number;
  text: string;
  message: string;
  ruleId: string;
  replacements?: string[];
  /** Assistant findings only: db row id, for dismissal. */
  findingId?: number;
}

const squiggleTheme = EditorView.baseTheme({
  ".cm-diag-spelling": {
    textDecoration: "underline wavy var(--danger) 1px",
    textDecorationSkipInk: "none",
  },
  ".cm-diag-grammar": {
    textDecoration: "underline wavy var(--info) 1px",
    textDecorationSkipInk: "none",
  },
  ".cm-diag-style": {
    textDecoration: "underline dotted var(--warning) 1.5px",
    textDecorationSkipInk: "none",
  },
  ".cm-diag-assistant": {
    textDecoration: "underline wavy var(--ai) 1px",
    textDecorationSkipInk: "none",
  },
});

export function diagSquiggles(diags: Diag[]): Extension {
  if (diags.length === 0) return [];

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        // Diag positions are line-anchored snapshots: keep them mapped
        // through edits until the next check replaces them.
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }
      }
      build(view: EditorView): DecorationSet {
        const doc = view.state.doc;
        const ranges = [];
        for (const d of diags) {
          if (d.line < 1 || d.line > doc.lines) continue;
          const line = doc.line(d.line);
          const from = Math.min(line.from + d.colStart, line.to);
          const to = Math.min(line.from + d.colEnd, line.to);
          if (to <= from) continue;
          ranges.push(Decoration.mark({ class: `cm-diag-${d.source}` }).range(from, to));
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations }
  );

  return [plugin, squiggleTheme];
}
