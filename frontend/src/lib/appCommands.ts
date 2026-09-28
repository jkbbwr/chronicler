import { registerCommands, type Command } from "../commands";
import { MODES, setMode, setWorkbench, showInspector, toggleBinder, toggleInspector, updateSettings, workbench } from "../stores/workbench";
import { closeOverlays, openPalette, overlays, setOverlays, notify } from "../stores/app";
import { flush, reference, save, scene, setReference, viewFor } from "../stores/documents";
import { openInbox, setCodexDraft } from "../stores/codex";
import { recheck } from "../stores/diagnostics";
import { fetchStats } from "../stores/stats";
import { closeProject } from "./lifecycle";
import { openResearchDrawer, openSearchDrawer, triggerCreate } from "../components/shell/BinderDrawer";
import { chapterScenes, readFromCursor } from "../components/modes/WriteMode";
import { stop as stopReading } from "./readAloud";
import { openSprintDialog } from "../components/shell/SprintControl";
import { openLockIn } from "../components/shell/LockInPrompt";
import { openCatchUp } from "../components/shell/CatchUp";
import { openSettings } from "../components/settings/SettingsSheet";
import { insertAnnotation } from "../components/editor/annotations";
import { mergeWithNext, revealInFileManager, splitSceneAtCursor } from "./fileOps";
import { invalidate, invoke } from "./rpc";
import { askAboutSelection, auditCodex, draftSynopses, readManuscript, runContinuity, updateLedger } from "./agentActions";
import { revealLabel } from "./project";

// Every command in one place: the palette lists them, keybindings run them,
// and the app menu dispatches to them by id.

const currentView = () => viewFor(scene());

const selectionText = () => {
  const v = currentView();
  if (!v) return "";
  const { from, to } = v.state.selection.main;
  return v.state.sliceDoc(from, to).trim();
};

const promoteSelection = () => {
  const name = selectionText();
  if (!name) {
    notify("Select a name in the text first");
    return;
  }
  const v = currentView()!;
  setCodexDraft({ name: name.slice(0, 80), line: v.state.doc.lineAt(v.state.selection.main.head).number });
  setMode("codex");
};

