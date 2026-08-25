import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

// Codex entity references in prose: names and aliases get a subtle accent
// mark; Cmd/Ctrl+click opens the entity's sheet.

export interface EntityRef {
  /** Lowercased name or alias to match. */
  pattern: string;
  id: number;
  name: string;
  kind: string;
  summary: string;
  mentions: number;
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
  // CodeMirror wraps tooltip content in its own .cm-tooltip container:
  // neutralize that box and style our card directly.
  ".cm-tooltip:has(> .cm-entity-tooltip)": {
    backgroundColor: "transparent",
    border: "none",
  },
  ".cm-entity-tooltip": {
    backgroundColor: "var(--panel-bg, #212121)",
    border: "1px solid var(--border-color, #333)",
    borderRadius: "9px",
    padding: "12px 15px",
    maxWidth: "400px",
    minWidth: "220px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "13px",
    fontStyle: "normal",
    lineHeight: "1.5",
    color: "var(--text-main, #e0e0e0)",
    boxShadow: "0 10px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.25)",
  },
  ".cm-entity-tooltip .head": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "6px",
  },
  ".cm-entity-tooltip .name": { fontWeight: "650", fontSize: "14.5px", letterSpacing: "0.1px" },
  ".cm-entity-tooltip .kind": {
    fontSize: "10px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.7px",
    color: "var(--accent, #4a90e2)",
    border: "1px solid color-mix(in srgb, var(--accent, #4a90e2) 40%, transparent)",
    backgroundColor: "color-mix(in srgb, var(--accent, #4a90e2) 10%, transparent)",
    borderRadius: "9px",
    padding: "2px 8px",
  },
  ".cm-entity-tooltip .summary": {
    color: "var(--text-muted, #999)",
    marginBottom: "9px",
  },
  ".cm-entity-tooltip .foot": {
    color: "var(--text-faint, #666)",
    fontSize: "11.5px",
    borderTop: "1px solid var(--border-color, #333)",
    paddingTop: "8px",
  },
});

const isMac = navigator.platform.toLowerCase().includes("mac");

function tooltipDom(ref: EntityRef): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-entity-tooltip";

  const head = document.createElement("div");
  head.className = "head";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = ref.name;
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = ref.kind;
  head.append(name, kind);
  dom.append(head);

  const summary = document.createElement("div");
  summary.className = "summary";
  if (ref.summary) {
    summary.textContent = ref.summary;
  } else {
    summary.textContent = "No summary yet.";
    summary.style.fontStyle = "italic";
  }
  dom.append(summary);

  const foot = document.createElement("div");
  foot.className = "foot";
  const mentions = `${ref.mentions} mention${ref.mentions === 1 ? "" : "s"}`;
  foot.textContent = `${mentions} · ${isMac ? "⌘" : "Ctrl+"}click to open`;
  dom.append(foot);

  return dom;
}

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

  const entityHover = hoverTooltip((view, pos) => {
    const span = spansAt(view, pos);
    if (!span) return null;
    return {
      pos: span.from,
      end: span.to,
      above: true,
      create: () => ({ dom: tooltipDom(span.ref) }),
    };
  }, { hoverTime: 250 });

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

  return [plugin, clickHandler, entityHover, entityTheme];
}
