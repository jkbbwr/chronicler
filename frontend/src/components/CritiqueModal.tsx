import { type Component, createSignal, onMount } from "solid-js";
import { X } from "lucide-solid";

// The reading-critique wizard: the writer describes who the book is for and
// how it should read; the agent then reviews every scene against that brief.

export interface CritiqueBrief {
  audience: string;
  tone: string;
  similarAuthors: string;
  style: string;
  notes: string;
}

interface CritiqueModalProps {
  onRun: (brief: CritiqueBrief) => void;
  onClose: () => void;
}

const label = {
  display: "block", "margin": "14px 0 5px", "font-size": "12px",
  color: "var(--text-muted)", "text-transform": "uppercase" as const,
  "letter-spacing": "0.5px", "font-weight": 600,
} as const;

const input = {
  width: "100%", padding: "8px 10px", background: "var(--bg-color)",
  border: "1px solid var(--border-color)", color: "var(--text-main)",
  "border-radius": "6px", outline: "none", "font-size": "13px",
  "box-sizing": "border-box" as const, "font-family": "inherit",
} as const;

export const CritiqueModal: Component<CritiqueModalProps> = (props) => {
  const [brief, setBrief] = createSignal<CritiqueBrief>({
    audience: "", tone: "", similarAuthors: "", style: "", notes: "",
  });
  const set = (patch: Partial<CritiqueBrief>) => setBrief({ ...brief(), ...patch });

  onMount(async () => {
    try {
      const res = await window.chronicler.invoke("db/get", { key: "critiqueBrief" });
      if (res.value) setBrief({ ...brief(), ...JSON.parse(res.value) });
    } catch { /* fresh brief */ }
  });

  const run = async () => {
    try {
      await window.chronicler.invoke("db/set", { key: "critiqueBrief", value: JSON.stringify(brief()) });
    } catch { /* still run */ }
    props.onRun(brief());
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", "align-items": "center", "justify-content": "center", "z-index": 300 }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <div style={{ width: "520px", "max-height": "85vh", "overflow-y": "auto", background: "var(--panel-bg)", border: "1px solid var(--border-color)", "border-radius": "10px", padding: "22px 26px 24px" }}>
        <div style={{ display: "flex", "align-items": "center", "margin-bottom": "4px" }}>
          <h2 style={{ margin: 0, "font-size": "17px", color: "var(--text-main)" }}>Reading critique</h2>
          <div style={{ flex: 1 }} />
          <X size={16} color="var(--text-faint)" style={{ cursor: "pointer" }} onClick={props.onClose} />
        </div>
        <div style={{ "font-size": "12.5px", color: "var(--text-faint)", "line-height": "1.5" }}>
          Describe the reader this book is for. The agent reviews every scene against your brief
          and marks where that reader would stumble.
        </div>

        <label style={label}>Target audience</label>
        <input style={input} placeholder="e.g. adult literary-fantasy readers; patient with slow burns" value={brief().audience} onInput={(e) => set({ audience: e.currentTarget.value })} />

        <label style={label}>Tone</label>
        <input style={input} placeholder="e.g. melancholy, dry humour underneath, dread that accumulates" value={brief().tone} onInput={(e) => set({ tone: e.currentTarget.value })} />

        <label style={label}>Similar authors</label>
        <input style={input} placeholder="e.g. Susanna Clarke, China Miéville, Shirley Jackson" value={brief().similarAuthors} onInput={(e) => set({ similarAuthors: e.currentTarget.value })} />

        <label style={label}>Style</label>
        <input style={input} placeholder="e.g. close third, short scenes, no ornament for its own sake" value={brief().style} onInput={(e) => set({ style: e.currentTarget.value })} />

        <label style={label}>Notes</label>
        <textarea style={{ ...input, "min-height": "70px", resize: "vertical" }} placeholder="Anything else the reviewer should hold in mind" value={brief().notes} onInput={(e) => set({ notes: e.currentTarget.value })} />

        <div style={{ display: "flex", "justify-content": "flex-end", gap: "10px", "margin-top": "20px" }}>
          <button onClick={props.onClose} style={{ padding: "8px 16px", background: "transparent", border: "1px solid var(--border-color)", color: "var(--text-muted)", "border-radius": "6px", cursor: "pointer", "font-size": "13px" }}>
            Cancel
          </button>
          <button onClick={run} style={{ padding: "8px 18px", background: "var(--accent)", border: "none", color: "#fff", "border-radius": "6px", cursor: "pointer", "font-size": "13px" }}>
            Review the book
          </button>
        </div>
      </div>
    </div>
  );
};