const commands: Command[] = [
  // ---- Navigation ----
  ...MODES.map((m) => ({
    id: `mode.${m.id}`,
    title: `Go to ${m.label}`,
    keybinding: `Mod+${m.key}`,
    run: () => setMode(m.id),
  })),
  { id: "view.commandPalette", title: "Show All Commands", keybinding: "Mod+K", run: () => openPalette(">") },
  { id: "view.commandPaletteAlt", title: "Show All Commands", keybinding: "Mod+Shift+P", hidden: true, run: () => openPalette(">") },
  { id: "view.quickOpen", title: "Go to Scene…", keybinding: "Mod+P", run: () => openPalette("") },
  { id: "view.binder", title: "Toggle Binder", keybinding: "Mod+[", run: () => { if (workbench.mode !== "write" && workbench.mode !== "review") setMode("write"); toggleBinder(); } },
  { id: "view.inspector", title: "Toggle Inspector", keybinding: "Mod+]", run: () => toggleInspector() },
  { id: "view.search", title: "Search the Manuscript", keybinding: "Mod+Shift+F", run: () => { if (workbench.mode !== "write" && workbench.mode !== "review") setMode("write"); openSearchDrawer(); } },
  { id: "view.zen", title: "Toggle Zen (only the page)", keybinding: "Mod+Shift+Enter", run: () => { setMode("write"); setWorkbench("zenMode", (z) => !z); } },
  {
    id: "view.reference", title: "Open Scene Beside as Reference", keybinding: "Mod+\\",
    run: () => { const s = scene(); if (s) setReference(reference() === s ? null : s); },
  },
  { id: "view.settings", title: "Settings", keybinding: "Mod+,", run: () => openSettings("writing") },
  { id: "view.chapter", title: "Toggle Chapter View (whole chapter as one page)", keybinding: "Mod+Shift+C", run: () => { setMode("write"); setWorkbench("layout", "chapterView", (v) => !v); } },
  { id: "view.readAloud", title: "Read Aloud From the Cursor", run: () => { const s = scene(); if (!s) return; setMode("write"); readFromCursor(workbench.layout.chapterView ? chapterScenes(s) : [s]); } },
  { id: "view.stopReading", title: "Stop Reading Aloud", run: () => stopReading() },
  { id: "view.research", title: "Research", run: () => { setMode("write"); openResearchDrawer(); } },
  { id: "view.threads", title: "Plan: Plot Threads", run: () => setWorkbench({ mode: "plan", planView: "threads" }) },
  { id: "view.notes", title: "Review: Margin Notes", run: () => setWorkbench({ mode: "review", reviewSection: "notes" }) },
  { id: "view.prose", title: "Review: Prose Report", run: () => setWorkbench({ mode: "review", reviewSection: "prose" }) },
  { id: "sprint.start", title: "Start a Writing Sprint…", run: openSprintDialog },
  { id: "view.settingsAi", title: "Settings: AI & Models", run: () => openSettings("ai") },
  { id: "view.settingsBook", title: "Settings: About This Book", run: () => openSettings("book") },
  { id: "view.shortcuts", title: "Keyboard Shortcuts", run: () => openSettings("shortcuts") },
  { id: "view.stats", title: "Writing Statistics & Goals", run: () => { void fetchStats(); setOverlays("stats", true); } },
  { id: "view.cards", title: "Plan: Index Cards", run: () => setWorkbench({ mode: "plan", planView: "cards" }) },
  { id: "view.timeline", title: "Plan: Story Timeline", run: () => setWorkbench({ mode: "plan", planView: "timeline" }) },
  { id: "view.graph", title: "Plan: Relationships", run: () => setWorkbench({ mode: "plan", planView: "graph" }) },
  { id: "view.ledger", title: "Plan: Fact Ledger", run: () => setWorkbench({ mode: "plan", planView: "ledger" }) },
  { id: "view.history", title: "Review: History", run: () => setWorkbench({ mode: "review", reviewSection: "history" }) },
  { id: "view.findings", title: "Review: Findings in This Scene", run: () => setWorkbench({ mode: "review", reviewSection: "problems", reviewScope: "scene" }) },
  { id: "view.critique", title: "Review: Reading Critique", run: () => setWorkbench({ mode: "review", reviewSection: "critique" }) },
  { id: "codex.inbox", title: "Codex: Discovered Names", run: openInbox },
  { id: "escape", title: "Close Overlays", keybinding: "Escape", hidden: true, run: () => { if (overlays.palette || overlays.settings || overlays.stats) closeOverlays(); else if (workbench.zenMode) setWorkbench("zenMode", false); } },

  // ---- Files ----
  { id: "file.newScene", title: "New Scene", keybinding: "Mod+N", run: () => { setMode("write"); triggerCreate("file"); } },
  { id: "file.newFolder", title: "New Chapter Folder", keybinding: "Mod+Shift+N", run: () => { setMode("write"); triggerCreate("folder"); } },
  { id: "file.save", title: "Save", keybinding: "Mod+S", run: () => { const s = scene(); if (s) void save(s); } },
  { id: "file.saveAll", title: "Save All", run: () => void flush() },
  { id: "scene.split", title: "Split Scene at Cursor", run: () => void splitSceneAtCursor() },
  { id: "scene.mergeNext", title: "Merge with Next Scene", run: () => { const s = scene(); if (s) void mergeWithNext(s); } },
  { id: "file.lockIn", title: "Lock In This Version…", keybinding: "Mod+Shift+S", run: openLockIn },
  { id: "file.compile", title: "Compile Manuscript…", keybinding: "Mod+Shift+E", run: () => setWorkbench("isCompileOpen", true) },
  { id: "file.newProject", title: "New Project…", run: () => setOverlays("newProject", true) },
  { id: "file.closeProject", title: "Close Project", run: () => void closeProject() },
  { id: "file.revealProject", title: `${revealLabel} (Project Folder)`, run: () => void revealInFileManager("") },
  { id: "file.revealScene", title: `${revealLabel} (This Scene)`, run: () => { const s = scene(); if (s) void revealInFileManager(s); } },

  // ---- Editing ----
  { id: "editor.annotate", title: "Add Margin Note", keybinding: "Mod+Shift+A", run: () => { const v = currentView(); if (v) { insertAnnotation(v); v.focus(); } } },
  { id: "editor.typewriter", title: "Toggle Typewriter Scrolling", run: () => updateSettings({ typewriterMode: !workbench.settings.typewriterMode }) },
  { id: "editor.focus", title: "Toggle Focus (dim other paragraphs)", run: () => updateSettings({ focusMode: !workbench.settings.focusMode }) },
  { id: "editor.markdown", title: "Toggle Markdown Syntax", keybinding: "Mod+Shift+M", run: () => updateSettings({ editorMode: workbench.settings.editorMode === "live" ? "code" : "live" }) },
  { id: "codex.promote", title: "Add Selection to Codex", keybinding: "Mod+Shift+K", run: promoteSelection },

  // ---- Agent ----
  { id: "agent.open", title: "Agent: Open", keybinding: "Mod+J", run: () => toggleInspector("agent") },
  { id: "agent.ask", title: "Agent: Ask About Selection", keybinding: "Mod+Shift+J", run: askAboutSelection },
  { id: "agent.continuityScene", title: "Agent: Check Continuity in This Scene", run: () => { const s = scene(); if (s) void runContinuity(s); } },
  { id: "agent.continuity", title: "Agent: Check Continuity Across the Book", run: () => void runContinuity() },
  { id: "agent.catchUp", title: "Agent: Catch Me Up (where you left off)", run: () => openCatchUp() },
  { id: "agent.critique", title: "Agent: Reading Critique…", run: () => setOverlays("critique", true) },
  { id: "agent.ledger", title: "Agent: Update Fact Ledger", run: () => void updateLedger() },
  { id: "agent.synopses", title: "Agent: Draft Missing Synopses", run: () => void draftSynopses() },
  { id: "agent.hygiene", title: "Agent: Check the Codex Against the Manuscript", run: () => void auditCodex() },
  { id: "agent.read", title: "Agent: Read the Manuscript Again", run: () => void readManuscript() },
  { id: "inspector.scene", title: "Inspector: Scene Details", keybinding: "Mod+Shift+I", run: () => showInspector("scene") },

  // ---- Maintenance ----
  { id: "check.all", title: "Check Spelling & Grammar Across the Book", run: () => void recheck() },
  {
    id: "index.rebuild", title: "Rebuild Name Matching",
    run: async () => {
      notify("Rebuilding name matching…", "progress");
      try {
        const res = await invoke("index/rebuild");
        invalidate("codex");
        void recheck();
        notify(`Name matching rebuilt: ${res.mentions} mentions across ${res.files} scenes`, "success");
      } catch (err) {
        notify(`Rebuild failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    },
  },
];

export function registerAppCommands() {
  registerCommands(commands);
}
