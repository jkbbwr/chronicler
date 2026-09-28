import { type Component, createSignal, For, Show } from "solid-js";
import { ChevronRight, FileText } from "lucide-solid";

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
  /** Scene status id by path ("idea" | "draft" | "revised" | "final"). */
  statuses?: Record<string, string>;
  /** Word count by path. */
  words?: Record<string, number>;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, is_dir: boolean) => void;
  onRenameKeyDown: (e: KeyboardEvent & { currentTarget: HTMLInputElement }, oldPath: string) => void;
  onRenameBlur: () => void;
  onDragStart: (e: DragEvent, path: string) => void;
  /** `before` is true when dropped on the top half of the row */
  onDropOnItem: (e: DragEvent, node: TreeNode, before: boolean) => void;
}

const dropBefore = (e: DragEvent, el: HTMLElement) =>
  e.clientY - el.getBoundingClientRect().top < el.getBoundingClientRect().height / 2;

const fmtWords = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/** Folder word totals, for chapter rows. */
const totalWords = (node: TreeNode, words: Record<string, number>): number =>
  node.is_dir ? node.children.reduce((sum, c) => sum + totalWords(c, words), 0) : words[node.path] ?? 0;

export const BinderTreeItem: Component<TreeItemProps> = (props) => {
  // Chapters start open: the binder is the manuscript's table of contents.
  const [isOpen, setIsOpen] = createSignal(true);
  const [drop, setDrop] = createSignal<"before" | "after" | "into" | null>(null);
  const isActive = () => !props.node.is_dir && props.activeFile === props.node.path;
  const label = () => props.node.name.replace(/\.md$/, "");
  const words = () => (props.words ? totalWords(props.node, props.words) : 0);

  return (
    <div>
      <div
        class="binder-row"
        classList={{ active: isActive(), folder: props.node.is_dir }}
        data-drop={drop() ?? undefined}
        style={{ "padding-left": `${8 + props.depth * 14}px` }}
        draggable={true}
        onDragStart={(e) => props.onDragStart(e, props.node.path)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDrop(dropBefore(e, e.currentTarget) ? "before" : props.node.is_dir ? "into" : "after");
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          const before = dropBefore(e, e.currentTarget);
          setDrop(null);
          props.onDropOnItem(e, props.node, before);
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (props.node.is_dir) setIsOpen(!isOpen());
          else props.onSelect(props.node.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onContextMenu(e, props.node.path, props.node.is_dir);
        }}
        title={props.node.path}
      >
        <Show when={props.node.is_dir} fallback={<FileText size={13} class="binder-icon" />}>
          <ChevronRight size={13} class="binder-chevron" classList={{ open: isOpen() }} />
        </Show>
        <Show
          when={props.renamingItem === props.node.path}
          fallback={<span class="binder-label">{label()}</span>}
        >
          <input
            id="binder-rename-input"
            class="input binder-input"
            value={label()}
            onKeyDown={(e) => props.onRenameKeyDown(e, props.node.path)}
            onBlur={props.onRenameBlur}
            onClick={(e) => e.stopPropagation()}
          />
        </Show>
        <Show when={words() > 0}><span class="binder-words">{fmtWords(words())}</span></Show>
        <Show when={!props.node.is_dir}>
          <span class="status-dot" data-status={props.statuses?.[props.node.path] ?? ""} />
        </Show>
      </div>

      <Show when={props.node.is_dir && isOpen()}>
        <For each={props.node.children}>
          {(child) => (
            <BinderTreeItem
              node={child}
              depth={props.depth + 1}
              activeFile={props.activeFile}
              renamingItem={props.renamingItem}
              statuses={props.statuses}
              words={props.words}
              onSelect={props.onSelect}
              onContextMenu={props.onContextMenu}
              onRenameKeyDown={props.onRenameKeyDown}
              onRenameBlur={props.onRenameBlur}
              onDragStart={props.onDragStart}
              onDropOnItem={props.onDropOnItem}
            />
          )}
        </For>
      </Show>
    </div>
  );
};
