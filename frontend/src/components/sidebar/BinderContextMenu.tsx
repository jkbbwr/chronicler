import { type Component } from "solid-js";

interface BinderContextMenuProps {
  x: number;
  y: number;
  itemName: string;
  isDir: boolean;
  onClose: () => void;
  onRename: (itemName: string) => void;
  onDelete: (itemName: string) => void;
  onNewFile?: (folderPath: string) => void;
  onNewFolder?: (folderPath: string) => void;
}

export const BinderContextMenu: Component<BinderContextMenuProps> = (props) => {
  const handleClick = (e: MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
    props.onClose();
  };

  return (
    <div style={{
      position: "fixed",
      top: `${props.y}px`,
      left: `${props.x}px`,
      background: "var(--panel-bg)",
      border: "1px solid var(--border-color)",
      "border-radius": "6px",
      "box-shadow": "0 5px 15px rgba(0,0,0,0.5)",
      "z-index": 3000,
      padding: "5px 0",
      "min-width": "150px",
      "font-size": "12px",
      color: "var(--text-main)"
    }} onClick={e => e.stopPropagation()}>
      {props.isDir && (
        <>
          <div 
            style={{ padding: "8px 15px", cursor: "pointer" }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
            onClick={e => handleClick(e, () => props.onNewFile && props.onNewFile(props.itemName))}
          >
            New File...
          </div>
          <div 
            style={{ padding: "8px 15px", cursor: "pointer", "border-bottom": "1px solid var(--border-color)", "margin-bottom": "4px", "padding-bottom": "8px" }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
            onClick={e => handleClick(e, () => props.onNewFolder && props.onNewFolder(props.itemName))}
          >
            New Folder...
          </div>
        </>
      )}
      
      <div 
        style={{ padding: "8px 15px", cursor: "pointer" }}
        onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
        onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
        onClick={e => handleClick(e, () => props.onRename(props.itemName))}
      >
        Rename
      </div>
      <div 
        style={{ padding: "8px 15px", cursor: "pointer", color: "#ff4d4f" }}
        onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
        onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
        onClick={e => handleClick(e, () => props.onDelete(props.itemName))}
      >
        Delete
      </div>
    </div>
  );
};
