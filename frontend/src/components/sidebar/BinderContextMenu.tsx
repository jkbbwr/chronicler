import { type Component, Show } from "solid-js";
import { revealLabel } from "../../lib/project";

interface BinderContextMenuProps {
  x: number;
  y: number;
  /** "" is the project root: only the create and reveal actions apply. */
  itemName: string;
  isDir: boolean;
  onClose: () => void;
  onRename: (itemName: string) => void;
  onDelete: (itemName: string) => void;
  onNewFile?: (folderPath: string) => void;
  onNewFolder?: (folderPath: string) => void;
  /** Scoped continuity check for a single scene. */
  onCheckContinuity?: (file: string) => void;
  /** Fold the next scene in the chapter into this one. */
  onMergeNext?: (file: string) => void;
  /** Show the item (or the project root, for "") in the OS file manager. */
  onReveal?: (itemName: string) => void;
}

const MENU_W = 200;
const MENU_H = 220;

export const BinderContextMenu: Component<BinderContextMenuProps> = (props) => {
  const act = (e: MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
    props.onClose();
  };
  const isRoot = () => props.itemName === "";
  // Keep the menu on screen near the window edges.
  const left = () => Math.min(props.x, window.innerWidth - MENU_W - 8);
  const top = () => Math.min(props.y, window.innerHeight - MENU_H - 8);

  return (
    <div class="menu" style={{ left: `${left()}px`, top: `${top()}px` }} onClick={(e) => e.stopPropagation()}>
      <Show when={props.isDir}>
        <div class="menu-item" onClick={(e) => act(e, () => props.onNewFile?.(props.itemName))}>New Scene…</div>
        <div class="menu-item" onClick={(e) => act(e, () => props.onNewFolder?.(props.itemName))}>New Chapter Folder…</div>
      </Show>
      <Show when={!props.isDir && props.onCheckContinuity}>
        <div class="menu-item" onClick={(e) => act(e, () => props.onCheckContinuity!(props.itemName))}>Check Continuity</div>
      </Show>
      <Show when={!props.isDir && !isRoot() && props.onMergeNext}>
        <div class="menu-item" onClick={(e) => act(e, () => props.onMergeNext!(props.itemName))}>Merge with Next Scene</div>
      </Show>
      <Show when={!isRoot()}>
        <Show when={props.isDir || props.onCheckContinuity}><div class="menu-sep" /></Show>
        <div class="menu-item" onClick={(e) => act(e, () => props.onRename(props.itemName))}>Rename</div>
        <div class="menu-item danger" onClick={(e) => act(e, () => props.onDelete(props.itemName))}>Delete…</div>
      </Show>
      <Show when={props.onReveal}>
        <div class="menu-sep" />
        <div class="menu-item" onClick={(e) => act(e, () => props.onReveal!(props.itemName))}>{revealLabel}</div>
      </Show>
    </div>
  );
};
