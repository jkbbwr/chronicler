import { createSignal, onMount, onCleanup, For, Show, type Component } from "solid-js";
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
  const [tabs, setTabs] = createSignal<TabState[]>([]);
  const [activeTab, setActiveTab] = createSignal<string | null>(null);
  const [showPalette, setShowPalette] = createSignal(false);
  const [paletteInitial, setPaletteInitial] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{x: number, y: number, filename: string} | null>(null);
  const [createTrigger, setCreateTrigger] = createSignal<"file" | "folder" | null>(null);

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
      await openTab("Chapter 1.md");
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
    } else if (action === "save-file" || action === "save-all") {
      const current = activeTab();
      if (current) {
        const tab = tabs().find(t => t.filename === current);
        if (tab) handleSave(current, tab.content);
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
      const fullPath = action.split("save-as:")[1];
      const filename = fullPath.split("/").pop() || "Untitled.md";
      const current = activeTab();
      if (current) {
        const tab = tabs().find(t => t.filename === current);
        if (tab) {
          // For a real IDE, save to the exact path, but our backend currently saves relative to project root
          // So we just save it as the filename
          handleSave(filename, tab.content).then(() => {
            openTab(filename);
            closeOthers(filename);
          });
        }
      }
    }
  };

  const openTab = async (filename: string) => {
    const existing = tabs().find(t => t.filename === filename);
    if (existing) {
      setActiveTab(filename);
      return;
    }

    const newTab: TabState = { filename, content: "", isDirty: false, isLoading: true };
    setTabs(prev => [...prev, newTab]);
    setActiveTab(filename);

    try {
      const doc = await window.chronicler.invoke("document/read", { rel_path: filename });
      setTabs(prev => prev.map(t => t.filename === filename ? { ...t, content: doc.content, isLoading: false } : t));
    } catch (err: any) {
      setTabs(prev => prev.map(t => t.filename === filename ? { ...t, content: `# ${filename.replace(".md", "")}\n\n`, isLoading: false, isDirty: true } : t));
    }
  };

  const closeTab = (filename: string, e?: Event, force?: boolean) => {
    if (e) e.stopPropagation();
    const currentTabs = tabs();
    const tabToClose = currentTabs.find(t => t.filename === filename);
    
    if (tabToClose?.isDirty && !force) {
      if (!window.confirm(`Save changes to ${filename}?`)) return;
    }
    
    const newTabs = currentTabs.filter(t => t.filename !== filename);
    setTabs(newTabs);
    if (activeTab() === filename) {
      setActiveTab(newTabs.length > 0 ? newTabs[newTabs.length - 1].filename : null);
    }
  };

  let autoSaveTimer: any = null;

  const handleEditorChange = (filename: string, newContent: string) => {
    setTabs(prev => prev.map(t => t.filename === filename ? { ...t, content: newContent, isDirty: true } : t));
    
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      const tab = tabs().find(t => t.filename === filename);
      if (tab && tab.isDirty) {
        handleSave(filename, tab.content);
      }
    }, 2000);
  };

  const handleSave = async (filename: string, contentToSave: string) => {
    try {
      setStatus("Saving...");
      await window.chronicler.invoke("document/save", { rel_path: filename, content: contentToSave });
      setTabs(prev => prev.map(t => t.filename === filename ? { ...t, isDirty: false } : t));
      setStatus("Saved locally");
      setTimeout(() => setStatus("Backend connected"), 2000);
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
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
      // Update tabs if they are open
      setTabs(tabs().map(t => t.filename === oldName ? { ...t, filename: newName } : t));
      if (activeTab() === oldName) setActiveTab(newName);
    } catch (err: any) {
      alert(`Failed to rename: ${err.message}`);
    }
  };

  const handleDeleteItem = async (name: string) => {
    if (!window.confirm(`Are you sure you want to delete '${name}'? This cannot be undone.`)) return;
    try {
      await window.chronicler.invoke("project/delete", { path: name });
      closeTab(name, new Event('click') as any, true); // Force close without saving
    } catch (err: any) {
      alert(`Failed to delete: ${err.message}`);
    }
  };

  const closeOthers = (filename: string) => {
    const toClose = tabs().filter(t => t.filename !== filename);
    let allSaved = true;
    for (const tab of toClose) {
      if (tab.isDirty) {
        if (!window.confirm(`Save changes to ${tab.filename}?`)) {
          allSaved = false;
          break;
        }
      }
    }
    if (allSaved) {
      setTabs(tabs().filter(t => t.filename === filename));
      setActiveTab(filename);
    }
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
                  <For each={tabs()}>
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
              <Show when={tabs().length === 0}>
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
              <For each={tabs()}>
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
          <span>{activeTab() ? tabs().find(t => t.filename === activeTab())?.content.trim().split(/\s+/).filter(w => w.length > 0).length + " Words" : ""}</span>
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
          onCloseTab={(f) => closeTab(f, new Event('click'))}
          onCloseOthers={closeOthers}
        />
      )}
      <SettingsModal />
    </div>
  );
};

export default App;
