import { type Component, } from "solid-js";


interface TabContextMenuProps {
  x: number;
  y: number;
  filename: string;
  onClose: () => void;
  onCloseTab: (filename: string) => void;
  onCloseOthers: (filename: string) => void;
  onSplitRight?: (filename: string) => void;
}

export const TabContextMenu: Component<TabContextMenuProps> = (props) => {
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
      <div 
        style={{ padding: "8px 15px", cursor: "pointer" }}
        onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
        onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
        onClick={e => handleClick(e, () => props.onCloseTab(props.filename))}
      >
        Close
      </div>
      <div 
        style={{ padding: "8px 15px", cursor: "pointer" }}
        onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
        onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
        onClick={e => handleClick(e, () => props.onCloseOthers(props.filename))}
      >
        Close Others
      </div>
      {props.onSplitRight && (
        <div 
          style={{ padding: "8px 15px", cursor: "pointer", "border-top": "1px solid var(--border-color)" }}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--hover-bg)"}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
          onClick={e => handleClick(e, () => props.onSplitRight!(props.filename))}
        >
          Split Right
        </div>
      )}
    </div>
  );
};
