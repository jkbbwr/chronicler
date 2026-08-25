import { createSignal, createEffect, onMount, onCleanup, For, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import { workbench, setWorkbench, updateSettings, type EditorMode } from "./stores/workbench";
import { EditorView, type EditorApi } from "./components/editor/EditorView";
import { type EntityRef } from "./components/editor/entityLinks";
import { MarkdownPreview } from "./components/editor/MarkdownPreview";
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
import { SettingsView } from "./components/center/SettingsView";
import { Divider } from "./components/Divider";
import { X, Circle, ChevronRight, User, Inbox as InboxIcon, Settings as SettingsIcon } from "lucide-solid";
import { registerCommands, matchKeybinding, runCommand } from "./commands";
import "./App.css";

// Center tabs are typed: files edit prose; entity sheets, the Discovered
// inbox, and Settings are first-class tabs too (panels browse, center edits).
export type TabKind = "file" | "entity" | "inbox" | "settings";

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
}

const sessionKey = (root: string) => `chronicler-session:${root}`;

const App: Component = () => {
  const [status, setStatus] = createSignal<string>("Initializing...");
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
  // Bumped when codex state changes; codex panel + center tabs refetch
  const [codexVersion, setCodexVersion] = createSignal(0);
  // Editor selection awaiting "promote to codex" (with its cursor line)
  const [codexDraft, setCodexDraft] = createSignal<{ name: string; line: number } | null>(null);
  // Entity names/aliases for in-editor highlighting, longest-first
  const [entityRefs, setEntityRefs] = createSignal<EntityRef[]>([]);

  createEffect(() => {
    codexVersion(); // refresh whenever codex state changes
    (async () => {
      try {
        const res = await window.chronicler.invoke("codex/list");
        const refs: EntityRef[] = [];
        for (const e of res.entities) {
          const base = { id: e.id, name: e.name, kind: e.kind, summary: e.summary, mentions: e.mentionCount };
          refs.push({ pattern: e.name.toLowerCase(), ...base });
          for (const a of e.aliases as string[]) {
            refs.push({ pattern: a.toLowerCase(), ...base });
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
      }
    }
    if (session.activeTab && getTab(session.activeTab)) {
      setActiveTab(session.activeTab);
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

  const handleMenuCommand = (action: string) => {
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
    { id: "codex.inbox", title: "Codex: Open Discovered Inbox", run: openInboxTab },
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
    return null;
  };

  const breadcrumb = () => {
    const t = activeTab() ? getTab(activeTab()!) : undefined;
    if (!t) return "";
    if (t.kind === "file") return t.filename!;
    if (t.kind === "entity") return `Codex › ${t.title}`;
    if (t.kind === "inbox") return "Codex › Discovered";
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
                  <span>{workbench.panels.left.activeView}</span>
                </div>
                <div class="panel-content" style={{ padding: 0, flex: 1 }}>
                  {workbench.panels.left.activeView === "binder" && (
                    <BinderView
                      activeFile={activeFile() || ""}
                      createTrigger={createTrigger()}
                      refreshVersion={fsVersion()}
                      onFileSelect={openTab}
                      onNewFile={handleNewFile}
                      onNewFolder={handleNewFolder}
                      onRename={handleRenameItem}
                      onDelete={handleDeleteItem}
                    />
                  )}
                  {workbench.panels.left.activeView === "search" && (
                    <SearchView onOpenResult={openSearchResult} />
                  )}
                  {workbench.panels.left.activeView === "history" && (
                    <HistoryView activeFile={activeFile()} onStatus={setStatus} />
                  )}
                </div>
                <div style={{ padding: "5px 10px", "font-size": "11px", color: "var(--accent)", "border-top": "1px solid var(--border-color)" }}>
                  {status()}
                </div>
              </div>
              <Divider panel="left" direction="left" />
            </>
          )}

          <div class="panel panel-center" style={{ flex: 1, display: 'flex', 'flex-direction': 'column' }}>
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
            </div>

            <div class="editor-content" style={{ padding: 0, flex: 1, position: 'relative' }}>
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
                  </div>
                )}
              </For>
            </div>
          </div>

          {!workbench.zenMode && workbench.panels.right.visible && (
            <>
              <Divider panel="right" direction="right" />
              <div class="panel panel-right" style={{ width: `${workbench.panels.right.size}px`, display: 'flex', 'flex-direction': 'column' }}>
                <div class="panel-header" style={{ gap: "12px" }}>
                  <For each={[["outliner", "Outline"], ["codex", "Codex"], ["agent", "Agent"]] as [string, string][]}>
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
                  {workbench.panels.right.activeView === "outliner" && (
                    <OutlinerView
                      content={activeFile() ? (getFileTab(activeFile()!)?.content ?? "") : ""}
                      onJump={(line) => { const f = activeFile(); if (f) editorApis.get(f)?.revealLine(line); }}
                    />
                  )}
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
                    <div style={{ padding: "15px", color: "var(--text-faint)", "font-size": "12px" }}>Rig AI Agent — coming soon</div>
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
              <div class="panel-header" style={{ 'min-height': '35px' }}>
                <span>{workbench.panels.bottom.activeView}</span>
              </div>
              <div class="panel-content" style={{ overflow: 'auto' }}>
                Terminal / Output Area
              </div>
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
        <div style={{ display: 'flex', gap: '15px' }}>
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
      {welcome() && <WelcomeScreen recents={welcome()!} />}
    </div>
  );
};

export default App;
