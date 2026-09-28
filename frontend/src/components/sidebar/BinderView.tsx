import { type Component, createResource, createSignal, Show, createEffect } from "solid-js";
import { FileText, FolderPlus, FilePlus}  from "lucide-solid";
import { BinderContextMenu } from "./BinderContextMenu";
import { BinderTreeItem, type TreeNode } from "./BinderTreeItem";
import { buildTree, ORDER_FILE, type FileEntry, type OrderMap } from "../../lib/binderTree";
import { stats } from "../../stores/stats";
import { IconButton } from "../ui";
import "./BinderView.css";
import { onCleanup, onMount } from "solid-js";

interface BinderViewProps {
  activeFile: string;
  createTrigger?: "file" | "folder" | null;
  /** Bumped when the backend reports filesystem changes; triggers a refetch. */
  refreshVersion?: number;
  /** Project title for the header; falls back to "Manuscript". */
  projectName?: string;
  /** Absolute project path, shown as the header's tooltip. */
  projectPath?: string;
  onFileSelect: (filename: string) => void;
  onNewFile: (name: string) => Promise<void> | void;
  onNewFolder?: (name: string) => Promise<void> | void;
  onRename?: (oldName: string, newName: string) => Promise<void> | void;
  onDelete?: (name: string) => Promise<void> | void;
  onCheckContinuity?: (file: string) => void;
  onMergeNext?: (file: string) => void;
  /** Reveal a project-relative path ("" = the project root) in the file manager. */
  onReveal?: (relPath: string) => void;
}

const basename = (p: string) => p.split("/").pop()!;
const parentOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

const fetchBinder = async () => {
  const res = await window.chronicler.invoke("project/list_files");
  let order: OrderMap = {};
  try {
    const o = await window.chronicler.invoke("document/read", { path: ORDER_FILE });
    order = JSON.parse(o.content);
  } catch {
    // No order file yet — fall back to dirs-first alphabetical
  }
  const statuses: Record<string, string> = {};
  try {
    const meta = await window.chronicler.invoke("meta/get_all");
    for (const row of meta.meta) if (row.status) statuses[row.file] = row.status;
  } catch { /* backend restarting */ }
  return { files: res.files as FileEntry[], order, statuses };
};

