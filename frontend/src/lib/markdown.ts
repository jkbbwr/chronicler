import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render app-authored or model-authored markdown: sanitized HTML with
 * scene citations turned into clickable links. Backtick paths ending in
 * .md become links too, since models reach for those naturally. Pair with
 * the `.agent-md` styles and a click handler that routes `scene://` hrefs. */
export const renderMarkdown = (src: string): string => {
  const raw = marked.parse(src, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { ALLOWED_URI_REGEXP: /^(?:https?|scene):/i });
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll("code").forEach((c) => {
    const t = (c.textContent ?? "").trim();
    if (/^[^`\n]{1,200}\.md$/.test(t)) {
      const a = document.createElement("a");
      a.setAttribute("href", "scene://" + encodeURI(t));
      a.textContent = t;
      c.replaceWith(a);
    }
  });
  return tpl.innerHTML;
};

/** Parse a scene:// href into { path, line }. Returns null for other links. */
export const parseSceneHref = (href: string): { path: string; line?: number } | null => {
  if (!href.startsWith("scene://")) return null;
  const [path, anchor] = href.slice("scene://".length).split("#");
  const line = anchor ? parseInt(anchor.replace(/^L/i, ""), 10) : NaN;
  return { path: decodeURI(path), line: Number.isFinite(line) ? line : undefined };
};
