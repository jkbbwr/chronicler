import { createSignal } from "solid-js";
import { invalidate, invoke } from "./rpc";
import { notify, notifyError, setOverlays, withProgress } from "../stores/app";
import { recheck } from "../stores/diagnostics";
import { sceneName, scene, viewFor } from "../stores/documents";
import { setWorkbench, showInspector } from "../stores/workbench";
import { seedComposer } from "../components/sidebar/AgentView";
import type { CritiqueBrief } from "../components/CritiqueModal";
import type { Estimate, EstimateJob } from "../rpc.gen";

// Everything the agent does on request. The agent reads; it never edits
// the manuscript.

export const [sweeping, setSweeping] = createSignal(false);

const fmtWords = (n: number) => n.toLocaleString();

/**
 * Before a job that reads the whole book: say how much it reads and what it
 * roughly costs, and let the writer decide. Resolves false on cancel.
 */
async function confirmRun(job: EstimateJob, action: string): Promise<boolean> {
  let est: Estimate;
  try {
    est = await invoke("agents/estimate", { job });
  } catch {
    return true; // can't estimate (e.g. provider unreachable): let the job itself report
  }
  if (est.scenes === 0) return true;
  const cost = est.cost === undefined
    ? "Your provider doesn't publish prices for this model."
    : est.cost < 0.01 ? "Estimated cost: under a cent." : `Estimated cost: about $${est.cost.toFixed(2)}.`;
  const r = await window.chronicler.showMessageBox({
    type: "question",
    buttons: [action, "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `${action}?`,
    detail: `This reads ${fmtWords(est.words)} words across ${est.scenes} scene${est.scenes === 1 ? "" : "s"} with ${est.model}. ${cost}`,
  });
  return r.response === 0;
}

/** A continuity check of one scene or the whole book. Calling again while running stops it. */
export async function runContinuity(path?: string) {
  if (sweeping()) {
    await invoke("agents/stop", { id: "continuity" }).catch(() => {});
    return;
  }
  if (!path && !(await confirmRun("continuity", "Check continuity across the book"))) return;
  setSweeping(true);
  notify(path ? `Checking continuity in ${sceneName(path)}…` : "Checking continuity across the book…", "progress");
  try {
    const res = await invoke("agents/continuity", path ? { path } : {});
    notify(res.stopped ? `Stopped. ${res.summary}` : res.summary, res.failed > 0 ? "error" : res.findings > 0 ? "info" : "success");
  } catch (err) {
    notifyError("Continuity check failed", err);
  } finally {
    setSweeping(false);
    void recheck();
  }
}

export async function runCritique(brief: CritiqueBrief) {
  setOverlays("critique", false);
  if (!(await confirmRun("critique", "Start the reading critique"))) return;
  const res = await withProgress("The agent is reading the book against your brief…", () =>
    invoke("agents/critique", { brief }));
  void recheck();
  if (!res) return;
  invalidate("critique");
  setWorkbench({ mode: "review", reviewSection: "critique" });
  notify(`Reading critique done: ${res.problems} stumbling block(s) marked`, "success");
}

export async function updateLedger() {
  if (!(await confirmRun("ledger", "Update the fact ledger"))) return;
  const res = await withProgress("Updating the fact ledger…", () =>
    invoke("agents/ledger", {}));
  if (res) {
    invalidate("timeline", "graph");
    const failed = res.failed > 0 ? ` ${res.failed} scene(s) failed — try again later.` : "";
    notify(`Fact ledger: read ${res.scenes} changed scene(s); ${res.facts} facts on file.${failed}`, res.failed > 0 ? "error" : "success");
  }
}

export async function draftSynopses() {
  if (!(await confirmRun("synopses", "Draft the missing synopses"))) return;
  const res = await withProgress("Drafting synopses for scenes without one…", () =>
    invoke("agents/synopses", {}));
  if (res) {
    invalidate("meta");
    notify(`Drafted ${res.drafted} synopsis(es)`, "success");
  }
}

export async function auditCodex() {
  const res = await withProgress("Checking the codex against the manuscript…", () =>
    invoke("agents/hygiene", {}));
  if (res) {
    invalidate("codex");
    notify(`Codex check: ${res.suggestions} suggestion(s) in Discovered`, "success");
  }
}

export async function readManuscript() {
  const res = await withProgress("The agent is reading the manuscript…", () =>
    invoke("agents/index"));
  if (res) notify(`The agent has read ${res.files} scene(s)`, "success");
}

export async function voiceReport(id: number, name: string): Promise<string | undefined> {
  const res = await withProgress(`Listening to ${name}'s voice…`, () => invoke("agents/voice", { id }));
  return res?.markdown;
}

/** Quote the selection into the agent's composer. */
export function askAboutSelection() {
  const view = viewFor(scene());
  const sel = view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).trim() : "";
  if (!sel) {
    notify("Select some prose first");
    return;
  }
  showInspector("agent");
  seedComposer(`${sel.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
}
