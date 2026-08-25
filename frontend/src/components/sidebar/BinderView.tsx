import { type Component, createResource, createSignal, Show, createEffect } from "solid-js";
import { FileText, FolderPlus, FilePlus}  from "lucide-solid";
import { BinderContextMenu } from "./BinderContextMenu";
import { BinderTreeItem, type TreeNode } from "./BinderTreeItem";
import { onCleanup, onMount } from "solid-js";

interface BinderViewProps {
  activeFile: string;
  createTrigger?: "file" | "folder" | null;
  onFileSelect: (filename: string) => void;
  onNewFile: (name: string) => void;
  onNewFolder?: (name: string) => void;
  onRename?: (oldName: string, newName: string) => void;
  onDelete?: (name: string) => void;
}

interface FileEntry {
  name: string;
  is_dir: boolean;
}

const fetchFiles = async () => {
  const res = await window.chronicler.invoke("project/list_files");
  return res.files as FileEntry[];
};

export const BinderView: Component<BinderViewProps> = (props) => {
  const [files, { refetch }] = createResource(fetchFiles);
  
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

  const handleInputKeyDown = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim();
      if (val) {
        const filePrefix = creatingFile();
        const folderPrefix = creatingFolder();
        
        if (typeof filePrefix === "string") {
          props.onNewFile(filePrefix ? `${filePrefix}/${val}` : val);
        } else if (typeof folderPrefix === "string" && props.onNewFolder) {
          props.onNewFolder(folderPrefix ? `${folderPrefix}/${val}` : val);
        }
      }
      setCreatingFile(false);
      setCreatingFolder(false);
      setTimeout(refetch, 100);
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

  const handleRenameKeyDown = (e: KeyboardEvent & { currentTarget: HTMLInputElement }, oldName: string) => {
    if (e.key === "Enter") {
      const val = e.currentTarget.value.trim();
      if (val) {
        const parts = oldName.split("/");
        parts[parts.length - 1] = val;
        const newPath = parts.join("/");
        if (newPath !== oldName) {
          if (props.onRename) props.onRename(oldName, newPath);
          setTimeout(refetch, 100);
        }
      }
      setRenamingItem(null);
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

  const handleDelete = (name: string) => {
    if (props.onDelete) props.onDelete(name);
    setTimeout(refetch, 100);
  };

  const handleDragStart = (e: DragEvent, name: string) => {
    e.dataTransfer?.setData("text/plain", name);
  };

  const handleDropOnFolder = async (e: DragEvent, folderName: string) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedName = e.dataTransfer?.getData("text/plain");
    if (!draggedName || draggedName === folderName) return;

    const baseName = draggedName.split("/").pop();
    const newPath = `${folderName}/${baseName}`;
    if (newPath !== draggedName) {
      if (props.onRename) props.onRename(draggedName, newPath);
      setTimeout(refetch, 100);
    }
  };

  const handleDropOnRoot = async (e: DragEvent) => {
    e.preventDefault();
    const draggedName = e.dataTransfer?.getData("text/plain");
    if (!draggedName || !draggedName.includes("/")) return; // Already at root

    const baseName = draggedName.split("/").pop();
    if (baseName && baseName !== draggedName) {
      if (props.onRename) props.onRename(draggedName, baseName);
      setTimeout(refetch, 100);
    }
  };

  const handleDragOver = (e: DragEvent) => e.preventDefault();

  const handleContextMenu = (e: MouseEvent, path: string, is_dir: boolean) => {
    setContextMenu({ x: e.clientX, y: e.clientY, name: path, is_dir });
  };

  const buildTree = (list: FileEntry[]) => {
    const rootNodes: TreeNode[] = [];
    const map = new Map<string, TreeNode>();
    
    // Sort so parents come before children
    const sorted = [...list].sort((a, b) => a.name.length - b.name.length);

    for (const f of sorted) {
      const parts = f.name.split("/");
      const name = parts.pop()!;
      const parentPath = parts.join("/");
      
      const node: TreeNode = {
        path: f.name,
        name,
        is_dir: f.is_dir,
        children: []
      };
      
      map.set(f.name, node);
      
      if (parentPath === "") {
        rootNodes.push(node);
      } else {
        const parent = map.get(parentPath);
        if (parent) {
          parent.children.push(node);
        } else {
          // Fallback if parent missing
          rootNodes.push(node);
        }
      }
    }
    
    const sortNodes = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const node of nodes) {
        if (node.is_dir) sortNodes(node.children);
      }
    };
    
    sortNodes(rootNodes);
    return rootNodes;
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
        {files.loading && <div style={{ padding: "5px 15px", color: "var(--text-muted)", "font-size": "12px" }}>Loading...</div>}
        
        {buildTree(files() || []).map(node => (
          <BinderTreeItem
            node={node}
            depth={0}
            activeFile={props.activeFile}
            renamingItem={renamingItem()}
            onSelect={props.onFileSelect}
            onContextMenu={handleContextMenu}
            onRenameKeyDown={handleRenameKeyDown}
            onRenameBlur={() => setRenamingItem(null)}
            onDragStart={handleDragStart}
            onDragOverFolder={handleDragOver}
            onDropOnFolder={handleDropOnFolder}
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
          onNewFile={(folderPath) => startCreate("file", folderPath)}
          onNewFolder={(folderPath) => startCreate("folder", folderPath)}
        />
      )}
    </div>
  );
};
