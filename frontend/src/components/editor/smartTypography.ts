import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// Typographic input: straight quotes curl, -- becomes an em-dash, and ...
// becomes an ellipsis, as you type. Skipped inside code contexts, and the
// dash rule leaves `---` horizontal rules alone.

const isOpeningContext = (before: string) =>
  before === "" || /[\s([{—–"'“‘>-]$/.test(before);

const inCodeContext = (view: EditorView, pos: number): boolean => {
  const node = syntaxTree(view.state).resolveInner(pos, -1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (/Code/.test(n.name)) return true;
  }
  return false;
};

export function smartTypography(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text.length !== 1 || from !== to) return false;
    if (inCodeContext(view, from)) return false;

    const line = view.state.doc.lineAt(from);
    const before = view.state.sliceDoc(line.from, from);

    if (text === '"') {
      const quote = isOpeningContext(before) ? "“" : "”";
      view.dispatch({
        changes: { from, to, insert: quote },
        selection: { anchor: from + quote.length },
        userEvent: "input.type",
      });
      return true;
    }

    if (text === "'") {
      // After a word character it's an apostrophe/closing quote
      const quote = isOpeningContext(before) ? "‘" : "’";
      view.dispatch({
        changes: { from, to, insert: quote },
        selection: { anchor: from + quote.length },
        userEvent: "input.type",
      });
      return true;
    }

    if (text === "-" && before.endsWith("-")) {
      // Don't eat horizontal rules: a line of nothing but dashes stays raw
      if (/^-+$/.test(before.trim())) return false;
      view.dispatch({
        changes: { from: from - 1, to, insert: "—" },
        selection: { anchor: from },
        userEvent: "input.type",
      });
      return true;
    }

    if (text === "." && before.endsWith("..") && !before.endsWith("...")) {
      view.dispatch({
        changes: { from: from - 2, to, insert: "…" },
        selection: { anchor: from - 1 },
        userEvent: "input.type",
      });
      return true;
    }

    return false;
  });
}
