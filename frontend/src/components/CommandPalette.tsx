import { type Component, createSignal, createEffect, For, Show } from "solid-js";
import { Search, Terminal } from "lucide-solid";

interface CommandPaletteProps {
  isOpen: boolean;
  initialQuery?: string;
  onClose: () => void;
  onSelectFile: (filename: string) => void;
  onSelectCommand: (commandId: string) => void;
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [files, setFiles] = createSignal<string[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const commands = [
    { id: "zen-mode", label: "View: Toggle Zen Mode" },
    { id: "save-all", label: "File: Save All" },
    { id: "open-settings", label: "Preferences: Open Settings" }
  ];

  let inputRef!: HTMLInputElement;

  createEffect(() => {
    if (props.isOpen) {
      setQuery(props.initialQuery || "");
      setSelectedIndex(0);
      setTimeout(() => inputRef?.focus(), 50);
      window.chronicler.invoke("project/list_files").then((res: any) => {
        // Only files are openable — directories would fail document/read
        const fileNames = res.files
          .filter((f: any) => !f.is_dir)
          .map((f: any) => f.name as string);
        setFiles(fileNames);
      });
    }
  });

  const isCommandMode = () => query().startsWith(">");

  const filteredItems = () => {
    if (isCommandMode()) {
      const q = query().slice(1).toLowerCase().trim();
      return commands.filter(c => c.label.toLowerCase().includes(q));
    } else {
      const q = query().toLowerCase().trim();
      return files().filter(f => f.toLowerCase().includes(q)).map(f => ({ id: f, label: f }));
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const items = filteredItems();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setSelectedIndex((s) => (s + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setSelectedIndex((s) => (s - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[selectedIndex()]) {
        if (isCommandMode()) {
          props.onSelectCommand(items[selectedIndex()].id);
        } else {
          props.onSelectFile(items[selectedIndex()].id);
        }
        props.onClose();
      }
    } else if (e.key === "Escape") {
      props.onClose();
    }
  };

  return (
    <Show when={props.isOpen}>
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.6)", "backdrop-filter": "blur(2px)", "z-index": 2000,
        display: "flex", "justify-content": "center", "align-items": "flex-start",
        "padding-top": "15vh"
      }} onClick={props.onClose}>
        <div style={{
          background: "var(--panel-bg)", width: "600px", "max-height": "400px",
          border: "1px solid var(--border-color)", "border-radius": "8px",
          display: "flex", "flex-direction": "column", "box-shadow": "0 15px 40px rgba(0,0,0,0.5)"
        }} onClick={e => e.stopPropagation()}>
          <div style={{ display: "flex", "align-items": "center", padding: "12px 15px", "border-bottom": "1px solid var(--border-color)" }}>
            {isCommandMode() ? <Terminal size={16} color="var(--text-muted)" style={{ "margin-right": "10px" }}/> : <Search size={16} color="var(--text-muted)" style={{ "margin-right": "10px" }} />}
            <input
              ref={inputRef}
              type="text"
              value={query()}
              onInput={(e) => { setQuery(e.currentTarget.value); setSelectedIndex(0); }}
              onKeyDown={handleKeyDown}
              placeholder="Search files... (Type > for commands)"
              style={{
                flex: 1, background: "transparent", border: "none", color: "var(--text-main)",
                "font-size": "14px", outline: "none"
              }}
            />
          </div>
          <div style={{ "overflow-y": "auto", flex: 1, padding: "5px 0" }}>
            <For each={filteredItems()}>
              {(item, i) => (
                <div
                  style={{
                    padding: "8px 15px", cursor: "pointer", "font-size": "13px",
                    background: i() === selectedIndex() ? "var(--hover-bg)" : "transparent",
                    color: i() === selectedIndex() ? "var(--text-main)" : "var(--text-muted)",
                    "border-left": i() === selectedIndex() ? "2px solid var(--accent)" : "2px solid transparent"
                  }}
                  onMouseEnter={() => setSelectedIndex(i())}
                  onClick={() => {
                    if (isCommandMode()) props.onSelectCommand(item.id);
                    else props.onSelectFile(item.id);
                    props.onClose();
                  }}
                >
                  {item.label}
                </div>
              )}
            </For>
            {filteredItems().length === 0 && (
              <div style={{ padding: "15px", color: "var(--text-faint)", "text-align": "center", "font-size": "13px" }}>
                No results found
              </div>
            )}
          </div>
        </div>
      </div>
    </Show>
  );
};
