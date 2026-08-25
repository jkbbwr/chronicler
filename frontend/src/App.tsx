import { createSignal, onMount, onCleanup, For, Show, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import { workbench, setWorkbench } from "./stores/workbench";
import { EditorView } from "./components/editor/EditorView";
import { BinderView } from "./components/sidebar/BinderView";
import { ActivityBar } from "./components/sidebar/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { TabContextMenu } from "./components/editor/TabContextMenu";
import { Divider } from "./components/Divider";
import { X, Circle, ChevronRight } from "lucide-solid";
import "./App.css";

interface TabState {
  filename: string;
  content: string;
  isDirty: boolean;
  isLoading: boolean;
}

const App: Component = () => {
  const [status, setStatus] = createSignal<string>("Initializing...");
  // Store, not signal-of-array: field updates must preserve item identity so
  // <For> never disposes a row (and its CodeMirror instance) on keystrokes.
  const [tabs, setTabs] = createStore<TabState[]>([]);
  const [activeTab, setActiveTab] = createSignal<string | null>(null);
  const [showPalette, setShowPalette] = createSignal(false);
  const [paletteInitial, setPaletteInitial] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{x: number, y: number, filename: string} | null>(null);
  const [createTrigger, setCreateTrigger] = createSignal<"file" | "folder" | null>(null);

  const tabIndex = (filename: string) => tabs.findIndex(t => t.filename === filename);
  const getTab = (filename: string) => tabs.find(t => t.filename === filename);

  onMount(async () => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    onCleanup(() => window.removeEventListener("click", handleGlobalClick));
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteInitial(e.shiftKey ? ">" : "");
        setShowPalette(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setWorkbench("panels", "left", "visible", true); // Ensure binder is visible
        setCreateTrigger(e.shiftKey ? "folder" : "file");
        // Reset trigger after a moment so it can fire again later
        setTimeout(() => setCreateTrigger(null), 100);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
        e.preventDefault();
        setWorkbench("zenMode", z => !z);
      }
    };
    window.addEventListener("keydown", handleGlobalKey);
    onCleanup(() => window.removeEventListener("keydown", handleGlobalKey));

    window.chronicler.onEvent((event: any) => {
      if (event.method === "system/recompiling") {
        setStatus("Rust Backend Recompiling...");
      }
    });

    window.chronicler.onMenuAction((action) => {
      handleMenuCommand(action);
    });

    try {
      const info = await window.chronicler.invoke("system/info");
      setStatus(`Backend connected: v${info.version}`);
    } catch (err: any) {
      setStatus(`Failed to connect: ${err.message}`);
    }
  });

  const handleMenuCommand = (action: string) => {
    if (action === "new-chapter" || action === "new-file") {
      setWorkbench("panels", "left", "visible", true);
      setCreateTrigger("file");
      setTimeout(() => setCreateTrigger(null), 100);
    } else if (action === "new-folder") {
      setWorkbench("panels", "left", "visible", true);
      setCreateTrigger("folder");
      setTimeout(() => setCreateTrigger(null), 100);
    } else if (action === "command-palette") {
      setShowPalette(true);
    } else if (action === "save-file") {
      const current = activeTab();
      if (current) {
        const tab = getTab(current);
        if (tab) handleSave(current, tab.content);
      }
    } else if (action === "save-all") {
      for (const tab of tabs) {
        if (tab.isDirty) handleSave(tab.filename, tab.content);
      }
    } else if (action === "project-opened") {
      setTabs([]);
      setActiveTab(null);
      setWorkbench("zenMode", false);
      setStatus("New project opened");
    } else if (action === "open-settings") {
      setWorkbench("isSettingsOpen", true);
    } else if (action === "zen-mode") {
      setWorkbench("zenMode", z => !z);
    } else if (action.startsWith("save-as:")) {
      // Limitation: the backend only writes inside the project root, so
      // Save As keeps the chosen basename and saves it at the root.
      const fullPath = action.split("save-as:")[1];
      const filename = fullPath.split("/").pop() || "Untitled.md";
      const current = activeTab();
      if (current) {
        const tab = getTab(current);
        if (tab) {
          handleSave(filename, tab.content).then(ok => { if (ok) openTab(filename); });
        }
      }
    }
  };

  const openTab = async (filename: string) => {
    const existing = getTab(filename);
    if (existing) {
      setActiveTab(filename);
      return;
    }

    const newTab: TabState = { filename, content: "", isDirty: false, isLoading: true };
    setTabs(tabs.length, newTab);
    setActiveTab(filename);

    try {
      const doc = await window.chronicler.invoke("document/read", { rel_path: filename });
      const idx = tabIndex(filename); // may be gone if closed while loading
      if (idx >= 0) setTabs(idx, { content: doc.content, isLoading: false });
    } catch (err: any) {
      // Don't fabricate an editable tab over a file we couldn't read — a
      // later save would overwrite the real file with placeholder text.
      setTabs(prev => prev.filter(t => t.filename !== filename));
      if (activeTab() === filename) setActiveTab(tabs.length > 0 ? tabs[tabs.length - 1].filename : null);
      setStatus(`Failed to open ${filename}: ${err.message}`);
    }
  };

  const removeTabs = (predicate: (t: TabState) => boolean) => {
    const remaining = tabs.filter(t => !predicate(t));
    setTabs(remaining.slice());
    const current = activeTab();
    if (current && !remaining.some(t => t.filename === current)) {
      setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].filename : null);
    }
  };

  const closeTab = async (filename: string, e?: Event, force?: boolean) => {
    if (e) e.stopPropagation();
    const tabToClose = getTab(filename);

    if (tabToClose?.isDirty && !force) {
      if (!window.confirm(`"${filename}" has unsaved changes. Save before closing?`)) {
        return; // Keep the tab open rather than silently discarding changes
      }
      if (!await handleSave(filename, tabToClose.content)) {
        return; // Save failed — don't close and lose the changes
      }
    }

    removeTabs(t => t.filename === filename);
  };

  // One timer per file so switching documents doesn't cancel a pending autosave
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => autoSaveTimers.forEach(clearTimeout));

  const handleEditorChange = (filename: string, newContent: string) => {
    const idx = tabIndex(filename);
    if (idx < 0) return;
    setTabs(idx, { content: newContent, isDirty: true });

    const existing = autoSaveTimers.get(filename);
    if (existing) clearTimeout(existing);
    autoSaveTimers.set(filename, setTimeout(() => {
      autoSaveTimers.delete(filename);
      const tab = getTab(filename);
      if (tab && tab.isDirty) {
        handleSave(filename, tab.content);
      }
    }, 2000));
  };

  const handleSave = async (filename: string, contentToSave: string): Promise<boolean> => {
    try {
      setStatus("Saving...");
      await window.chronicler.invoke("document/save", { rel_path: filename, content: contentToSave });
      const idx = tabIndex(filename);
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
      alert(`Failed to create folder: ${err.message}`);
    }
  };

  const handleRenameItem = async (oldName: string, newName: string) => {
    try {
      await window.chronicler.invoke("project/rename", { old_path: oldName, new_path: newName });
      // Update open tabs, including files inside a renamed folder
      const retarget = (filename: string) =>
        filename === oldName ? newName
        : filename.startsWith(oldName + "/") ? newName + filename.slice(oldName.length)
        : filename;
      tabs.forEach((t, i) => {
        const updated = retarget(t.filename);
        if (updated !== t.filename) setTabs(i, "filename", updated);
      });
      const current = activeTab();
      if (current) setActiveTab(retarget(current));
    } catch (err: any) {
      alert(`Failed to rename: ${err.message}`);
    }
  };

  const handleDeleteItem = async (name: string) => {
    if (!window.confirm(`Are you sure you want to delete '${name}'? This cannot be undone.`)) return;
    try {
      await window.chronicler.invoke("project/delete", { path: name });
      // Close the tab itself and, for folders, any tabs of files inside it
      removeTabs(t => t.filename === name || t.filename.startsWith(name + "/"));
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
    }
  };

  const closeOthers = async (filename: string) => {
    for (const tab of tabs.filter(t => t.filename !== filename)) {
      if (tab.isDirty) {
        if (!window.confirm(`"${tab.filename}" has unsaved changes. Save before closing?`)) {
          return; // Abort rather than discard unsaved work
        }
        if (!await handleSave(tab.filename, tab.content)) return;
      }
    }
    removeTabs(t => t.filename !== filename);
    setActiveTab(filename);
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
                      activeFile={activeTab() || ""}
                      createTrigger={createTrigger()}
                      onFileSelect={openTab}
                      onNewFile={handleNewFile}
                      onNewFolder={handleNewFolder}
                      onRename={handleRenameItem}
                      onDelete={handleDeleteItem}
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

          <div class="panel panel-center" style={{ flex: 1, display: 'flex', 'flex-direction': 'column' }}>
            {!workbench.zenMode && (
              <div class="editor-tabs" style={{ display: 'flex', 'overflow-x': 'auto' }}>
                  <For each={tabs}>
                    {(tab) => (
                      <div
                        class={`tab ${activeTab() === tab.filename ? "active" : ""}`}
                        onClick={() => setActiveTab(tab.filename)}
                        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, filename: tab.filename }); }}
                        style={{ cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '8px' }}
                      >
                        <span>{tab.filename}</span>
                        <div
                          onClick={(e) => closeTab(tab.filename, e)}
                          style={{ display: 'flex', 'align-items': 'center', opacity: 0.7 }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                        >
                          {tab.isDirty ? <Circle size={10} fill="var(--text-main)" stroke="none" /> : <X size={14} />}
                        </div>
                      </div>
                    )}
                  </For>
              </div>
            )}

            {/* Breadcrumbs */}
            <div style={{ padding: "8px 15px", "font-size": "12px", color: "var(--text-muted)", display: "flex", "align-items": "center", gap: "6px", "border-bottom": "1px solid var(--border-color)", background: "var(--bg-color)" }}>
              <span>Chronicler</span> <ChevronRight size={12} color="var(--text-faint)" /> <span style={{ color: "var(--text-main)" }}>{activeTab()}</span>
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
                  <div style={{ display: activeTab() === tab.filename ? 'block' : 'none', height: '100%' }}>
                    {!tab.isLoading && (
                      <EditorView
                        initialContent={tab.content}
                        onSave={(c) => handleSave(tab.filename, c)}
                        onChange={(c) => handleEditorChange(tab.filename, c)}
                      />
                    )}
                  </div>
                )}
              </For>
            </div>
          </div>

          {!workbench.zenMode && workbench.panels.right.visible && (
            <>
              <Divider panel="right" direction="right" />
              <div class="panel panel-right" style={{ width: `${workbench.panels.right.size}px` }}>
                <div class="panel-header">
                  <span>{workbench.panels.right.activeView}</span>
                </div>
                <div class="panel-content">
                  Rig AI Agent Placeholder
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
          <span>{activeTab() ? getTab(activeTab()!)?.content.trim().split(/\s+/).filter(w => w.length > 0).length + " Words" : ""}</span>
          <span>Markdown</span>
        </div>
      </div>

      <CommandPalette
        isOpen={showPalette()}
        initialQuery={paletteInitial()}
        onClose={() => setShowPalette(false)}
        onSelectFile={openTab}
        onSelectCommand={handleMenuCommand}
      />
      {contextMenu() && (
        <TabContextMenu
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          filename={contextMenu()!.filename}
          onClose={() => setContextMenu(null)}
          onCloseTab={(f) => closeTab(f)}
          onCloseOthers={closeOthers}
        />
      )}
      <SettingsModal />
    </div>
  );
};

export default App;
