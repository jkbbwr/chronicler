// Shared binder tree logic: used by the binder sidebar and the compile
// wizard so both agree on ordering and structure.

export interface FileEntry {
  name: string;
  is_dir: boolean;
}

export interface TreeNode {
  path: string;
  name: string;
  is_dir: boolean;
  children: TreeNode[];
}

/** Manual ordering: parent dir path ("" for root) -> child basenames in order. */
export type OrderMap = Record<string, string[]>;

export const ORDER_FILE = ".chronicler/order.json";

export const buildTree = (list: FileEntry[], order: OrderMap): TreeNode[] => {
  const rootNodes: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  // Sort so parents come before children
  const sorted = [...list].sort((a, b) => a.name.length - b.name.length);

  for (const f of sorted) {
    const parts = f.name.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");

    const node: TreeNode = { path: f.name, name, is_dir: f.is_dir, children: [] };
    map.set(f.name, node);

    if (parentPath === "") {
      rootNodes.push(node);
    } else {
      const parent = map.get(parentPath);
      if (parent) parent.children.push(node);
      else rootNodes.push(node); // fallback if parent missing
    }
  }

  const sortLevel = (nodes: TreeNode[], parentPath: string) => {
    const manual = order[parentPath] ?? [];
    nodes.sort((a, b) => {
      const ia = manual.indexOf(a.name);
      const ib = manual.indexOf(b.name);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.is_dir) sortLevel(node.children, node.path);
    }
  };

  sortLevel(rootNodes, "");
  return rootNodes;
};

/** "03 The Gate.md" -> "The Gate" — strip extension and leading sort digits. */
export const chapterName = (name: string) =>
  name.replace(/\.md$/, "").replace(/^\d+[\s._-]+/, "").trim();

export interface CompileChapter {
  /** Stable key for include/exclude persistence: the folder or file path. */
  key: string;
  title: string;
  /** Project-relative scene file paths, in binder order. */
  scenes: string[];
}

const collectScenes = (node: TreeNode): string[] => {
  const scenes: string[] = [];
  for (const child of node.children) {
    if (child.is_dir) scenes.push(...collectScenes(child));
    else scenes.push(child.path);
  }
  return scenes;
};

/**
 * Structure mapping: a top-level folder is a chapter whose .md files (at any
 * depth, in binder order) are its scenes; a root-level file is a standalone
 * single-scene chapter.
 */
export const buildCompileChapters = (tree: TreeNode[]): CompileChapter[] => {
  const chapters: CompileChapter[] = [];
  for (const node of tree) {
    if (node.is_dir) {
      const scenes = collectScenes(node);
      if (scenes.length > 0) {
        chapters.push({ key: node.path, title: chapterName(node.name), scenes });
      }
    } else {
      chapters.push({ key: node.path, title: chapterName(node.name), scenes: [node.path] });
    }
  }
  return chapters;
};
