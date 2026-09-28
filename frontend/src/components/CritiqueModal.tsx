import { type Component, createSignal, onMount } from "solid-js";
import { Button, Modal } from "./ui";
import { project } from "../stores/app";
import "./CritiqueModal.css";

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

export const CritiqueModal: Component<CritiqueModalProps> = (props) => {
  const [brief, setBrief] = createSignal<CritiqueBrief>({
    audience: "", tone: "", similarAuthors: "", style: "", notes: "",
  });
  const set = (patch: Partial<CritiqueBrief>) => setBrief({ ...brief(), ...patch });

  onMount(async () => {
    // Start from "About this book"; a previous critique's brief wins where it set a field.
    const book = project.meta?.brief ?? {};
    const seeded: CritiqueBrief = {
      audience: book.audience ?? "",
      tone: book.tone ?? "",
      similarAuthors: book.comparables ?? "",
      style: [book.genre, book.narration].filter(Boolean).join("; "),
      notes: "",
    };
    let saved: Partial<CritiqueBrief> = {};
    try {
      const res = await window.chronicler.invoke("db/get", { key: "critiqueBrief" });
      if (res.value) saved = JSON.parse(res.value);
    } catch { /* fresh brief */ }
    const merged = { ...seeded };
    for (const [k, v] of Object.entries(saved)) if (typeof v === "string" && v.trim()) merged[k as keyof CritiqueBrief] = v;
    setBrief(merged);
  });

  const run = async () => {
    try {
      await window.chronicler.invoke("db/set", { key: "critiqueBrief", value: JSON.stringify(brief()) });
    } catch { /* still run */ }
    props.onRun(brief());
  };

  return (
    <Modal
      title="Reading critique"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={run}>Review the book</Button>
        </>
      }
    >
      <div class="critique-form">
        <p class="hint">
          Describe the reader this book is for. The agent reviews every scene against your brief
          and marks where that reader would stumble.
        </p>

        <div class="field">
          <label for="critique-audience">Target audience</label>
          <input id="critique-audience" class="input" placeholder="e.g. adult literary-fantasy readers; patient with slow burns" value={brief().audience} onInput={(e) => set({ audience: e.currentTarget.value })} />
        </div>

        <div class="field">
          <label for="critique-tone">Tone</label>
          <input id="critique-tone" class="input" placeholder="e.g. melancholy, dry humour underneath, dread that accumulates" value={brief().tone} onInput={(e) => set({ tone: e.currentTarget.value })} />
        </div>

        <div class="field">
          <label for="critique-authors">Similar authors</label>
          <input id="critique-authors" class="input" placeholder="e.g. Susanna Clarke, China Miéville, Shirley Jackson" value={brief().similarAuthors} onInput={(e) => set({ similarAuthors: e.currentTarget.value })} />
        </div>

        <div class="field">
          <label for="critique-style">Style</label>
          <input id="critique-style" class="input" placeholder="e.g. close third, short scenes, no ornament for its own sake" value={brief().style} onInput={(e) => set({ style: e.currentTarget.value })} />
        </div>

        <div class="field">
          <label for="critique-notes">Notes</label>
          <textarea id="critique-notes" class="input" placeholder="Anything else the reviewer should hold in mind" value={brief().notes} onInput={(e) => set({ notes: e.currentTarget.value })} />
        </div>
      </div>
    </Modal>
  );
};
