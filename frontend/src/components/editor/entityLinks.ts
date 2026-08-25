import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// Codex entity references in prose: names and aliases get a subtle accent
// mark; Cmd/Ctrl+click opens the entity's sheet.

export interface EntityRef {
  /** Lowercased name or alias to match. */
  pattern: string;
  id: number;
  name: string;
}

interface Span {
  from: number;
  to: number;
  ref: EntityRef;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Find entity spans in one line of text (longest pattern wins on overlap). */
function findSpans(lineText: string, lineFrom: number, refs: EntityRef[]): Span[] {
  const lower = lineText.toLowerCase();
  const spans: Span[] = [];
  const claimed: boolean[] = new Array(lineText.length).fill(false);

  for (const ref of refs) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(ref.pattern, from);
      if (idx === -1) break;
      const end = idx + ref.pattern.length;
      from = idx + 1;
      if (isWordChar(lineText[idx - 1]) || isWordChar(lineText[end])) continue;
      let overlaps = false;
      for (let i = idx; i < end; i++) {
        if (claimed[i]) { overlaps = true; break; }
      }
      if (overlaps) continue;
      for (let i = idx; i < end; i++) claimed[i] = true;
      spans.push({ from: lineFrom + idx, to: lineFrom + end, ref });
    }
  }
  return spans.sort((a, b) => a.from - b.from);
}

const entityTheme = EditorView.baseTheme({
  ".cm-entity-ref": {
    color: "var(--accent, #4a90e2)",
    borderBottom: "1px dotted color-mix(in srgb, var(--accent, #4a90e2) 45%, transparent)",
  },
  ".cm-entity-ref:hover": {
    borderBottomStyle: "solid",
    cursor: "pointer",
  },
});

/**
 * Highlight codex entities. `refs` must be pre-sorted longest-pattern-first
 * so "Aldous Marr" outranks "Aldous" on overlap.
 */
export function entityLinks(
  refs: EntityRef[],
  onOpen: (id: number, name: string) => void
): Extension {
  if (refs.length === 0) return [];

  const spansAt = (view: EditorView, pos: number): Span | undefined => {
    const line = view.state.doc.lineAt(pos);
    return findSpans(line.text, line.from, refs).find(s => pos >= s.from && pos < s.to);
  };

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
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            for (const span of findSpans(line.text, line.from, refs)) {
              ranges.push(Decoration.mark({ class: "cm-entity-ref" }).range(span.from, span.to));
            }
            pos = line.to + 1;
          }
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations }
  );

  const clickHandler = EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!event.metaKey && !event.ctrlKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const span = spansAt(view, pos);
      if (!span) return false;
      event.preventDefault();
      onOpen(span.ref.id, span.ref.name);
      return true;
    },
  });

  return [plugin, clickHandler, entityTheme];
}
