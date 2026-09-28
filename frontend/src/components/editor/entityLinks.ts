import { type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

// Codex entity references in prose. Names stay quiet on the page: they only
// light up while Cmd/Ctrl is held (or always, if the writer opts in), show a
// peek card on hover, and Cmd/Ctrl+click opens the entity.

export interface EntityRef {
  /** Lowercased name or alias to match. */
  pattern: string;
  /** The name or alias in its original casing (for autocomplete). */
  display: string;
  id: number;
  name: string;
  kind: string;
  summary: string;
  mentions: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One alternation for every name; `refs` arrive longest-first so the longest match wins. */
function compile(refs: EntityRef[]): { regexp: RegExp; byPattern: Map<string, EntityRef> } {
  const byPattern = new Map<string, EntityRef>();
  for (const r of refs) if (!byPattern.has(r.pattern)) byPattern.set(r.pattern, r);
  const alternation = [...byPattern.keys()].map(escape).join("|");
  return {
    regexp: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "giu"),
    byPattern,
  };
}

const entityTheme = EditorView.baseTheme({
  ".cm-entity-ref": {
    borderBottom: "1px dotted transparent",
    transition: "color 120ms, border-color 120ms",
  },
  ".cm-entity-ref:hover": {
    borderBottomColor: "color-mix(in srgb, var(--entity) 60%, transparent)",
  },
  "&.cm-show-entities .cm-entity-ref": {
    color: "var(--entity)",
    borderBottomColor: "color-mix(in srgb, var(--entity) 45%, transparent)",
    cursor: "pointer",
  },
  ".cm-tooltip:has(> .cm-entity-peek)": {
    backgroundColor: "transparent",
    border: "none",
  },
  ".cm-entity-peek": {
    minWidth: "220px",
    maxWidth: "360px",
    padding: "12px 14px",
    fontFamily: "var(--font-ui)",
    fontSize: "13px",
    fontStyle: "normal",
    lineHeight: "1.5",
    color: "var(--text-main)",
    backgroundColor: "var(--panel-bg)",
    border: "1px solid var(--border-color)",
    borderRadius: "10px",
    boxShadow: "var(--shadow-pop)",
  },
  ".cm-entity-peek .head": { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "4px" },
  ".cm-entity-peek .name": { fontFamily: "var(--font-prose)", fontWeight: "600", fontSize: "16px" },
  ".cm-entity-peek .kind": {
    fontSize: "10px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--text-faint)",
  },
  ".cm-entity-peek .summary": { color: "var(--text-muted)" },
  ".cm-entity-peek .summary.empty": { fontStyle: "italic", color: "var(--text-faint)" },
  ".cm-entity-peek .foot": { marginTop: "8px", fontSize: "11px", color: "var(--text-faint)" },
});

const isMac = navigator.platform.toLowerCase().includes("mac");

function peekDom(ref: EntityRef): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-entity-peek";
  const head = dom.appendChild(document.createElement("div"));
  head.className = "head";
  const name = head.appendChild(document.createElement("span"));
  name.className = "name";
  name.textContent = ref.name;
  const kind = head.appendChild(document.createElement("span"));
  kind.className = "kind";
  kind.textContent = ref.kind;
  const summary = dom.appendChild(document.createElement("div"));
  summary.className = ref.summary ? "summary" : "summary empty";
  summary.textContent = ref.summary || "No summary yet.";
  const foot = dom.appendChild(document.createElement("div"));
  foot.className = "foot";
  foot.textContent = `${ref.mentions} mention${ref.mentions === 1 ? "" : "s"} · ${isMac ? "⌘" : "Ctrl+"}click to open`;
  return dom;
}

/** Toggle `.cm-show-entities` while the platform modifier is held. */
const modifierReveal = ViewPlugin.fromClass(
  class {
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      window.addEventListener("keydown", this.sync);
      window.addEventListener("keyup", this.sync);
      window.addEventListener("blur", this.clear);
    }
    sync = (e: KeyboardEvent) => this.set(isMac ? e.metaKey : e.ctrlKey);
    clear = () => this.set(false);
    set(on: boolean) {
      this.view.dom.classList.toggle("cm-show-entities-held", on);
      this.view.dom.classList.toggle("cm-show-entities", on || this.view.dom.classList.contains("cm-show-entities-always"));
    }
    destroy() {
      window.removeEventListener("keydown", this.sync);
      window.removeEventListener("keyup", this.sync);
      window.removeEventListener("blur", this.clear);
    }
  },
);

/**
 * Mark codex entities. `refs` must be pre-sorted longest-pattern-first so
 * "Aldous Marr" outranks "Aldous" on overlap.
 */
export function entityLinks(
  refs: EntityRef[],
  onOpen: (id: number, name: string) => void,
  alwaysShow = false,
): Extension {
  if (refs.length === 0) return [];
  const { regexp, byPattern } = compile(refs);
  const refAt = (m: RegExpExecArray) => byPattern.get(m[0].toLowerCase());

  const decorator = new MatchDecorator({
    regexp,
    decorate: (add, from, to, match) => {
      const ref = refAt(match);
      if (ref) add(from, to, Decoration.mark({ class: "cm-entity-ref", ref }));
    },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
        view.dom.classList.toggle("cm-show-entities-always", alwaysShow);
        view.dom.classList.toggle("cm-show-entities", alwaysShow);
      }
      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );

  /** The entity span under `pos`, from the already-built decorations. */
  const spanAt = (view: EditorView, pos: number): Range<Decoration> | undefined => {
    const set = view.plugin(plugin)?.decorations;
    let found: Range<Decoration> | undefined;
    set?.between(pos, pos + 1, (from, to, value) => {
      if (pos >= from && pos < to) {
        found = value.range(from, to);
        return false;
      }
    });
    return found;
  };

  const peek = hoverTooltip((view, pos) => {
    const span = spanAt(view, pos);
    if (!span) return null;
    const ref = span.value.spec.ref as EntityRef;
    return { pos: span.from, end: span.to, above: true, create: () => ({ dom: peekDom(ref) }) };
  }, { hoverTime: 350 });

  const click = EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (!(isMac ? event.metaKey : event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const span = spanAt(view, pos);
      if (!span) return false;
      event.preventDefault();
      const ref = span.value.spec.ref as EntityRef;
      onOpen(ref.id, ref.name);
      return true;
    },
  });

  return [plugin, modifierReveal, click, peek, entityTheme];
}

/** Distinct entities mentioned in `text` (for the inspector's cast list). */
export function entitiesIn(text: string, refs: EntityRef[]): { ref: EntityRef; count: number }[] {
  if (refs.length === 0 || !text) return [];
  const { regexp, byPattern } = compile(refs);
  const counts = new Map<number, { ref: EntityRef; count: number }>();
  for (const m of text.matchAll(regexp)) {
    const ref = byPattern.get(m[0].toLowerCase());
    if (!ref) continue;
    const entry = counts.get(ref.id) ?? { ref, count: 0 };
    entry.count++;
    counts.set(ref.id, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
