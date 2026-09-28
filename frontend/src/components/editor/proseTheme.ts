import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// The manuscript's look, built only from theme variables so every palette
// (light or dark) gets matching ink. Markdown syntax is prose-weighted:
// headings are headings, emphasis is emphasis, and markup marks recede.

const proseHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "600", lineHeight: "1.3", color: "var(--text-main)" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "600", lineHeight: "1.35", color: "var(--text-main)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontSize: "1.1em", fontWeight: "600", color: "var(--text-main)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-muted)" },
  { tag: t.quote, fontStyle: "italic", color: "var(--text-muted)" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.88em", color: "var(--text-muted)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--text-faint)" },
  { tag: t.list, color: "var(--text-muted)" },
  { tag: t.comment, color: "var(--text-faint)", fontStyle: "italic" },
]);

export interface ProseLayout {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Maximum line length, in ems of the prose font. */
  measure: number;
  /** "indent" = first-line indents, no gap (book style); "spaced" = gap between paragraphs. */
  paragraphStyle: "spaced" | "indent";
}

export function proseTheme(layout: ProseLayout): Extension {
  return [
    syntaxHighlighting(proseHighlight),
    EditorView.theme({
      "&": {
        height: "100%",
        fontSize: `${layout.fontSize}px`,
        fontFamily: layout.fontFamily,
        color: "var(--text-main)",
        backgroundColor: "transparent",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: String(layout.lineHeight), padding: "12vh 48px 40vh" },
      ".cm-content": {
        maxWidth: `${layout.measure}em`,
        margin: "0 auto",
        padding: "0",
        caretColor: "var(--accent)",
      },
      ".cm-line": { padding: "0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
      },
      ".cm-gutters": { display: "none" },
      ".cm-activeLine": { backgroundColor: "transparent" },
      ".cm-panels": { backgroundColor: "var(--panel-bg)", color: "var(--text-main)", fontFamily: "var(--font-ui)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-color)" },
      ".cm-searchMatch": { backgroundColor: "var(--warning-soft)", outline: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warning) 35%, transparent)" },
      ".cm-tooltip": { backgroundColor: "var(--panel-bg)", border: "1px solid var(--border-color)", color: "var(--text-main)" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--active-bg)", color: "var(--text-main)" },
      ...(layout.paragraphStyle === "indent"
        ? { ".cm-line + .cm-line:not(:empty)": { textIndent: "1.5em" } }
        : {}),
    }),
  ];
}
