// Project identity: the folder is the project, but the title the writer typed
// in the New Project wizard lives in .chronicler/project.json — folders can't
// hold "Chapter 1: Ash / Ember", and a renamed folder shouldn't retitle a book.

export const PROJECT_FILE = ".chronicler/project.json";

export interface ProjectMeta {
  name: string;
  author?: string;
  created?: string;
  /** Seeded by the wizard; applied once, on first open, into the project db. */
  targets?: { dailyTarget: number; projectTarget: number };
  /** What the book is, for every agent (and the critique's default brief). */
  brief?: BookBrief;
}

export interface BookBrief {
  genre?: string;
  audience?: string;
  /** e.g. "close third, past tense, alternating Maren / Ilse". */
  narration?: string;
  comparables?: string;
  tone?: string;
  /** Anything the agent should know: unreliable narrators, deliberate mysteries, house style. */
  notes?: string;
}

export const basename = (p: string) => p.split("/").filter(Boolean).pop() || p;

/** Read project.json, or null for projects created before it existed. */
export const loadProjectMeta = async (): Promise<ProjectMeta | null> => {
  try {
    const res = await window.chronicler.invoke("document/read", { path: PROJECT_FILE });
    const meta = JSON.parse(res.content);
    return typeof meta?.name === "string" && meta.name.trim() ? meta : null;
  } catch {
    return null;
  }
};

export const saveProjectMeta = async (meta: ProjectMeta): Promise<void> => {
  await window.chronicler.invoke("document/save", {
    path: PROJECT_FILE,
    content: JSON.stringify(meta, null, 2),
  });
};

/** The title to show, falling back to the folder name for older projects. */
export const projectDisplayName = (meta: ProjectMeta | null, root: string | null) =>
  meta?.name?.trim() || (root ? basename(root) : "");

/** "Reveal in Finder" only makes sense on a Mac. */
export const revealLabel =
  window.chronicler?.platform === "darwin"
    ? "Reveal in Finder"
    : window.chronicler?.platform === "win32"
      ? "Show in File Explorer"
      : "Show in File Manager";
