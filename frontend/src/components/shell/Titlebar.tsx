import { type Component, For, Show } from "solid-js";
import { PanelLeft, PanelRight, Search, Command } from "lucide-solid";
import { MODES, setMode, toggleBinder, toggleInspector, workbench, type Mode } from "../../stores/workbench";
import { openPalette, projectName } from "../../stores/app";
import { allDiags } from "../../stores/diagnostics";
import { IconButton } from "../ui";

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? "⌘" : "Ctrl+";

/** Modes where the binder drawer applies. */
export const hasBinder = (m: Mode) => m === "write" || m === "review";

export const Titlebar: Component = () => {
  const problemCount = () => allDiags().length;
  return (
    <header class="titlebar">
      <div class="titlebar-left">
        <Show when={hasBinder(workbench.mode)}>
          <IconButton label={`Binder (${mod}[)`} active={workbench.layout.binderOpen} onClick={toggleBinder}>
            <PanelLeft size={15} />
          </IconButton>
        </Show>
        <div class="titlebar-title">
          <Show when={projectName()} fallback="Chronicler">{projectName()}</Show>
        </div>
      </div>

      <nav class="segmented mode-switch no-drag" aria-label="Mode">
        <For each={MODES}>
          {(m) => (
            <button
              type="button"
              class={workbench.mode === m.id ? "active" : ""}
              aria-pressed={workbench.mode === m.id}
              title={`${m.label} (${mod}${m.key})`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
              <Show when={m.id === "review" && problemCount() > 0}>
                <span class="count-badge">{problemCount() > 99 ? "99+" : problemCount()}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>

      <div class="titlebar-right">
        <IconButton label={`Go to scene (${mod}P)`} onClick={() => openPalette("")}>
          <Search size={15} />
        </IconButton>
        <IconButton label={`Commands (${mod}K)`} onClick={() => openPalette(">")}>
          <Command size={15} />
        </IconButton>
        <IconButton label={`Inspector (${mod}])`} active={workbench.layout.inspectorOpen} onClick={() => toggleInspector()}>
          <PanelRight size={15} />
        </IconButton>
      </div>
    </header>
  );
};
