import { type Component
} from "solid-js";
import { Folder, FolderOpen, FileText } from "lucide-solid";
import { createSignal } from "solid-js";

export interface TreeNode {
  path: string;
  name: string;
  is_dir: boolean;
  children: TreeNode[];
}

export interface TreeItemProps {
  node: TreeNode;
  depth: number;
  activeFile: string;
  renamingItem: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, is_dir: boolean) => void;
  onRenameKeyDown: (e: KeyboardEvent & { currentTarget: HTMLInputElement }, oldPath: string) => void;
  onRenameBlur: () => void;
  onDragStart: (e: DragEvent, path: string) => void;
  onDragOverFolder: (e: DragEvent) => void;
  onDropOnFolder: (e: DragEvent, path: string) => void;
}

export const BinderTreeItem: Component<TreeItemProps> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  
  const isRenaming = () => props.renamingItem === props.node.path;

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (props.node.is_dir) {
      setIsOpen(!isOpen());
    } else {
      props.onSelect(props.node.path);
    }
  };

  return (
    <div>
      <div
        draggable={true}
        onDragStart={(e) => props.onDragStart(e, props.node.path)}
        onDragOver={props.node.is_dir ? props.onDragOverFolder : undefined}
        onDrop={props.node.is_dir ? (e) => props.onDropOnFolder(e, props.node.path) : undefined}
        class={`file-item ${props.activeFile === props.node.path && !props.node.is_dir ? "active" : ""}`}
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onContextMenu(e, props.node.path, props.node.is_dir);
        }}
        style={{
          padding: `6px 15px 6px ${15 + props.depth * 15}px`,
          display: "flex",
          "align-items": "center",
          gap: "8px",
          cursor: "pointer",
          background: (props.activeFile === props.node.path && !props.node.is_dir) ? "var(--active-bg)" : "transparent",
          color: (props.activeFile === props.node.path && !props.node.is_dir) ? "var(--text-main)" : "var(--text-muted)",
          "font-size": "13px",
          transition: "background 0.15s, color 0.15s",
          "border-radius": "4px",
          margin: "0 8px 2px 8px"
        }}
        onMouseEnter={e => { if (props.activeFile !== props.node.path) { e.currentTarget.style.backgroundColor = "var(--hover-bg)"; e.currentTarget.style.color = "var(--text-main)"; } }}
        onMouseLeave={e => { if (props.activeFile !== props.node.path) { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; } }}
      >
        {props.node.is_dir 
          ? (isOpen() ? <FolderOpen size={12} strokeWidth={1.5} style={{ opacity: 0.8 }} /> : <Folder size={12} strokeWidth={1.5} style={{ opacity: 0.6 }} />)
          : <FileText size={12} strokeWidth={1.5} style={{ opacity: props.activeFile === props.node.path ? 1 : 0.6 }} />
        }
        
        {isRenaming() ? (
          <input
            id="binder-rename-input"
            type="text"
            value={props.node.name.replace(".md", "")}
            onKeyDown={(e) => props.onRenameKeyDown(e, props.node.path)}
            onBlur={props.onRenameBlur}
            onClick={e => e.stopPropagation()}
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
        ) : (
          <span style={{ "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis", "font-weight": props.node.is_dir ? 500 : 400 }}>
            {props.node.name.replace(".md", "")}
          </span>
        )}
      </div>

      {props.node.is_dir && isOpen() && props.node.children.map(child => (
        <BinderTreeItem
          node={child}
          depth={props.depth + 1}
          activeFile={props.activeFile}
          renamingItem={props.renamingItem}
          onSelect={props.onSelect}
          onContextMenu={props.onContextMenu}
          onRenameKeyDown={props.onRenameKeyDown}
          onRenameBlur={props.onRenameBlur}
          onDragStart={props.onDragStart}
          onDragOverFolder={props.onDragOverFolder}
          onDropOnFolder={props.onDropOnFolder}
        />
      ))}
    </div>
  );
};
