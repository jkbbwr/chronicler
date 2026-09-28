import { type Component, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { IconButton } from "../ui";
import { overlays, setOverlays } from "../../stores/app";
import { AppearanceSection, BookSection, GoalsSection, ShortcutsSection, SpellingSection, WritingSection } from "./sections";
import { AiSection } from "./AiSection";
import { VoiceSection } from "./VoiceSection";
import { ProgramsSection } from "./ProgramsSection";
import "./settings.css";

// Settings as a two-pane sheet. Every section says whether it applies to
// every book or only the one that's open.

export type SettingsSection = "writing" | "appearance" | "spelling" | "goals" | "book" | "ai" | "readaloud" | "programs" | "shortcuts";

const SECTIONS: { id: SettingsSection; label: string; scope: "all" | "book" | null; component: Component }[] = [
  { id: "writing", label: "Writing", scope: "all", component: WritingSection },
  { id: "appearance", label: "Appearance", scope: "all", component: AppearanceSection },
  { id: "book", label: "This book", scope: "book", component: BookSection },
  { id: "goals", label: "Goals", scope: "book", component: GoalsSection },
  { id: "spelling", label: "Spelling & grammar", scope: "book", component: SpellingSection },
  { id: "ai", label: "AI", scope: "all", component: AiSection },
  { id: "readaloud", label: "Read aloud", scope: "all", component: VoiceSection },
  { id: "programs", label: "Programs", scope: "all", component: ProgramsSection },
  { id: "shortcuts", label: "Shortcuts", scope: null, component: ShortcutsSection },
];

const SCOPE_LABEL = { all: "All books", book: "This book" } as const;

export const openSettings = (section: SettingsSection = "writing") => setOverlays("settings", section);

export const SettingsSheet: Component = () => {
  const active = () => SECTIONS.find((s) => s.id === overlays.settings) ?? SECTIONS[0];
  const close = () => setOverlays("settings", false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <Portal>
      <div class="modal-backdrop settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div class="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
          <nav class="settings-nav">
            <h2>Settings</h2>
            <For each={SECTIONS}>
              {(s) => (
                <button type="button" class="settings-nav-item" classList={{ active: active().id === s.id }} onClick={() => setOverlays("settings", s.id)}>
                  {s.label}
                </button>
              )}
            </For>
          </nav>
          <section class="settings-content">
            <header class="settings-content-header">
              <h3>{active().label}</h3>
              <Show when={active().scope}>
                <span class="settings-scope" data-scope={active().scope!}>{SCOPE_LABEL[active().scope!]}</span>
              </Show>
              <IconButton label="Close" onClick={close}><X size={16} /></IconButton>
            </header>
            <div class="settings-body">
              {/* Keyed on the section so each mounts fresh (and fetches its data). */}
              <For each={[active()]}>{(s) => <s.component />}</For>
            </div>
          </section>
        </div>
      </div>
    </Portal>
  );
};
