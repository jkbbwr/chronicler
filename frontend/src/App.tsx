import { createSignal, createEffect, onMount, onCleanup, For, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import { workbench, setWorkbench, updateSettings, type EditorMode } from "./stores/workbench";
import { EditorView, type EditorApi } from "./components/editor/EditorView";
import { type EntityRef } from "./components/editor/entityLinks";
import { MarkdownPreview } from "./components/editor/MarkdownPreview";
import { AgentView, handleRigEvent, seedComposer } from "./components/sidebar/AgentView";
import { CritiqueModal, type CritiqueBrief } from "./components/CritiqueModal";
import { CritiqueView } from "./components/sidebar/CritiqueView";
import { parseSceneHref, renderMarkdown } from "./lib/markdown";
import { BinderView } from "./components/sidebar/BinderView";
import { SearchView } from "./components/sidebar/SearchView";
import { OutlinerView } from "./components/sidebar/OutlinerView";
import { HistoryView } from "./components/sidebar/HistoryView";
import { CodexView } from "./components/sidebar/CodexView";
import { ActivityBar } from "./components/sidebar/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { CompileModal } from "./components/CompileModal";
import { TabContextMenu } from "./components/editor/TabContextMenu";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { EntitySheet } from "./components/center/EntitySheet";
import { InboxView } from "./components/center/InboxView";
import { IndexCardsView } from "./components/center/IndexCardsView";
import { TimelineView } from "./components/center/TimelineView";
import { GraphView } from "./components/center/GraphView";
import { SettingsView } from "./components/center/SettingsView";
import { ProblemsPanel, type LogEntry } from "./components/ProblemsPanel";
import { StatsModal, type ProjectStats, type WritingTargets } from "./components/StatsModal";
import { type Diag } from "./components/editor/diagSquiggles";
import { Divider } from "./components/Divider";
import { X, Circle, ChevronRight, User, Inbox as InboxIcon, Settings as SettingsIcon, LayoutGrid, Columns2, Maximize2, Minimize2, Clock as ClockIcon, Share2 } from "lucide-solid";
import { registerCommands, matchKeybinding, runCommand } from "./commands";
import "./App.css";

// Center tabs are typed: files edit prose; entity sheets, the Discovered
// inbox, and Settings are first-class tabs too (panels browse, center edits).
export type TabKind = "file" | "entity" | "inbox" | "settings" | "cards" | "report" | "timeline" | "graph";

interface TabState {
  kind: TabKind;
  /** Unique key. Files use their project-relative path. */
  id: string;
  /** Display label for non-file tabs; files compute theirs from the path. */
  title: string;
  // file-only fields
  filename?: string;
  content?: string;
  isDirty?: boolean;
  isLoading?: boolean;
  // entity-only
  entityId?: number;
}

interface SessionTabRef {
  kind: TabKind;
  filename?: string;
  entityId?: number;
  title?: string;
}

interface SessionData {
  openTabs: SessionTabRef[];
  activeTab: string | null;
  // Hot-exit journal: unsaved buffer contents, restored as dirty tabs
  dirty: Record<string, string>;
  panels: Record<"left" | "right" | "bottom", { size: number; visible: boolean }>;
  /** File shown read-only in the split reference pane, if any. */
  splitFile?: string | null;
}

const sessionKey = (root: string) => `chronicler-session:${root}`;

const App: Component = () => {
  const [status, setStatusRaw] = createSignal<string>("Initializing...");
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  // Status messages also land in the Output log (skipping save chatter)
  const setStatus = (message: string) => {
    setStatusRaw(message);
    if (message === "Saving..." || message === "Saved locally" || message.startsWith("Backend connected")) return;
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-199), { time, message }]);
  };
  // Store, not signal-of-array: field updates must preserve item identity so
  // <For> never disposes a row (and its CodeMirror instance) on keystrokes.
  const [tabs, setTabs] = createStore<TabState[]>([]);
  const [activeTab, setActiveTab] = createSignal<string | null>(null);
  const [showPalette, setShowPalette] = createSignal(false);
  const [paletteInitial, setPaletteInitial] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{x: number, y: number, id: string} | null>(null);
  const [createTrigger, setCreateTrigger] = createSignal<"file" | "folder" | null>(null);
  const [projectRoot, setProjectRoot] = createSignal<string | null>(null);
  // Non-null while the welcome screen is showing (no project open)
  const [welcome, setWelcome] = createSignal<{ path: string; openedAt: string }[] | null>(null);
  // Bumped when the backend reports filesystem changes; the binder refetches on it
  const [fsVersion, setFsVersion] = createSignal(0);
  const [metaVersion, setMetaVersion] = createSignal(0);
  // Read-only reference pane: previews an open file tab beside the editor
  const [splitFile, setSplitFile] = createSignal<string | null>(null);
  createEffect(() => {
    // The pane sources content from the open tab; closing that tab closes it
    const f = splitFile();
    if (f && !tabs.some(t => t.kind === "file" && t.filename === f)) setSplitFile(null);
  });
  // Bumped when codex state changes; codex panel + center tabs refetch
  const [codexVersion, setCodexVersion] = createSignal(0);
  // Editor selection awaiting "promote to codex" (with its cursor line)
  const [codexDraft, setCodexDraft] = createSignal<{ name: string; line: number } | null>(null);
  // Entity names/aliases for in-editor highlighting, longest-first
  const [entityRefs, setEntityRefs] = createSignal<EntityRef[]>([]);
  // Prose diagnostics per file (spelling/grammar squiggles + Problems panel)
  const [diagMap, setDiagMap] = createStore<Record<string, Diag[]>>({});
  // Writing statistics + targets
  const [stats, setStats] = createSignal<ProjectStats | null>(null);
  const [statsOpen, setStatsOpen] = createSignal(false);
  const [targets, setTargets] = createSignal<WritingTargets>({ dailyTarget: 500, projectTarget: 80000 });

  const localDate = () => new Date().toLocaleDateString("sv-SE"); // yyyy-mm-dd

  let statsTimer: ReturnType<typeof setTimeout> | undefined;
  const fetchStats = async () => {
    try {
      setStats(await window.chronicler.invoke("stats/get", { today: localDate() }));
    } catch { /* backend restarting */ }
  };
  const fetchStatsDebounced = () => {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(fetchStats, 2500);
  };

  const loadTargets = async () => {
    try {
      const res = await window.chronicler.invoke("db/get", { key: "writing" });
      if (res.value) setTargets(t => ({ ...t, ...JSON.parse(res.value) }));
    } catch { /* defaults */ }
  };

  const saveTargets = async (t: WritingTargets) => {
    setTargets(t);
    try {
      await window.chronicler.invoke("db/set", { key: "writing", value: JSON.stringify(t) });
    } catch (err: any) {
      setStatus(`Saving targets failed: ${err.message}`);
    }
  };

  const recheckDiags = async (relPath?: string) => {
    try {
      const res = await window.chronicler.invoke("diag/check", relPath ? { rel_path: relPath } : {});
      if (relPath) setDiagMap(relPath, res.files[relPath] ?? []);
      else {
        // Full check replaces everything
        for (const key of Object.keys(diagMap)) setDiagMap(key, undefined as any);
        for (const [file, diags] of Object.entries(res.files)) setDiagMap(file, diags as Diag[]);
      }
    } catch {
      // Models not downloaded yet; the Problems panel offers the download
    }
  };

  const jumpToDiag = async (d: Diag) => {
    await openTab(d.file);
    setTimeout(() => editorApis.get(d.file)?.revealSpan(d.line, d.colStart, d.colEnd), 60);
  };

  const addWordFromDiag = async (d: Diag) => {
    await window.chronicler.invoke("diag/add_word", { word: d.text });
    setStatus(`Added "${d.text}" to the project dictionary`);
    recheckDiags();
  };

  const dismissFinding = async (d: Diag) => {
    if (d.findingId === undefined) return;
    try {
      await window.chronicler.invoke("agents/finding_dismiss", { id: d.findingId });
      setDiagMap(d.file, (list) => (list ?? []).filter(x => x.findingId !== d.findingId));
    } catch (err: any) {
      setStatus(`Dismiss failed: ${err.message}`);
    }
  };

  const [sweeping, setSweeping] = createSignal(false);
  const runContinuity = async (relPath?: string) => {
    if (sweeping()) {
      await window.chronicler.invoke("agents/stop", { id: "continuity" }).catch(() => {});
      return;
    }
    setSweeping(true);
    setStatus(relPath ? `Continuity check: ${relPath}...` : "Continuity sweep: starting...");
    try {
      const res = await window.chronicler.invoke("agents/continuity", relPath ? { rel_path: relPath } : {});
      setStatus(
        res.stopped
          ? `Continuity sweep stopped — ${res.findings} finding(s) kept`
          : `Continuity sweep done: ${res.findings} finding(s). ${(res.summary ?? "").slice(0, 140)}`
      );
      if (res.findings > 0) setWorkbench("panels", "bottom", "visible", true);
    } catch (err: any) {
      setStatus(`Continuity sweep failed: ${err.message}`);
    } finally {
      setSweeping(false);
      recheckDiags();
    }
  };

  const fixDiag = async (d: Diag, replacement: string) => {
    const api = editorApis.get(d.file);
    if (api) {
      // Open tab: apply in-editor so dirty state and undo history stay sane
      if (!api.replaceRange(d.line, d.colStart, d.colEnd, d.text, replacement)) {
        setStatus("The text changed since this problem was found — rechecking");
        recheckDiags(d.file);
        return;
      }
    } else {
      try {
        await window.chronicler.invoke("diag/fix", {
          rel_path: d.file, line: d.line, colStart: d.colStart, colEnd: d.colEnd,
          text: d.text, replacement,
        });
      } catch (err: any) {
        setStatus(`Fix failed: ${err.message}`);
        recheckDiags(d.file);
        return;
      }
    }
    // Optimistic update: drop the fixed diag now and shift same-line
    // neighbours by the length delta so follow-up fixes stay aligned.
    // (Field matching, not identity — store setters see raw objects.)
    const delta = [...replacement].length - (d.colEnd - d.colStart);
    setDiagMap(d.file, (list) => (list ?? [])
      .filter(x => !(x.line === d.line && x.colStart === d.colStart && x.ruleId === d.ruleId))
      .map(x => x.line === d.line && x.colStart >= d.colEnd
        ? { ...x, colStart: x.colStart + delta, colEnd: x.colEnd + delta }
        : x));
    setStatus(`Fixed “${d.text}” → “${replacement}”`);
  };

  const ignoreDiag = async (d: Diag, global: boolean) => {
    await window.chronicler.invoke("diag/ignore", {
      ruleId: d.ruleId,
      file: global ? "*" : d.file,
      text: global ? "" : d.text,
    });
    setStatus(global ? `Disabled rule ${d.ruleId}` : `Ignoring "${d.text}" in ${d.file}`);
    recheckDiags();
  };

  createEffect(() => {
    codexVersion(); // refresh whenever codex state changes
    (async () => {
      try {
        const res = await window.chronicler.invoke("codex/list");
        const refs: EntityRef[] = [];
        for (const e of res.entities) {
          const base = { id: e.id, name: e.name, kind: e.kind, summary: e.summary, mentions: e.mentionCount };
          refs.push({ pattern: e.name.toLowerCase(), display: e.name, ...base });
          for (const a of e.aliases as string[]) {
            refs.push({ pattern: a.toLowerCase(), display: a, ...base });
          }
        }
        setEntityRefs(refs.filter(r => r.pattern.length >= 2).sort((a, b) => b.pattern.length - a.pattern.length));
      } catch {
        // Backend restarting; next codexVersion bump retries
      }
    })();
  });

  const tabIndex = (id: string) => tabs.findIndex(t => t.id === id);
  const getTab = (id: string) => tabs.find(t => t.id === id);
  const fileTabIndex = (filename: string) => tabs.findIndex(t => t.kind === "file" && t.filename === filename);
  const getFileTab = (filename: string) => tabs.find(t => t.kind === "file" && t.filename === filename);
  const activeFile = () => {
    const t = activeTab() ? getTab(activeTab()!) : undefined;
    return t?.kind === "file" ? t.filename! : null;
  };

  // Tabs show the basename; add the parent folder only when two open files
  // share a name (VS Code-style disambiguation).
  const tabLabel = (tab: TabState) => {
    if (tab.kind !== "file") return tab.title;
    const base = tab.filename!.split("/").pop()!;
    const ambiguous = tabs.some(t => t.kind === "file" && t.id !== tab.id && t.filename!.split("/").pop() === base);
    if (!ambiguous) return base;
    const parent = tab.filename!.split("/").slice(-2, -1)[0];
    return parent ? `${base} — ${parent}` : base;
  };

  // Live editor handles, for external reloads and search jumps (files only)
  const editorApis = new Map<string, EditorApi>();

  const confirmSaveDialog = async (filename: string): Promise<"save" | "discard" | "cancel"> => {
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to "${filename}"?`,
      detail: "Your changes will be lost if you don't save them.",
    });
    return r.response === 0 ? "save" : r.response === 1 ? "discard" : "cancel";
  };

  const showError = (message: string) => {
    window.chronicler.showMessageBox({ type: "error", message });
  };

  onMount(async () => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    onCleanup(() => window.removeEventListener("click", handleGlobalClick));
    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // e.g. CodeMirror already handled it
      const cmd = matchKeybinding(e);
      if (cmd) {
        e.preventDefault();
        cmd.run();
      }
    };
    window.addEventListener("keydown", handleGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", handleGlobalKey));

    window.chronicler.onEvent((event: any) => {
      if (event.method === "system/recompiling") {
        setStatus("Rust Backend Recompiling...");
      } else if (event.method === "project/changed") {
        handleExternalChanges(event.params?.paths ?? []);
        fetchStatsDebounced();
        pruneDeadDiags();
      } else if (event.method === "diag/updated") {
        for (const [file, diags] of Object.entries(event.params?.files ?? {})) {
          setDiagMap(file, diags as Diag[]);
        }
      } else if (event.method === "agents/finding") {
        // A continuity finding just landed for this scene — refresh its diags
        if (event.params?.file) recheckDiags(event.params.file);
      } else if (event.method === "agents/sweep") {
        setStatus(`Agent: ${event.params?.note ?? "working"}`);
      } else if (typeof event.method === "string" && event.method.startsWith("agents/")) {
        handleRigEvent(event.method, event.params ?? {});
      } else if (event.method === "codex/changed") {
        setCodexVersion(v => v + 1);
        const n = event.params?.newCandidates ?? 0;
        if (n > 0) setStatus(`Codex: ${n} new candidate${n === 1 ? "" : "s"} discovered`);
      }
    });

    window.chronicler.onMenuAction((action) => {
      handleMenuCommand(action);
    });

    await initProject();
  });

  // Deleted files never get a diag/updated push, so their problems would
  // linger in the panel until a full recheck.
  const pruneDeadDiags = async () => {
    try {
      const res = await window.chronicler.invoke("project/list_files");
      const live = new Set((res.files ?? []).map((f: any) => f.name));
      for (const key of Object.keys(diagMap)) {
        if (!live.has(key)) setDiagMap(key, undefined as any);
      }
    } catch { /* backend restarting */ }
  };

  const initProject = async () => {
    try {
      const project = await window.chronicler.getProject();
      if (!project.path) {
        setWelcome(project.recents);
        setStatus("No project open");
        return;
      }
      setWelcome(null);
      const info = await window.chronicler.invoke("system/info");
      setStatus(`Backend connected: v${info.version}`);
      setProjectRoot(info.root ?? null);
      if (info.root) await restoreSession(info.root);
      // The binder may have fetched before the backend was up (welcome screen)
      // or still hold the previous project's tree — refetch either way.
      setFsVersion(v => v + 1);
      setCodexVersion(v => v + 1);
      recheckDiags();
      loadTargets();
      fetchStats();
    } catch (err: any) {
      setStatus(`Failed to connect: ${err.message}`);
    }
  };

  const restoreSession = async (root: string) => {
    let session: SessionData | null = null;
    try {
      const raw = localStorage.getItem(sessionKey(root));
      if (raw) session = JSON.parse(raw);
    } catch {
      // Corrupt session data: start fresh
    }
    if (!session) return;

    for (const panel of ["left", "right", "bottom"] as const) {
      const p = session.panels?.[panel];
      if (p) setWorkbench("panels", panel, { size: p.size, visible: p.visible });
    }
    for (const ref of session.openTabs ?? []) {
      if (ref.kind === "file" && ref.filename) {
        await openTab(ref.filename, session.dirty?.[ref.filename]);
      } else if (ref.kind === "entity" && ref.entityId !== undefined) {
        pushTab({ kind: "entity", id: `entity:${ref.entityId}`, title: ref.title ?? "Entity", entityId: ref.entityId }, false);
      } else if (ref.kind === "inbox") {
        pushTab({ kind: "inbox", id: "inbox", title: "Discovered" }, false);
      } else if (ref.kind === "settings") {
        pushTab({ kind: "settings", id: "settings", title: "Settings" }, false);
      } else if (ref.kind === "cards") {
        pushTab({ kind: "cards", id: "cards", title: "Index Cards" }, false);
      } else if (ref.kind === "timeline") {
        pushTab({ kind: "timeline", id: "timeline", title: "Timeline" }, false);
      } else if (ref.kind === "graph") {
        pushTab({ kind: "graph", id: "graph", title: "Relationships" }, false);
      }
    }
    if (session.activeTab && getTab(session.activeTab)) {
      setActiveTab(session.activeTab);
    }
    if (session.splitFile && getFileTab(session.splitFile)) {
      setSplitFile(session.splitFile);
    }
  };

  // Persist the session (open tabs, unsaved contents, panel layout) on every
  // change, debounced. The dirty-content journal is what makes hot exit safe.
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSession: { root: string; snapshot: SessionData } | null = null;

  const flushSession = () => {
    clearTimeout(sessionTimer);
    if (!pendingSession) return;
    try {
      localStorage.setItem(sessionKey(pendingSession.root), JSON.stringify(pendingSession.snapshot));
    } catch {
      // Best-effort; a full localStorage shouldn't break the app
    }
    pendingSession = null;
  };

  createEffect(() => {
    const root = projectRoot();
    const snapshot: SessionData = {
      openTabs: tabs.map(t =>
        t.kind === "file"
          ? { kind: "file" as const, filename: t.filename }
          : { kind: t.kind, entityId: t.entityId, title: t.title }
      ),
      activeTab: activeTab(),
      dirty: Object.fromEntries(
        tabs.filter(t => t.kind === "file" && t.isDirty).map(t => [t.filename!, t.content ?? ""])
      ),
      panels: {
        left: { size: workbench.panels.left.size, visible: workbench.panels.left.visible },
        right: { size: workbench.panels.right.size, visible: workbench.panels.right.visible },
        bottom: { size: workbench.panels.bottom.size, visible: workbench.panels.bottom.visible },
      },
      splitFile: splitFile(),
    };
    if (!root) return;
    pendingSession = { root, snapshot };
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(flushSession, 500);
  });

  // The debounce must not lose the last keystrokes on quit
  window.addEventListener("beforeunload", flushSession);
  onCleanup(() => window.removeEventListener("beforeunload", flushSession));

  const handleExternalChanges = async (paths: string[]) => {
    setFsVersion(v => v + 1);
    for (const p of paths) {
      const idx = fileTabIndex(p);
      if (idx < 0) continue;
      const tab = tabs[idx];
      try {
        const doc = await window.chronicler.invoke("document/read", { rel_path: p });
        if (doc.content === tab.content) continue; // our own save echoing back
        if (!tab.isDirty) {
          editorApis.get(p)?.setContent(doc.content);
          setTabs(idx, "content", doc.content);
          setStatus(`Reloaded ${p} (changed on disk)`);
        } else {
          const r = await window.chronicler.showMessageBox({
            type: "warning",
            buttons: ["Keep My Version", "Reload From Disk"],
            defaultId: 0,
            cancelId: 0,
            message: `"${p}" has changed on disk`,
            detail: "You have unsaved changes in this file. Reloading will discard them.",
          });
          if (r.response === 1) {
            editorApis.get(p)?.setContent(doc.content);
            setTabs(idx, { content: doc.content, isDirty: false });
          }
        }
      } catch {
        // Deleted or unreadable externally; keep the buffer so nothing is lost
      }
    }
  };

  const triggerCreate = (kind: "file" | "folder") => {
    setWorkbench("panels", "left", "visible", true);
    setWorkbench("panels", "left", "activeView", "binder");
    setCreateTrigger(kind);
    setTimeout(() => setCreateTrigger(null), 100);
  };

  const saveActive = () => {
    const file = activeFile();
    if (file) {
      const tab = getFileTab(file);
      if (tab) handleSave(file, tab.content ?? "");
    }
  };

  const saveAll = () => {
    for (const tab of tabs) {
      if (tab.kind === "file" && tab.isDirty) handleSave(tab.filename!, tab.content ?? "");
    }
  };

  const [critiqueOpen, setCritiqueOpen] = createSignal(false);
  const [critiqueVersion, setCritiqueVersion] = createSignal(0);
  const openCritiqueReport = async () => {
    try {
      const res = await window.chronicler.invoke("db/get", { key: "critiqueReport" });
      if (res.value) openReportTab("critique", "Reading Critique", res.value);
      else setStatus("No critique report yet — run the wizard first");
    } catch (err: any) {
      setStatus(`Report failed: ${err.message}`);
    }
  };
  const runCritique = async (brief: CritiqueBrief) => {
    setCritiqueOpen(false);
    setStatus("Agent: reviewing the book against your brief...");
    try {
      const res = await window.chronicler.invoke("agents/critique", { brief });
      openReportTab("critique", "Reading Critique", res.markdown);
      setCritiqueVersion(v => v + 1);
      setWorkbench("panels", "left", "visible", true);
      setWorkbench("panels", "left", "activeView", "critique");
      setStatus(`Reading critique done: ${res.problems} stumbling block(s) marked`);
      if (res.problems > 0) setWorkbench("panels", "bottom", "visible", true);
    } catch (err: any) {
      setStatus(`Reading critique failed: ${err.message}`);
    } finally {
      recheckDiags();
    }
  };

  const askAgentAboutSelection = () => {
    const file = activeFile();
    const selection = file ? editorApis.get(file)?.getSelection().trim() : "";
    if (!selection) {
      setStatus("Select some prose first");
      return;
    }
    setWorkbench("panels", "right", "visible", true);
    setWorkbench("panels", "right", "activeView", "agent");
    const quoted = selection.split("\n").map(l => `> ${l}`).join("\n");
    seedComposer(`${quoted}\n\n`);
  };

  const handleMenuCommand = (action: string) => {
    if (action === "ask-agent-selection") {
      askAgentAboutSelection();
      return;
    }
    if (action === "new-chapter" || action === "new-file") {
      triggerCreate("file");
    } else if (action === "new-folder") {
      triggerCreate("folder");
    } else if (action === "command-palette") {
      runCommand("view.commandPalette");
    } else if (action === "quick-open") {
      runCommand("view.quickOpen");
    } else if (action === "close-tab") {
      runCommand("file.closeTab");
    } else if (action === "compile") {
      runCommand("compile.open");
    } else if (action.startsWith("codex-promote:")) {
      const name = action.slice("codex-promote:".length).trim();
      if (name) {
        const file = activeFile();
        const line = file ? editorApis.get(file)?.getCursorLine() ?? 0 : 0;
        setWorkbench("panels", "right", "visible", true);
        setWorkbench("panels", "right", "activeView", "codex");
        setCodexDraft({ name, line });
      }
    } else if (action === "save-file") {
      saveActive();
    } else if (action === "save-all") {
      saveAll();
    } else if (action === "project-opened") {
      // Null the root FIRST: clearing tabs below re-runs the session effect,
      // and with the old root still set it would wipe that project's session.
      setProjectRoot(null);
      flushSession();
      editorApis.clear();
      setTabs([]);
      setActiveTab(null);
      setWorkbench("zenMode", false);
      setStatus("Opening project...");
      initProject(); // picks up the new root and restores its session
    } else if (action === "open-settings") {
      openSettingsTab();
    } else if (action === "zen-mode") {
      setWorkbench("zenMode", z => !z);
    } else if (action.startsWith("save-as:")) {
      // Limitation: the backend only writes inside the project root, so
      // Save As keeps the chosen basename and saves it at the root.
      const fullPath = action.split("save-as:")[1];
      const filename = fullPath.split("/").pop() || "Untitled.md";
      const file = activeFile();
      if (file) {
        const tab = getFileTab(file);
        if (tab) {
          handleSave(filename, tab.content ?? "").then(ok => { if (ok) openTab(filename); });
        }
      }
    }
  };

  /** Add a non-file tab (or focus it if the id is already open). */
  const pushTab = (tab: TabState, focus = true) => {
    if (!getTab(tab.id)) setTabs(tabs.length, tab);
    if (focus) setActiveTab(tab.id);
  };

  const openEntityTab = (entityId: number, title: string) => {
    pushTab({ kind: "entity", id: `entity:${entityId}`, title, entityId });
  };

  const openInboxTab = () => pushTab({ kind: "inbox", id: "inbox", title: "Discovered" });
  const openCardsTab = () => pushTab({ kind: "cards", id: "cards", title: "Index Cards" });
  const [timelineVersion, setTimelineVersion] = createSignal(0);
  const openTimelineTab = () => {
    setTimelineVersion(v => v + 1);
    pushTab({ kind: "timeline", id: "timeline", title: "Timeline" });
  };
  const [graphVersion, setGraphVersion] = createSignal(0);
  const openGraphTab = () => {
    setGraphVersion(v => v + 1);
    pushTab({ kind: "graph", id: "graph", title: "Relationships" });
  };
  const openReportTab = (key: string, title: string, markdown: string) => {
    const id = `report:${key}`;
    removeTabs(t => t.id === id); // fresh content replaces the old report
    pushTab({ kind: "report", id, title, content: markdown });
  };
  const openSettingsTab = () => pushTab({ kind: "settings", id: "settings", title: "Settings" });

  // `restoreContent` carries hot-exit journal content: when it differs from
  // what's on disk, the tab opens with the journal content marked dirty.
  const openTab = async (filename: string, restoreContent?: string) => {
    const existing = getFileTab(filename);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    const newTab: TabState = { kind: "file", id: filename, title: filename, filename, content: "", isDirty: false, isLoading: true };
    setTabs(tabs.length, newTab);
    setActiveTab(filename);

    try {
      const doc = await window.chronicler.invoke("document/read", { rel_path: filename });
      const idx = fileTabIndex(filename); // may be gone if closed while loading
      if (idx < 0) return;
      if (restoreContent !== undefined && restoreContent !== doc.content) {
        setTabs(idx, { content: restoreContent, isDirty: true, isLoading: false });
      } else {
        setTabs(idx, { content: doc.content, isLoading: false });
      }
    } catch (err: any) {
      const idx = fileTabIndex(filename);
      if (restoreContent !== undefined && idx >= 0) {
        // File is gone but the journal has unsaved work — keep it recoverable
        setTabs(idx, { content: restoreContent, isDirty: true, isLoading: false });
        return;
      }
      // Don't fabricate an editable tab over a file we couldn't read — a
      // later save would overwrite the real file with placeholder text.
      setTabs(prev => prev.filter(t => t.id !== filename));
      if (activeTab() === filename) setActiveTab(tabs.length > 0 ? tabs[tabs.length - 1].id : null);
      setStatus(`Failed to open ${filename}: ${err.message}`);
    }
  };

  const openSearchResult = async (filename: string, line: number) => {
    await openTab(filename);
    // The editor mounts just after the tab state settles
    setTimeout(() => editorApis.get(filename)?.revealLine(line), 50);
  };

  const removeTabs = (predicate: (t: TabState) => boolean) => {
    for (const t of tabs) {
      if (t.kind === "file" && predicate(t)) editorApis.delete(t.filename!);
    }
    const remaining = tabs.filter(t => !predicate(t));
    setTabs(remaining.slice());
    const current = activeTab();
    if (current && !remaining.some(t => t.id === current)) {
      setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
    }
  };

  const closeTab = async (id: string, e?: Event, force?: boolean) => {
    if (e) e.stopPropagation();
    const tabToClose = getTab(id);

    if (tabToClose?.kind === "file" && tabToClose.isDirty && !force) {
      const choice = await confirmSaveDialog(tabToClose.filename!);
      if (choice === "cancel") return;
      if (choice === "save" && !await handleSave(tabToClose.filename!, tabToClose.content ?? "")) {
        return; // Save failed — don't close and lose the changes
      }
    }

    removeTabs(t => t.id === id);
  };

  // One timer per file so switching documents doesn't cancel a pending autosave
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => autoSaveTimers.forEach(clearTimeout));

  const handleEditorChange = (filename: string, newContent: string) => {
    const idx = fileTabIndex(filename);
    if (idx < 0) return;
    setTabs(idx, { content: newContent, isDirty: true });

    const existing = autoSaveTimers.get(filename);
    if (existing) clearTimeout(existing);
    autoSaveTimers.set(filename, setTimeout(() => {
      autoSaveTimers.delete(filename);
      const tab = getFileTab(filename);
      if (tab && tab.isDirty) {
        handleSave(filename, tab.content ?? "");
      }
    }, 2000));
  };

  const handleSave = async (filename: string, contentToSave: string): Promise<boolean> => {
    try {
      setStatus("Saving...");
      await window.chronicler.invoke("document/save", { rel_path: filename, content: contentToSave });
      const idx = fileTabIndex(filename);
      if (idx >= 0) setTabs(idx, "isDirty", false);
      setStatus("Saved locally");
      setTimeout(() => setStatus("Backend connected"), 2000);
      return true;
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
      return false;
    }
  };

  const handleNewFile = async (name: string) => {
    if (name) {
      const filename = name.endsWith(".md") ? name : `${name}.md`;
      await window.chronicler.invoke("document/save", { rel_path: filename, content: `# ${name}\n\n` });
      await openTab(filename);
    }
  };

  const handleNewFolder = async (name: string) => {
    try {
      await window.chronicler.invoke("project/create_folder", { rel_path: name });
    } catch (err: any) {
      showError(`Failed to create folder: ${err.message}`);
    }
  };

  const handleRenameItem = async (oldName: string, newName: string) => {
    try {
      await window.chronicler.invoke("project/rename", { old_path: oldName, new_path: newName });
      // Update open file tabs, including files inside a renamed folder
      const retarget = (filename: string) =>
        filename === oldName ? newName
        : filename.startsWith(oldName + "/") ? newName + filename.slice(oldName.length)
        : filename;
      tabs.forEach((t, i) => {
        if (t.kind !== "file") return;
        const updated = retarget(t.filename!);
        if (updated !== t.filename) {
          const api = editorApis.get(t.filename!);
          if (api) {
            editorApis.delete(t.filename!);
            editorApis.set(updated, api);
          }
          setTabs(i, { filename: updated, id: updated, title: updated });
        }
      });
      const current = activeTab();
      if (current) setActiveTab(retarget(current));
    } catch (err: any) {
      showError(`Failed to rename: ${err.message}`);
    }
  };

  const handleDeleteItem = async (name: string) => {
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Delete", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Delete "${name}"?`,
      detail: "This cannot be undone.",
    });
    if (r.response !== 0) return;
    try {
      await window.chronicler.invoke("project/delete", { path: name });
      // Close the tab itself and, for folders, any tabs of files inside it
      removeTabs(t => t.kind === "file" && (t.filename === name || t.filename!.startsWith(name + "/")));
    } catch (err: any) {
      showError(`Failed to delete: ${err.message}`);
    }
  };

  const closeOthers = async (id: string) => {
    for (const tab of tabs.filter(t => t.id !== id)) {
      if (tab.kind === "file" && tab.isDirty) {
        const choice = await confirmSaveDialog(tab.filename!);
        if (choice === "cancel") return;
        if (choice === "save" && !await handleSave(tab.filename!, tab.content ?? "")) return;
      }
    }
    removeTabs(t => t.id !== id);
    setActiveTab(id);
  };

  // Most-recently-used tab order, for Ctrl+Tab switching
  let mruOrder: string[] = [];
  createEffect(() => {
    const current = activeTab();
    const open = tabs.map(t => t.id);
    if (current) mruOrder = [current, ...mruOrder.filter(f => f !== current)];
    mruOrder = mruOrder.filter(f => open.includes(f));
  });

  const reorderTab = (from: string, to: string) => {
    if (from === to) return;
    const arr = [...tabs];
    const fi = arr.findIndex(t => t.id === from);
    const ti = arr.findIndex(t => t.id === to);
    if (fi < 0 || ti < 0) return;
    const [moved] = arr.splice(fi, 1);
    arr.splice(ti, 0, moved);
    setTabs(arr);
  };

  registerCommands([
    { id: "view.commandPalette", title: "View: Command Palette", keybinding: "Mod+Shift+P", run: () => { setPaletteInitial(">"); setShowPalette(true); } },
    { id: "view.quickOpen", title: "Go to File...", keybinding: "Mod+P", run: () => { setPaletteInitial(""); setShowPalette(true); } },
    { id: "view.zenMode", title: "View: Toggle Zen Mode", keybinding: "Mod+Shift+Z", run: () => setWorkbench("zenMode", z => !z) },
    { id: "view.settings", title: "Preferences: Open Settings", run: openSettingsTab },
    { id: "file.newFile", title: "File: New File", keybinding: "Mod+N", run: () => triggerCreate("file") },
    { id: "file.newFolder", title: "File: New Folder", keybinding: "Mod+Shift+N", run: () => triggerCreate("folder") },
    { id: "file.save", title: "File: Save", keybinding: "Mod+S", run: saveActive },
    { id: "file.saveAll", title: "File: Save All", run: saveAll },
    { id: "file.closeTab", title: "File: Close Tab", keybinding: "Mod+W", run: () => { const c = activeTab(); if (c) closeTab(c); } },
    { id: "compile.open", title: "Compile Manuscript...", keybinding: "Mod+Shift+E", run: () => setWorkbench("isCompileOpen", true) },
    { id: "codex.open", title: "Codex: Show World Bible", run: () => { setWorkbench("panels", "right", "visible", true); setWorkbench("panels", "right", "activeView", "codex"); } },
    { id: "rig.open", title: "Agent: Open Panel", keybinding: "Mod+Shift+G", run: () => { setWorkbench("panels", "right", "visible", true); setWorkbench("panels", "right", "activeView", "agent"); } },
    { id: "agent.continuity", title: "Agent: Check Continuity", run: () => runContinuity() },
    {
      id: "agent.ledger", title: "Agent: Update Fact Ledger",
      run: async () => {
        setStatus("Agent: updating the fact ledger...");
        try {
          const res = await window.chronicler.invoke("agents/ledger", {});
          setStatus(`Fact ledger: ${res.scenes} scene(s) re-read, ${res.facts} facts on file`);
        } catch (err: any) { setStatus(`Ledger update failed: ${err.message}`); }
      },
    },
    {
      id: "agent.facts", title: "Agent: Show Fact Ledger",
      run: async () => {
        try {
          const res = await window.chronicler.invoke("agents/facts", {});
          openReportTab("facts", "Fact Ledger", res.markdown);
        } catch (err: any) { setStatus(`Facts failed: ${err.message}`); }
      },
    },
    {
      id: "agent.synopses", title: "Agent: Draft Missing Synopses",
      run: async () => {
        setStatus("Agent: drafting synopses for scenes without one...");
        try {
          const res = await window.chronicler.invoke("agents/synopses", {});
          setMetaVersion(v => v + 1);
          setStatus(`Drafted ${res.drafted} synopsis(es) — see Index Cards`);
        } catch (err: any) { setStatus(`Synopsis drafting failed: ${err.message}`); }
      },
    },
    {
      id: "agent.hygiene", title: "Agent: Codex Hygiene Audit",
      run: async () => {
        setStatus("Agent: auditing the codex against the manuscript...");
        try {
          const res = await window.chronicler.invoke("agents/hygiene", {});
          setCodexVersion(v => v + 1);
          setStatus(`Codex audit: ${res.suggestions} suggestion(s) in the Discovered inbox`);
        } catch (err: any) { setStatus(`Codex audit failed: ${err.message}`); }
      },
    },
    { id: "agent.critique", title: "Agent: Reading Critique...", run: () => setCritiqueOpen(true) },
    { id: "agent.timeline", title: "Agent: Story Timeline", run: openTimelineTab },
    { id: "codex.graph", title: "Codex: Relationship Graph", run: openGraphTab },
    { id: "agent.askSelection", title: "Agent: Ask About Selection", keybinding: "Mod+Shift+Q", run: askAgentAboutSelection },
    {
      id: "agent.index", title: "Agent: Index Manuscript",
      run: async () => {
        setStatus("Agent: indexing manuscript...");
        try {
          const res = await window.chronicler.invoke("agents/index");
          setStatus(`Agent: indexed ${res.chunks} passages across ${res.files} scenes`);
        } catch (err: any) {
          setStatus(`Agent index failed: ${err.message}`);
        }
      },
    },
    { id: "codex.inbox", title: "Codex: Open Discovered Inbox", run: openInboxTab },
    { id: "view.indexCards", title: "View: Index Cards", keybinding: "Mod+Shift+I", run: openCardsTab },
    {
      id: "view.splitRight", title: "View: Open to the Side (Reference)", keybinding: "Mod+\\",
      run: () => {
        const f = activeFile();
        if (!f) { setStatus("Open a file tab first"); return; }
        setSplitFile(splitFile() === f ? null : f);
      },
    },
    { id: "view.splitClose", title: "View: Close Side Reference", hidden: true, run: () => setSplitFile(null) },
    {
      id: "index.rebuild", title: "Codex: Invalidate & Rebuild Index",
      run: async () => {
        setStatus("Rebuilding index from scratch...");
        try {
          const res = await window.chronicler.invoke("index/rebuild");
          setCodexVersion(v => v + 1);
          recheckDiags();
          setStatus(`Index rebuilt: ${res.mentions} mentions, ${res.candidates} candidates across ${res.files} files`);
        } catch (err: any) {
          setStatus(`Index rebuild failed: ${err.message}`);
        }
      },
    },
    { id: "stats.open", title: "Writing: Statistics & Targets", run: () => { fetchStats(); setStatsOpen(true); } },
    {
      id: "codex.promoteSelection", title: "Codex: Promote Selection", keybinding: "Mod+Shift+K",
      run: () => {
        const file = activeFile();
        const selection = file ? editorApis.get(file)?.getSelection().trim() : "";
        if (!selection) {
          setStatus("Select a name in the editor first");
          return;
        }
        const line = file ? editorApis.get(file)?.getCursorLine() ?? 0 : 0;
        setWorkbench("panels", "right", "visible", true);
        setWorkbench("panels", "right", "activeView", "codex");
        setCodexDraft({ name: selection.slice(0, 80), line });
      },
    },
    {
      id: "snapshot.create", title: "Snapshots: Take Snapshot",
      run: async () => {
        try {
          const res = await window.chronicler.invoke("snapshot/create", { message: `Snapshot ${new Date().toLocaleString()}` });
          setStatus(res.created ? "Snapshot saved" : res.reason);
        } catch (err: any) {
          setStatus(`Snapshot failed: ${err.message}`);
        }
      },
    },
    { id: "snapshot.history", title: "Snapshots: Show History", run: () => { setWorkbench("panels", "left", "visible", true); setWorkbench("panels", "left", "activeView", "history"); } },
    { id: "view.outline", title: "View: Outline", run: () => { setWorkbench("panels", "left", "visible", true); setWorkbench("panels", "left", "activeView", "outliner"); } },
    {
      id: "editor.annotate", title: "Editor: Insert Annotation", keybinding: "Mod+Shift+A",
      run: () => { const f = activeFile(); if (f) editorApis.get(f)?.insertAnnotation(); },
    },
    { id: "editor.toggleTypewriter", title: "Editor: Toggle Typewriter Scrolling", run: () => updateSettings({ typewriterMode: !workbench.settings.typewriterMode }) },
    { id: "editor.toggleFocus", title: "Editor: Toggle Focus Mode", run: () => updateSettings({ focusMode: !workbench.settings.focusMode }) },
    { id: "editor.modeCode", title: "Editor: Source Mode", run: () => updateSettings({ editorMode: "code" }) },
    { id: "editor.modePreview", title: "Editor: Preview Mode", run: () => updateSettings({ editorMode: "preview" }) },
    { id: "editor.modeLive", title: "Editor: Live Preview Mode", run: () => updateSettings({ editorMode: "live" }) },
    {
      id: "editor.cycleMode", title: "Editor: Cycle View Mode", keybinding: "Mod+Shift+M",
      run: () => {
        const order: EditorMode[] = ["code", "preview", "live"];
        const next = order[(order.indexOf(workbench.settings.editorMode) + 1) % order.length];
        updateSettings({ editorMode: next });
      },
    },
    { id: "tab.mruNext", title: "View: Switch to Recent Tab", keybinding: "Ctrl+Tab", run: () => { if (mruOrder.length > 1) setActiveTab(mruOrder[1]); } },
    { id: "tab.mruLast", title: "View: Switch to Least Recent Tab", keybinding: "Ctrl+Shift+Tab", hidden: true, run: () => { if (mruOrder.length > 1) setActiveTab(mruOrder[mruOrder.length - 1]); } },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `tab.goto${i + 1}`,
      title: `View: Go to Tab ${i + 1}`,
      keybinding: `Mod+${i + 1}`,
      hidden: true,
      run: () => { const t = tabs[i]; if (t) setActiveTab(t.id); },
    })),
  ]);

  const tabIcon = (tab: TabState) => {
    if (tab.kind === "entity") return <User size={12} style={{ opacity: 0.7, "flex-shrink": 0 }} />;
    if (tab.kind === "inbox") return <InboxIcon size={12} style={{ opacity: 0.7, "flex-shrink": 0 }} />;
    if (tab.kind === "settings") return <SettingsIcon size={12} style={{ opacity: 0.7, "flex-shrink": 0 }} />;
    if (tab.kind === "cards") return <LayoutGrid size={12} style={{ opacity: 0.7, "flex-shrink": 0 }} />;
    if (tab.kind === "timeline") return <ClockIcon size={12} style={{ opacity: 0.7, "flex-shrink": 0 }} />;
    if (tab.kind === "graph") return <Share2 size={12} style={{ opacity: 0.7, "flex-shrink": 0 }} />;
    return null;
  };

  const breadcrumb = () => {
    const t = activeTab() ? getTab(activeTab()!) : undefined;
    if (!t) return "";
    if (t.kind === "file") return t.filename!;
    if (t.kind === "entity") return `Codex › ${t.title}`;
    if (t.kind === "inbox") return "Codex › Discovered";
    if (t.kind === "cards") return "Index Cards";
    if (t.kind === "report") return t.title;
    if (t.kind === "timeline") return "Story Timeline";
    if (t.kind === "graph") return "Relationships";
    return "Settings";
  };

  return (
    <div class="workbench" style={{ display: 'flex', 'flex-direction': 'column', height: '100vh' }}>
      <div class="titlebar">
        <span>Chronicler {workbench.zenMode ? "(Zen Mode)" : ""}</span>
      </div>

      <div class="main-layout" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {!workbench.zenMode && <ActivityBar />}

        <div style={{ display: 'flex', 'flex-direction': 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {!workbench.zenMode && workbench.panels.left.visible && (
            <>
              <div class="panel panel-left" style={{ width: `${workbench.panels.left.size}px`, display: 'flex', 'flex-direction': 'column' }}>
                <div class="panel-header" style={{ 'min-height': '35px' }}>
                  <span>{{ binder: "Binder", outliner: "Outline", search: "Search", history: "History", critique: "Critique" }[workbench.panels.left.activeView as string] ?? workbench.panels.left.activeView}</span>
                </div>
                <div class="panel-content" style={{ padding: 0, flex: 1 }}>
                  {workbench.panels.left.activeView === "binder" && (
                    <BinderView
                      activeFile={activeFile() || ""}
                      createTrigger={createTrigger()}
                      refreshVersion={fsVersion() + metaVersion()}
                      onFileSelect={openTab}
                      onNewFile={handleNewFile}
                      onNewFolder={handleNewFolder}
                      onRename={handleRenameItem}
                      onDelete={handleDeleteItem}
                      onCheckContinuity={(file) => runContinuity(file)}
                    />
                  )}
                  {workbench.panels.left.activeView === "outliner" && (
                    <OutlinerView
                      content={activeFile() ? (getFileTab(activeFile()!)?.content ?? "") : ""}
                      onJump={(line) => { const f = activeFile(); if (f) editorApis.get(f)?.revealLine(line); }}
                    />
                  )}
                  {workbench.panels.left.activeView === "search" && (
                    <SearchView onOpenResult={openSearchResult} onStatus={setStatus} />
                  )}
                  {workbench.panels.left.activeView === "history" && (
                    <HistoryView activeFile={activeFile()} onStatus={setStatus} />
                  )}
                  {workbench.panels.left.activeView === "critique" && (
                    <CritiqueView
                      refreshVersion={critiqueVersion()}
                      onOpenScene={openTab}
                      onOpenReport={openCritiqueReport}
                      onRunWizard={() => setCritiqueOpen(true)}
                    />
                  )}
                </div>
                <div style={{ padding: "5px 10px", "font-size": "11px", color: "var(--accent)", "border-top": "1px solid var(--border-color)" }}>
                  {status()}
                </div>
              </div>
              <Divider panel="left" direction="left" />
            </>
          )}

          <div class="panel panel-center" style={{ flex: 1, "min-width": 0, display: 'flex', 'flex-direction': 'column' }}>
            {!workbench.zenMode && (
              <div class="editor-tabs" style={{ display: 'flex', 'overflow-x': 'auto' }}>
                  <For each={tabs}>
                    {(tab) => (
                      <div
                        class={`tab ${activeTab() === tab.id ? "active" : ""}`}
                        draggable={true}
                        onDragStart={(e) => e.dataTransfer?.setData("chronicler/tab", tab.id)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const from = e.dataTransfer?.getData("chronicler/tab");
                          if (from) reorderTab(from, tab.id);
                        }}
                        onClick={() => setActiveTab(tab.id)}
                        onAuxClick={(e) => { if (e.button === 1) closeTab(tab.id, e); }}
                        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, id: tab.id }); }}
                        style={{ cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '8px', 'flex-shrink': 0 }}
                        title={tab.kind === "file" ? tab.filename : tab.title}
                      >
                        {tabIcon(tab)}
                        <span style={{ 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'max-width': '160px' }}>{tabLabel(tab)}</span>
                        <div
                          onClick={(e) => closeTab(tab.id, e)}
                          style={{ display: 'flex', 'align-items': 'center', opacity: 0.7 }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                        >
                          {tab.kind === "file" && tab.isDirty ? <Circle size={10} fill="var(--text-main)" stroke="none" /> : <X size={14} />}
                        </div>
                      </div>
                    )}
                  </For>
              </div>
            )}

            {/* Breadcrumbs + view mode toggle */}
            <div style={{ padding: "4px 15px", "min-height": "30px", "font-size": "12px", color: "var(--text-muted)", display: "flex", "align-items": "center", "justify-content": "space-between", "border-bottom": "1px solid var(--border-color)", background: "var(--bg-color)" }}>
              <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                <span>Chronicler</span> <ChevronRight size={12} color="var(--text-faint)" /> <span style={{ color: "var(--text-main)" }}>{breadcrumb()}</span>
              </div>
              <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                <Show when={activeFile()}>
                  <div class="mode-toggle">
                    <For each={[["code", "Code"], ["preview", "Preview"], ["live", "Live"]] as [EditorMode, string][]}>
                      {([mode, label]) => (
                        <button
                          class={workbench.settings.editorMode === mode ? "active" : ""}
                          onClick={() => updateSettings({ editorMode: mode })}
                        >
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                {/* Always-available launchers for the board views */}
                <div style={{ display: "flex", gap: "2px" }}>
                  <button
                    class="toolbar-icon"
                    classList={{ active: activeTab() === "cards" }}
                    onClick={openCardsTab}
                  >
                    <LayoutGrid size={14} />
                    <span class="toolbar-tooltip">Index Cards</span>
                  </button>
                  <button
                    class="toolbar-icon"
                    classList={{ active: activeTab() === "timeline" }}
                    onClick={openTimelineTab}
                  >
                    <ClockIcon size={14} />
                    <span class="toolbar-tooltip">Story Timeline</span>
                  </button>
                  <button
                    class="toolbar-icon"
                    classList={{ active: activeTab() === "graph" }}
                    onClick={openGraphTab}
                  >
                    <Share2 size={14} />
                    <span class="toolbar-tooltip">Relationship Graph</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="editor-content" style={{ padding: 0, flex: 1, position: 'relative', display: 'flex', "min-height": 0 }}>
              <div style={{ flex: 1, "min-width": 0, height: '100%', position: 'relative' }}>
              <Show when={tabs.length === 0}>
                <div class="empty-state">
                  <div class="empty-state-logo">Chronicler</div>
                  <div class="shortcut-row">
                    <span class="shortcut-key">Cmd + P</span>
                    <span>Search Files</span>
                  </div>
                  <div class="shortcut-row">
                    <span class="shortcut-key">Cmd + Shift + P</span>
                    <span>Command Palette</span>
                  </div>
                  <div class="shortcut-row">
                    <span class="shortcut-key">Cmd + Shift + Z</span>
                    <span>Zen Mode</span>
                  </div>
                  <div class="shortcut-row">
                    <span class="shortcut-key">Cmd + ,</span>
                    <span>Settings</span>
                  </div>
                </div>
              </Show>
              <For each={tabs}>
                {(tab) => (
                  <div style={{ display: activeTab() === tab.id ? 'block' : 'none', height: '100%' }}>
                    {tab.kind === "file" && !tab.isLoading && (
                      workbench.settings.editorMode === "preview" ? (
                        <MarkdownPreview content={tab.content ?? ""} />
                      ) : (
                        <EditorView
                          initialContent={tab.content ?? ""}
                          entityRefs={entityRefs()}
                          diags={diagMap[tab.filename!] ?? []}
                          onSave={(c) => handleSave(tab.filename!, c)}
                          onChange={(c) => handleEditorChange(tab.filename!, c)}
                          onReady={(api) => editorApis.set(tab.filename!, api)}
                          onOpenEntity={openEntityTab}
                        />
                      )
                    )}
                    {tab.kind === "entity" && (
                      <EntitySheet
                        entityId={tab.entityId!}
                        refreshVersion={codexVersion()}
                        onTitleChange={(title) => { const i = tabIndex(tab.id); if (i >= 0) setTabs(i, "title", title); setCodexVersion(v => v + 1); }}
                        onOpenFile={openSearchResult}
                        onStatus={setStatus}
                        onDeleted={() => { removeTabs(t => t.id === tab.id); setCodexVersion(v => v + 1); }}
                        onVoiceReport={async (id, name) => {
                          setStatus(`Agent: analysing ${name}'s voice...`);
                          try {
                            const res = await window.chronicler.invoke("agents/voice", { id });
                            openReportTab(`voice:${id}`, `Voice: ${name}`, res.markdown);
                            setStatus(`Voice report ready for ${name}`);
                          } catch (err: any) {
                            setStatus(`Voice report failed: ${err.message}`);
                          }
                        }}
                      />
                    )}
                    {tab.kind === "inbox" && (
                      <InboxView
                        activeFile={activeFile()}
                        refreshVersion={codexVersion()}
                        onStatus={setStatus}
                        onChanged={() => setCodexVersion(v => v + 1)}
                        onOpenEntity={openEntityTab}
                        onOpenFile={openSearchResult}
                      />
                    )}
                    {tab.kind === "settings" && <SettingsView onStatus={setStatus} />}
                    {tab.kind === "report" && (
                      <div style={{ height: "100%", "overflow-y": "auto", position: "relative" }}>
                        <button
                          onClick={() => setWorkbench("zenMode", z => !z)}
                          title={workbench.zenMode ? "Exit full screen" : "Full screen"}
                          style={{ position: "absolute", top: "14px", right: "18px", "z-index": 5, display: "flex", "align-items": "center", "justify-content": "center", width: "28px", height: "28px", padding: 0, background: "var(--panel-bg)", border: "1px solid var(--border-color)", "border-radius": "6px", color: "var(--text-muted)", cursor: "pointer" }}
                        >
                          {workbench.zenMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                        <div
                          class="agent-md"
                          style={{ "max-width": "760px", margin: "0 auto", padding: "36px 40px", "font-size": "13.5px" }}
                          innerHTML={renderMarkdown(tab.content ?? "")}
                          onClick={(e) => {
                            const a = (e.target as HTMLElement).closest("a");
                            if (!a) return;
                            e.preventDefault();
                            const scene = parseSceneHref(a.getAttribute("href") ?? "");
                            if (scene) {
                              openTab(scene.path).then(() => {
                                if (scene.line) setTimeout(() => editorApis.get(scene.path)?.revealLine(scene.line!), 60);
                              });
                            }
                          }}
                        />
                      </div>
                    )}
                    {tab.kind === "graph" && (
                      <GraphView
                        refreshVersion={graphVersion() + codexVersion()}
                        onOpenEntity={openEntityTab}
                        onStatus={setStatus}
                      />
                    )}
                    {tab.kind === "timeline" && (
                      <TimelineView
                        refreshVersion={timelineVersion()}
                        onOpenScene={openTab}
                        onStatus={setStatus}
                      />
                    )}
                    {tab.kind === "cards" && (
                      <IndexCardsView
                        refreshVersion={fsVersion()}
                        onOpenScene={openTab}
                        onStatus={setStatus}
                        onMetaChanged={() => setMetaVersion(v => v + 1)}
                      />
                    )}
                  </div>
                )}
              </For>
              </div>

              {/* Read-only reference pane ("open to the side") */}
              <Show when={splitFile() && getFileTab(splitFile()!)}>
                <div style={{ width: "1px", background: "var(--border-color)", "flex-shrink": 0 }} />
                <div style={{ flex: 1, "min-width": 0, height: "100%", display: "flex", "flex-direction": "column" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "5px 12px", "border-bottom": "1px solid var(--border-color)", "font-size": "12px", color: "var(--text-muted)", "flex-shrink": 0 }}>
                    <Columns2 size={12} style={{ opacity: 0.7 }} />
                    <span style={{ flex: 1, overflow: "hidden", "white-space": "nowrap", "text-overflow": "ellipsis" }}>{splitFile()}</span>
                    <span style={{ color: "var(--text-faint)", "font-size": "11px" }}>read-only</span>
                    <X size={13} style={{ cursor: "pointer", "flex-shrink": 0 }} onClick={() => setSplitFile(null)} />
                  </div>
                  <div style={{ flex: 1, "min-height": 0, "overflow-y": "auto" }}>
                    <MarkdownPreview content={getFileTab(splitFile()!)?.content ?? ""} />
                  </div>
                </div>
              </Show>
            </div>
          </div>

          {!workbench.zenMode && workbench.panels.right.visible && (
            <>
              <Divider panel="right" direction="right" />
              <div class="panel panel-right" style={{ width: `${workbench.panels.right.size}px`, display: 'flex', 'flex-direction': 'column' }}>
                <div class="panel-header" style={{ gap: "12px" }}>
                  <For each={[["codex", "Codex"], ["agent", "Agent"]] as [string, string][]}>
                    {([view, label]) => (
                      <span
                        onClick={() => setWorkbench("panels", "right", "activeView", view as any)}
                        style={{
                          cursor: "pointer",
                          color: workbench.panels.right.activeView === view ? "var(--text-main)" : "var(--text-faint)",
                          "border-bottom": workbench.panels.right.activeView === view ? "1px solid var(--accent)" : "1px solid transparent",
                          "padding-bottom": "2px",
                        }}
                      >
                        {label}
                      </span>
                    )}
                  </For>
                </div>
                <div class="panel-content" style={{ padding: 0 }}>
                  {workbench.panels.right.activeView === "codex" && (
                    <CodexView
                      activeFile={activeFile()}
                      refreshVersion={codexVersion()}
                      promoteDraft={codexDraft()}
                      onDraftHandled={() => setCodexDraft(null)}
                      onOpenEntity={openEntityTab}
                      onOpenInbox={openInboxTab}
                      onStatus={setStatus}
                    />
                  )}
                  {workbench.panels.right.activeView === "agent" && (
                    <AgentView
                      activeScene={() => {
                        const f = activeFile();
                        const t = f ? getFileTab(f) : undefined;
                        return t ? { file: f!, content: t.content ?? "" } : null;
                      }}
                      onStatus={setStatus}
                      onOpenSettings={openSettingsTab}
                      onOpenScene={async (file, line) => {
                        await openTab(file);
                        if (line) setTimeout(() => editorApis.get(file)?.revealLine(line), 60);
                      }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {!workbench.zenMode && workbench.panels.bottom.visible && (
          <>
            <Divider panel="bottom" direction="up" />
            <div class="panel panel-bottom" style={{ height: `${workbench.panels.bottom.size}px`, display: 'flex', 'flex-direction': 'column' }}>
              <ProblemsPanel
                diagnostics={diagMap}
                logs={logs()}
                onJump={jumpToDiag}
                onAddWord={addWordFromDiag}
                onFix={fixDiag}
                onIgnore={ignoreDiag}
                onDismiss={dismissFinding}
                onRecheck={() => recheckDiags()}
                onStatus={setStatus}
              />
            </div>
          </>
        )}
        </div>
      </div>

      {/* Status Bar */}
      <div style={{
        height: '24px',
        background: 'var(--titlebar-bg)',
        'border-top': '1px solid var(--border-color)',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        padding: '0 12px',
        'font-size': '11px',
        color: 'var(--text-muted)'
      }}>
        <div style={{ display: 'flex', gap: '15px' }}>
          <span>{status()}</span>
        </div>
        <div style={{ display: 'flex', gap: '15px', 'align-items': 'center' }}>
          <Show when={stats()}>
            <div
              onClick={() => { fetchStats(); setStatsOpen(true); }}
              title="Writing statistics"
              style={{ display: 'flex', 'align-items': 'center', gap: '7px', cursor: 'pointer' }}
            >
              <span>today {stats()!.today.written.toLocaleString()} / {targets().dailyTarget.toLocaleString()}</span>
              <div style={{ width: '64px', height: '5px', background: 'var(--bg-color)', border: '1px solid var(--border-color)', 'border-radius': '3px', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(100, targets().dailyTarget > 0 ? (Math.max(0, stats()!.today.written) / targets().dailyTarget) * 100 : 0)}%`,
                  height: '100%',
                  background: stats()!.today.written >= targets().dailyTarget ? 'var(--entity)' : 'var(--accent)',
                }} />
              </div>
            </div>
          </Show>
          <span>{activeFile() ? (getFileTab(activeFile()!)?.content ?? "").trim().split(/\s+/).filter(w => w.length > 0).length + " Words" : ""}</span>
          <Show when={activeFile()}><span>Markdown</span></Show>
        </div>
      </div>

      <CommandPalette
        isOpen={showPalette()}
        initialQuery={paletteInitial()}
        onClose={() => setShowPalette(false)}
        onSelectFile={openTab}
        onSelectCommand={runCommand}
      />
      {contextMenu() && (
        <TabContextMenu
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          filename={contextMenu()!.id}
          onClose={() => setContextMenu(null)}
          onCloseTab={(id) => closeTab(id)}
          onCloseOthers={closeOthers}
        />
      )}
      <CompileModal onOrderChanged={() => setFsVersion(v => v + 1)} />
      <Show when={critiqueOpen()}>
        <CritiqueModal onRun={runCritique} onClose={() => setCritiqueOpen(false)} />
      </Show>
      <StatsModal open={statsOpen()} stats={stats()} targets={targets()} onClose={() => setStatsOpen(false)} onSaveTargets={saveTargets} />
      {welcome() && <WelcomeScreen recents={welcome()!} />}
    </div>
  );
};

export default App;