export const BinderView: Component<BinderViewProps> = (props) => {
  const [binder, { refetch }] = createResource(fetchBinder);
  const wordsByFile = () => Object.fromEntries((stats()?.files ?? []).map((f) => [f.file, f.words]));

  const [creatingFile, setCreatingFile] = createSignal<string | false>(false);
  const [creatingFolder, setCreatingFolder] = createSignal<string | false>(false);

  const [contextMenu, setContextMenu] = createSignal<{ x: number, y: number, name: string, is_dir: boolean } | null>(null);
  const [renamingItem, setRenamingItem] = createSignal<string | null>(null);

  onMount(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    onCleanup(() => window.removeEventListener("click", handleGlobalClick));
  });

  createEffect(() => {
    if (props.createTrigger === "file") startCreate("file", "");
    else if (props.createTrigger === "folder") startCreate("folder", "");
  });

  createEffect((prev: number | undefined) => {
    const v = props.refreshVersion;
    if (prev !== undefined && v !== prev) refetch();
    return v;
  });

  const saveOrder = async (order: OrderMap) => {
    try {
      await window.chronicler.invoke("document/save", { path: ORDER_FILE, content: JSON.stringify(order, null, 2) });
    } catch {
      // Ordering is a nicety; never block the move itself on it
    }
  };

  const handleInputKeyDown = async (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim();
      const filePrefix = creatingFile();
      const folderPrefix = creatingFolder();
      setCreatingFile(false);
      setCreatingFolder(false);
      if (val) {
        if (typeof filePrefix === "string") {
          await props.onNewFile(filePrefix ? `${filePrefix}/${val}` : val);
        } else if (typeof folderPrefix === "string" && props.onNewFolder) {
          await props.onNewFolder(folderPrefix ? `${folderPrefix}/${val}` : val);
        }
        refetch();
      }
    } else if (e.key === "Escape") {
      setCreatingFile(false);
      setCreatingFolder(false);
    }
  };

  const startCreate = (type: "file" | "folder", targetDir: string = "") => {
    if (type === "file") setCreatingFile(targetDir);
    else setCreatingFolder(targetDir);
    setTimeout(() => {
      const el = document.getElementById("binder-new-input");
      if (el) el.focus();
    }, 50);
  };

  const handleRenameKeyDown = async (e: KeyboardEvent & { currentTarget: HTMLInputElement }, oldName: string) => {
    if (e.key === "Enter") {
      let val = e.currentTarget.value.trim();
      setRenamingItem(null);
      if (val) {
        // The input shows the name without ".md", so restore it — otherwise
        // the renamed file loses its extension and vanishes from the binder.
        if (oldName.endsWith(".md") && !val.endsWith(".md")) {
          val += ".md";
        }
        const parts = oldName.split("/");
        parts[parts.length - 1] = val;
        const newPath = parts.join("/");
        if (newPath !== oldName && props.onRename) {
          await props.onRename(oldName, newPath);
          refetch();
        }
      }
    } else if (e.key === "Escape") {
      setRenamingItem(null);
    }
  };

  const startRename = (name: string) => {
    setRenamingItem(name);
    setTimeout(() => {
      const el = document.getElementById("binder-rename-input");
      if (el) el.focus();
    }, 50);
  };

  const handleDelete = async (name: string) => {
    if (props.onDelete) await props.onDelete(name);
    refetch();
  };

  const handleDragStart = (e: DragEvent, name: string) => {
    e.dataTransfer?.setData("text/plain", name);
  };

  const findNode = (nodes: TreeNode[], path: string): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.path === path) return n;
      const found = findNode(n.children, path);
      if (found) return found;
    }
    return undefined;
  };

  /** Persist the sibling order for `parent` with `draggedName` at `index`. */
  const reorderSiblings = async (parent: string, draggedName: string, targetName: string, after: boolean) => {
    const data = binder();
    const tree = buildTree(data?.files || [], data?.order || {});
    const parentChildren = parent === "" ? tree : (findNode(tree, parent)?.children ?? []);
    const siblings = parentChildren.map(n => n.name).filter(n => n !== draggedName);
    let idx = siblings.indexOf(targetName);
    if (idx === -1) idx = siblings.length;
    if (after) idx += 1;
    siblings.splice(idx, 0, draggedName);
    const order: OrderMap = { ...(data?.order || {}), [parent]: siblings };
    await saveOrder(order);
  };

  /**
   * Drop on the top half of any row: place the dragged item before it
   * (moving between folders if needed). Drop on the bottom half of a folder:
   * move into it. Drop on the bottom half of a file: place after it.
   */
  const handleDropOnItem = async (e: DragEvent, target: TreeNode, before: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedPath = e.dataTransfer?.getData("text/plain");
    if (!draggedPath || draggedPath === target.path) return;
    if (target.path.startsWith(draggedPath + "/")) return; // no dropping into own subtree

    const draggedName = basename(draggedPath);

    if (!before && target.is_dir) {
      const newPath = `${target.path}/${draggedName}`;
      if (newPath !== draggedPath && props.onRename) {
        await props.onRename(draggedPath, newPath);
        refetch();
      }
      return;
    }

    const parent = parentOf(target.path);
    const newPath = parent ? `${parent}/${draggedName}` : draggedName;
    if (newPath !== draggedPath) {
      if (!props.onRename) return;
      await props.onRename(draggedPath, newPath);
    }
    await reorderSiblings(parent, draggedName, target.name, !before && !target.is_dir);
    refetch();
  };

  const handleDropOnRoot = async (e: DragEvent) => {
    e.preventDefault();
    const draggedPath = e.dataTransfer?.getData("text/plain");
    if (!draggedPath || !draggedPath.includes("/")) return; // Already at root

    const name = basename(draggedPath);
    if (name && name !== draggedPath && props.onRename) {
      await props.onRename(draggedPath, name);
      refetch();
    }
  };

  const handleDragOver = (e: DragEvent) => e.preventDefault();

  const handleContextMenu = (e: MouseEvent, path: string, is_dir: boolean) => {
    setContextMenu({ x: e.clientX, y: e.clientY, name: path, is_dir });
  };

  return (
    <div class="binder-view">
      <div class="binder-header">
        <span
          class="binder-title"
          title={props.projectPath}
          onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, "", true); }}
        >
          {props.projectName || "Manuscript"}
        </span>
        <IconButton size="sm" label="New scene (⌘N)" onClick={() => startCreate("file")}>
          <FilePlus size={14} />
        </IconButton>
        <IconButton size="sm" label="New chapter folder (⌘⇧N)" onClick={() => startCreate("folder")}>
          <FolderPlus size={14} />
        </IconButton>
      </div>

      <div
        class="binder-list"
        onDragOver={handleDragOver}
        onDrop={handleDropOnRoot}
        onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, "", true); }}
      >
        {binder.loading && !binder.latest && <div class="hint binder-hint">Loading…</div>}

        {buildTree(binder.latest?.files || [], binder.latest?.order || {}).map(node => (
          <BinderTreeItem
            node={node}
            depth={0}
            activeFile={props.activeFile}
            renamingItem={renamingItem()}
            statuses={binder.latest?.statuses}
            words={wordsByFile()}
            onSelect={props.onFileSelect}
            onContextMenu={handleContextMenu}
            onRenameKeyDown={handleRenameKeyDown}
            onRenameBlur={() => setRenamingItem(null)}
            onDragStart={handleDragStart}
            onDropOnItem={handleDropOnItem}
          />
        ))}

        <Show when={creatingFile() !== false || creatingFolder() !== false}>
          <div class="binder-row binder-creating">
            {creatingFile() !== false ? <FileText size={13} class="binder-icon" /> : <FolderPlus size={13} class="binder-icon" />}
            <input
              id="binder-new-input"
              class="input binder-input"
              placeholder={creatingFile() !== false ? `${creatingFile() ? creatingFile() + '/' : ''}Scene title…` : `${creatingFolder() ? creatingFolder() + '/' : ''}Chapter name…`}
              onKeyDown={handleInputKeyDown}
              onBlur={() => { setCreatingFile(false); setCreatingFolder(false); }}
            />
          </div>
        </Show>
      </div>

      {contextMenu() && (
        <BinderContextMenu
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          itemName={contextMenu()!.name}
          isDir={contextMenu()!.is_dir}
          onClose={() => setContextMenu(null)}
          onRename={startRename}
          onDelete={handleDelete}
          onCheckContinuity={props.onCheckContinuity}
          onMergeNext={props.onMergeNext}
          onReveal={props.onReveal}
          onNewFile={(folderPath) => startCreate("file", folderPath)}
          onNewFolder={(folderPath) => startCreate("folder", folderPath)}
        />
      )}
    </div>
  );
};
