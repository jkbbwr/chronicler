import { type Component, createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { setMode, workbench } from "./stores/workbench";
import { setCodexDraft } from "./stores/codex";
import { closeOverlays, overlays, project, projectName, setOverlays } from "./stores/app";
import { openScene } from "./stores/documents";
import { stats, targets, saveTargets } from "./stores/stats";
import { startLifecycle } from "./lib/lifecycle";
import { fmtClock, sprint, sprintRemaining, sprintWords } from "./stores/sprint";
import { registerAppCommands } from "./lib/appCommands";
import { runCritique } from "./lib/agentActions";
import { matchKeybinding, runCommand } from "./commands";
import { Titlebar } from "./components/shell/Titlebar";
import { Footer, sceneWords } from "./components/shell/Footer";
import { Inspector } from "./components/shell/Inspector";
import { LockInPrompt } from "./components/shell/LockInPrompt";
import { CatchUp } from "./components/shell/CatchUp";
import { ReportSheet } from "./components/shell/ReportSheet";
import { WriteMode } from "./components/modes/WriteMode";
import { PlanMode } from "./components/modes/PlanMode";
import { ReviewMode } from "./components/modes/ReviewMode";
import { CodexMode } from "./components/modes/CodexMode";
import { CommandPalette } from "./components/CommandPalette";
import { CompileModal } from "./components/CompileModal";
import { CritiqueModal } from "./components/CritiqueModal";
import { StatsModal } from "./components/StatsModal";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { NewProjectModal } from "./components/NewProjectModal";
import { SettingsSheet } from "./components/settings/SettingsSheet";
import { invalidate } from "./lib/rpc";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/content.css";
import "./styles/shell.css";
import "./styles/modes.css";

/** Menu item actions from the main process → command ids. */
const MENU_ACTIONS: Record<string, string> = {
  "save-file": "file.save",
  "save-all": "file.saveAll",
  "new-file": "file.newScene",
  "new-chapter": "file.newScene",
  "new-folder": "file.newFolder",
  "new-project": "file.newProject",
  "close-project-requested": "file.closeProject",
  "command-palette": "view.commandPalette",
  "quick-open": "view.quickOpen",
  "compile": "file.compile",
  "open-settings": "view.settings",
  "zen-mode": "view.zen",
  "ask-agent-selection": "agent.ask",
};

const App: Component = () => {
  // Name the book in the OS window title.
  createEffect(() => {
    const name = projectName();
    document.title = name ? `${name} — Chronicler` : "Chronicler";
  });

  // Chrome recedes while typing in the manuscript; moving the mouse restores it.
  const [typing, setTyping] = createSignal(false);

  onMount(() => {
    registerAppCommands();
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && (e.target as HTMLElement).closest?.(".cm-editor")) {
        setTyping(true);
      }
      if (e.defaultPrevented) return; // the editor (or a dialog) handled it
      const cmd = matchKeybinding(e);
      if (cmd) {
        e.preventDefault();
        cmd.run();
      }
    };
    const onMove = () => setTyping(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
    });
    window.chronicler.onMenuAction((action: string) => {
      if (action.startsWith("command:")) return runCommand(action.slice("command:".length));
      if (action.startsWith("codex-promote:")) {
        const name = action.slice("codex-promote:".length).trim();
        if (name) { setCodexDraft({ name, line: 0 }); setMode("codex"); }
        return;
      }
      const id = MENU_ACTIONS[action];
      if (id) runCommand(id);
    });
    startLifecycle();
  });

  return (
    <div class="shell" classList={{ typing: typing(), zen: workbench.zenMode && workbench.mode === "write" }}>
      <Titlebar />
      <div class="shell-body">
        <Switch>
          <Match when={workbench.mode === "write"}><WriteMode /></Match>
          <Match when={workbench.mode === "plan"}><PlanMode /></Match>
          <Match when={workbench.mode === "review"}><ReviewMode /></Match>
          <Match when={workbench.mode === "codex"}><CodexMode /></Match>
        </Switch>
        <Show when={workbench.layout.inspectorOpen && !workbench.zenMode}>
          <Inspector />
        </Show>
      </div>
      <Footer />
      <Show when={workbench.zenMode}>
        <div class="zen-count">
          <Show when={sprint()} fallback={<>{sceneWords().toLocaleString()} words</>}>
            {fmtClock(sprintRemaining())} · {sprintWords().toLocaleString()} words
          </Show>
        </div>
      </Show>

      <CommandPalette
        isOpen={!!overlays.palette}
        initialQuery={overlays.palette?.initial ?? ""}
        onClose={() => setOverlays("palette", null)}
        onSelectFile={(f) => { if (workbench.mode !== "review") setMode("write"); void openScene(f); }}
        onSelectCommand={runCommand}
      />
      <Show when={overlays.settings}>
        <SettingsSheet />
      </Show>
      <CompileModal onOrderChanged={() => invalidate("files")} />
      <Show when={overlays.critique}>
        <CritiqueModal onRun={(b) => void runCritique(b)} onClose={() => setOverlays("critique", false)} />
      </Show>
      <StatsModal open={overlays.stats} stats={stats()} targets={targets()} onClose={() => setOverlays("stats", false)} onSaveTargets={saveTargets} />
      <LockInPrompt />
      <CatchUp />
      <ReportSheet />
      <Show when={project.recents}>
        <WelcomeScreen recents={project.recents!} onNewProject={() => setOverlays("newProject", true)} />
      </Show>
      <Show when={overlays.newProject}>
        <NewProjectModal onClose={() => { setOverlays("newProject", false); closeOverlays(); }} />
      </Show>
    </div>
  );
};

export default App;
