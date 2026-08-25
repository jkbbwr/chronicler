import { type Component, Show, createSignal } from "solid-js";
import { workbench, setWorkbench, updateSettings } from "../stores/workbench";
import { X, Palette, TextCursor, Bot } from "lucide-solid";

export const SettingsModal: Component = () => {
  const [activeTab, setActiveTab] = createSignal("editor");

  return (
    <Show when={workbench.isSettingsOpen}>
      <div style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.5)",
        "backdrop-filter": "blur(2px)",
        "z-index": 2000,
        display: "flex",
        "justify-content": "center",
        "align-items": "center"
      }} onClick={() => setWorkbench("isSettingsOpen", false)}>
        <div style={{
          background: "var(--panel-bg)",
          width: "700px",
          height: "500px",
          border: "1px solid var(--border-color)",
          "border-radius": "10px",
          display: "flex",
          "box-shadow": "0 15px 50px rgba(0,0,0,0.6)",
          overflow: "hidden"
        }} onClick={e => e.stopPropagation()}>
          
          {/* Sidebar */}
          <div style={{ width: "200px", background: "var(--bg-color)", "border-right": "1px solid var(--border-color)", padding: "20px 0" }}>
            <div style={{ padding: "0 20px 20px 20px", "font-weight": 600, color: "var(--text-main)", "font-size": "14px" }}>Settings</div>
            
            <div 
              onClick={() => setActiveTab("editor")}
              style={{ padding: "8px 20px", cursor: "pointer", display: "flex", "align-items": "center", gap: "10px", background: activeTab() === "editor" ? "var(--active-bg)" : "transparent", color: activeTab() === "editor" ? "var(--text-main)" : "var(--text-muted)", "font-size": "13px" }}
            >
              <TextCursor size={16} /> Editor
            </div>
            <div 
              onClick={() => setActiveTab("appearance")}
              style={{ padding: "8px 20px", cursor: "pointer", display: "flex", "align-items": "center", gap: "10px", background: activeTab() === "appearance" ? "var(--active-bg)" : "transparent", color: activeTab() === "appearance" ? "var(--text-main)" : "var(--text-muted)", "font-size": "13px" }}
            >
              <Palette size={16} /> Appearance
            </div>
            <div 
              onClick={() => setActiveTab("ai")}
              style={{ padding: "8px 20px", cursor: "pointer", display: "flex", "align-items": "center", gap: "10px", background: activeTab() === "ai" ? "var(--active-bg)" : "transparent", color: activeTab() === "ai" ? "var(--text-main)" : "var(--text-muted)", "font-size": "13px" }}
            >
              <Bot size={16} /> AI Models
            </div>
          </div>

          {/* Main Content */}
          <div style={{ flex: 1, display: "flex", "flex-direction": "column", background: "var(--panel-bg)" }}>
            <div style={{ padding: "15px 20px", display: "flex", "justify-content": "flex-end" }}>
              <X size={18} style={{ cursor: "pointer", color: "var(--text-muted)" }} onClick={() => setWorkbench("isSettingsOpen", false)} />
            </div>
            
            <div style={{ padding: "10px 40px", flex: 1, "overflow-y": "auto", color: "var(--text-main)" }}>
              <Show when={activeTab() === "editor"}>
                <h2 style={{ "font-size": "18px", color: "var(--text-main)", "margin-bottom": "20px", "font-weight": 500 }}>Editor Settings</h2>
                
                <div style={{ "margin-bottom": "25px" }}>
                  <label style={{ display: "block", "margin-bottom": "8px", "font-size": "13px", color: "var(--text-muted)" }}>Font Family</label>
                  <input
                    type="text"
                    value={workbench.settings.fontFamily}
                    onChange={(e) => updateSettings({ fontFamily: e.currentTarget.value })}
                    style={{ width: "100%", padding: "10px", background: "var(--bg-color)", border: "1px solid var(--border-color)", color: "var(--text-main)", "border-radius": "6px", outline: "none", "font-size": "13px" }}
                  />
                  <div style={{ "font-size": "11px", color: "var(--text-faint)", "margin-top": "6px" }}>The font family used for the main text editor.</div>
                </div>

                <div style={{ "margin-bottom": "25px" }}>
                  <label style={{ display: "block", "margin-bottom": "8px", "font-size": "13px", color: "var(--text-muted)" }}>Font Size (px)</label>
                  <input
                    type="number"
                    min="8"
                    max="72"
                    value={workbench.settings.fontSize}
                    onChange={(e) => {
                      const size = parseInt(e.currentTarget.value, 10);
                      if (!Number.isNaN(size) && size >= 8 && size <= 72) updateSettings({ fontSize: size });
                    }}
                    style={{ width: "100%", padding: "10px", background: "var(--bg-color)", border: "1px solid var(--border-color)", color: "var(--text-main)", "border-radius": "6px", outline: "none", "font-size": "13px" }}
                  />
                </div>
              </Show>

              <Show when={activeTab() === "ai"}>
                <h2 style={{ "font-size": "18px", color: "var(--text-main)", "margin-bottom": "20px", "font-weight": 500 }}>AI Integrations</h2>
                <div style={{ "font-size": "13px", color: "var(--text-faint)" }}>AI integration is not implemented yet.</div>
              </Show>

              <Show when={activeTab() === "appearance"}>
                <h2 style={{ "font-size": "18px", color: "var(--text-main)", "margin-bottom": "20px", "font-weight": 500 }}>Appearance</h2>
                <div style={{ "font-size": "13px", color: "var(--text-faint)" }}>Theme selection coming soon.</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};
