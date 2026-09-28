import { type Component, type JSX, For, onCleanup, onMount, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";

// Primitives: thin wrappers over the classes in styles/ui.css.

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export const Button: Component<ButtonProps> = (props) => {
  const [own, rest] = splitProps(props, ["variant", "size", "class"]);
  return (
    <button
      type="button"
      class={`btn btn-${own.variant ?? "secondary"}${own.size === "sm" ? " btn-sm" : ""} ${own.class ?? ""}`}
      {...rest}
    />
  );
};

type IconButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Accessible name; also the tooltip. */
  label: string;
  active?: boolean;
  size?: "sm" | "md";
};

export const IconButton: Component<IconButtonProps> = (props) => {
  const [own, rest] = splitProps(props, ["label", "active", "size", "class"]);
  return (
    <button
      type="button"
      aria-label={own.label}
      title={own.label}
      class={`icon-btn${own.size === "sm" ? " icon-btn-sm" : ""}${own.active ? " active" : ""} ${own.class ?? ""}`}
      {...rest}
    />
  );
};

export interface SegmentOption<T extends string> {
  value: T;
  label: JSX.Element;
  title?: string;
}

export function Segmented<T extends string>(props: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  class?: string;
}) {
  return (
    <div class={`segmented ${props.class ?? ""}`} role="tablist">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.value === o.value}
            class={props.value === o.value ? "active" : ""}
            title={o.title}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function Tabs<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="tabs" role="tablist">
      <For each={props.options}>
        {(o) => (
          <button type="button" role="tab" aria-selected={props.value === o.value} class={props.value === o.value ? "active" : ""} onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export const Kbd: Component<{ children: JSX.Element }> = (props) => <kbd class="kbd">{props.children}</kbd>;

export const Modal: Component<{
  title: JSX.Element;
  onClose: () => void;
  wide?: boolean;
  footer?: JSX.Element;
  children: JSX.Element;
}> = (props) => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
        <div class={`modal${props.wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true">
          <div class="modal-header">
            <h2>{props.title}</h2>
            <IconButton label="Close" onClick={props.onClose}><X size={15} /></IconButton>
          </div>
          <div class="modal-body">{props.children}</div>
          <Show when={props.footer}><div class="modal-footer">{props.footer}</div></Show>
        </div>
      </div>
    </Portal>
  );
};

export const Empty: Component<{ title?: string; children?: JSX.Element; icon?: JSX.Element }> = (props) => (
  <div class="empty">
    {props.icon}
    <Show when={props.title}><h3>{props.title}</h3></Show>
    {props.children}
  </div>
);

/** Drag handle between a side panel and the surface. */
export const Resizer: Component<{
  side: "left" | "right";
  width: number;
  min?: number;
  max?: number;
  onResize: (w: number) => void;
}> = (props) => {
  let el!: HTMLDivElement;
  const start = (e: MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = props.width;
    el.classList.add("dragging");
    const move = (ev: MouseEvent) => {
      const delta = props.side === "left" ? ev.clientX - x0 : x0 - ev.clientX;
      props.onResize(Math.max(props.min ?? 200, Math.min(props.max ?? 560, w0 + delta)));
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div ref={el} class="resizer" onMouseDown={start} />;
};
