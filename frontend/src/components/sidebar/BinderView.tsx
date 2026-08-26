import { type Component, createResource, createSignal, Show, createEffect } from "solid-js";
import { FileText, FolderPlus, FilePlus}  from "lucide-solid";
import { BinderContextMenu } from "./BinderContextMenu";
import { BinderTreeItem, type TreeNode } from "./BinderTreeItem";
import { buildTree, ORDER_FILE, type FileEntry, type OrderMap } from "../../lib/binderTree";
import { statusColor } from "../center/IndexCardsView";
import { onCleanup, onMount } from "solid-js";

interface BinderViewProps {
  activeFile: string;
  createTrigger?: "file" | "folder" | null;
  /** Bumped when the backend reports filesystem changes; triggers a refetch. */
  refreshVersion?: number;
  onFileSelect: (filename: string) => void;
  onNewFile: (name: string) => Promise<void> | void;
  onNewFolder?: (name: string) => Promise<void> | void;
  onRename?: (oldName: string, newName: string) => Promise<void> | void;
  onDelete?: (name: string) => Promise<void> | void;
  onCheckContinuity?: (file: string) => void;
}

const basename = (p: string) => p.split("/").pop()!;
const parentOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

const fetchBinder = async () => {
  const res = await window.chronicler.invoke("project/list_files");
  let order: OrderMap = {};
  try {
    const o = await window.chronicler.invoke("document/read", { rel_path: ORDER_FILE });
    order = JSON.parse(o.content);
  } catch {
    // No order file yet — fall back to dirs-first alphabetical
  }
  const statusColors: Record<string, string> = {};
  try {
    const meta = await window.chronicler.invoke("meta/get_all");
    for (const row of meta.meta) {
      const color = statusColor(row.status);
      if (row.status && color !== "transparent") statusColors[row.file] = color;
    }
  } catch { /* backend restarting */ }
  return { files: res.files as FileEntry[], order, statusColors };
};

export const BinderView: Component<BinderViewProps> = (props) => {
  const [binder, { refetch }] = createResource(fetchBinder);

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
      await window.chronicler.invoke("project/create_folder", { rel_path: ".chronicler" });
      await window.chronicler.invoke("document/save", { rel_path: ORDER_FILE, content: JSON.stringify(order, null, 2) });
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
    <div class="binder-view" style={{ display: "flex", "flex-direction": "column", height: "100%" }}>
      <div style={{ padding: "10px 15px", display: "flex", "justify-content": "space-between", "align-items": "center" }}>
        <span style={{ "font-size": "11px", "font-weight": 600, "text-transform": "uppercase", color: "var(--text-muted)", "letter-spacing": "0.5px" }}>Manuscript</span>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => startCreate("file")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
            title="New File (Cmd+N)"
          >
            <FilePlus size={14} strokeWidth={2} />
          </button>
          <button
            onClick={() => startCreate("folder")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
            title="New Folder (Cmd+Shift+N)"
          >
            <FolderPlus size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div
        class="file-list"
        style={{ "overflow-y": "auto", flex: 1, padding: "5px 0" }}
        onDragOver={handleDragOver}
        onDrop={handleDropOnRoot}
      >
        {binder.loading && <div style={{ padding: "5px 15px", color: "var(--text-muted)", "font-size": "12px" }}>Loading...</div>}

        {buildTree(binder()?.files || [], binder()?.order || {}).map(node => (
          <BinderTreeItem
            node={node}
            depth={0}
            activeFile={props.activeFile}
            renamingItem={renamingItem()}
            statusColors={binder()?.statusColors}
            onSelect={props.onFileSelect}
            onContextMenu={handleContextMenu}
            onRenameKeyDown={handleRenameKeyDown}
            onRenameBlur={() => setRenamingItem(null)}
            onDragStart={handleDragStart}
            onDropOnItem={handleDropOnItem}
          />
        ))}

        <Show when={creatingFile() !== false || creatingFolder() !== false}>
          <div style={{ padding: "4px 15px", display: "flex", "align-items": "center", gap: "8px" }}>
            {creatingFile() !== false ? <FileText size={12} color="var(--text-muted)" /> : <FolderPlus size={12} color="var(--text-muted)" />}
            <input
              id="binder-new-input"
              type="text"
              placeholder={creatingFile() !== false ? `${creatingFile() ? creatingFile() + '/' : ''}Filename...` : `${creatingFolder() ? creatingFolder() + '/' : ''}Folder name...`}
              onKeyDown={handleInputKeyDown}
              onBlur={() => { setCreatingFile(false); setCreatingFolder(false); }}
              style={{
                flex: 1,
                background: "var(--bg-color)",
                border: "1px solid var(--border-color)",
                color: "var(--text-main)",
                "font-size": "12px",
                padding: "4px 6px",
                outline: "none",
                "border-radius": "4px"
              }}
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
          onNewFile={(folderPath) => startCreate("file", folderPath)}
          onNewFolder={(folderPath) => startCreate("folder", folderPath)}
        />
      )}
    </div>
  );
};
