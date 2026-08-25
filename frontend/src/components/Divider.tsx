import { type Component, createSignal, onCleanup } from "solid-js";
import { workbench, setWorkbench, type PanelId } from "../stores/workbench";

interface DividerProps {
  panel: PanelId;
  direction: "left" | "right" | "up" | "down";
}

export const Divider: Component<DividerProps> = (props) => {
  const [isDragging, setIsDragging] = createSignal(false);
  const isVertical = () => props.direction === "up" || props.direction === "down";

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = workbench.panels[props.panel].size;

    const handlePointerMove = (e: PointerEvent) => {
      if (!isDragging()) return;
      
      if (props.direction === "left" || props.direction === "right") {
        const deltaX = e.clientX - startX;
        const newWidth = props.direction === "left" 
          ? Math.max(150, Math.min(startSize + deltaX, 600))
          : Math.max(150, Math.min(startSize - deltaX, 600));
        setWorkbench("panels", props.panel, "size", newWidth);
      } else {
        const deltaY = e.clientY - startY;
        const newHeight = props.direction === "up"
          ? Math.max(100, Math.min(startSize - deltaY, 800))
          : Math.max(100, Math.min(startSize + deltaY, 800));
        setWorkbench("panels", props.panel, "size", newHeight);
      }
    };

    const handlePointerUp = () => {
      setIsDragging(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  onCleanup(() => {
    setIsDragging(false);
  });

  return (
    <div
      onPointerDown={handlePointerDown}
      style={{
        width: isVertical() ? "100%" : "4px",
        height: isVertical() ? "4px" : "100%",
        cursor: isVertical() ? "row-resize" : "col-resize",
        "background-color": isDragging() ? "var(--accent)" : "transparent",
        "z-index": 10,
        transition: "background-color 0.2s",
        "flex-shrink": 0
      }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--accent)")}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = isDragging() ? "var(--accent)" : "transparent")}
    />
  );
};
