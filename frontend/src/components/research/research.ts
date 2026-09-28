import type { ResearchKind } from "../../rpc.gen";

// The Research folder: material beside the book that is never manuscript.
// Mirrors backend/src/research.rs.

export const RESEARCH_DIR = "Research";
const SCHEME = "chronicler-research";

/** Is this project-relative path in the Research folder? */
export const isResearchPath = (path: string) => {
  const lower = path.toLowerCase();
  return lower === "research" || lower.startsWith("research/");
};

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"]);

const ext = (path: string) => {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

/** What a research file is, from its path. */
export function researchKind(path: string): ResearchKind {
  const e = ext(path);
  if (e === "md" || e === "markdown" || e === "txt") return path.toLowerCase().startsWith("research/clippings/") ? "clipping" : "note";
  if (IMAGE.has(e)) return "image";
  if (e === "pdf") return "pdf";
  return "other";
}

/**
 * A research note the writer could edit as text (a `.md` outside
 * Clippings). The reference pane may open these in an editor instead of
 * the read-only viewer.
 */
export const isEditableNote = (path: string) => isResearchPath(path) && researchKind(path) === "note" && ext(path) === "md";

/** Display name: the file name, without `.md` for notes and clippings. */
export function researchName(path: string): string {
  const base = path.split("/").pop() ?? path;
  const kind = researchKind(path);
  return kind === "note" || kind === "clipping" ? base.replace(/\.md$/i, "") : base;
}

/** URL the renderer loads an image or PDF from (served by the main process). */
export function researchUrl(path: string, version?: number): string {
  const inside = path.replace(/^research\//i, "");
  const url = `${SCHEME}://project/${inside.split("/").map(encodeURIComponent).join("/")}`;
  return version === undefined ? url : `${url}?v=${version}`;
}

/** The `Source: <url>` line at the top of a clipping. */
export function clippingSource(text: string): string | null {
  for (const line of text.split("\n").slice(0, 12)) {
    const m = /^\s*Source:\s*<?(https?:\/\/[^>\s]+)>?/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export const KIND_LABEL: Record<ResearchKind, string> = {
  note: "Note",
  clipping: "Clipping",
  image: "Image",
  pdf: "PDF",
  other: "File",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
