import { createStore, produce } from "solid-js/store";
import { invoke, invalidate, onBackend } from "../lib/rpc";
import { notify, notifyError } from "./app";
import { replaceRange, sceneName } from "./documents";
import type { Diag } from "../components/editor/diagSquiggles";

// Prose findings per file: spelling, grammar and style from the language
// engine, plus the agent's continuity/critique findings. Squiggles in the
// editor and the Review queue both read from here.

export type { Diag };

const [diagMap, setDiagMap] = createStore<Record<string, Diag[]>>({});
export { diagMap };

export const diagsFor = (path: string | null): Diag[] => (path ? diagMap[path] ?? [] : []);
export const allDiags = (): Diag[] => Object.values(diagMap).flat();

export const SOURCE_LABEL: Record<Diag["source"], string> = {
  spelling: "Spelling",
  grammar: "Grammar",
  style: "Style",
  assistant: "Agent",
};

/** Stable identity for a finding (positions shift, so this is best-effort). */
export const diagKey = (d: Diag) => `${d.file}:${d.line}:${d.colStart}:${d.ruleId}:${d.findingId ?? ""}`;

export async function recheck(path?: string) {
  try {
    const res = await invoke("diag/check", path ? { path: path } : {});
    if (path) setDiagMap(path, res.files[path] ?? []);
    else setDiagMap(produce((m) => {
      for (const k of Object.keys(m)) delete m[k];
      Object.assign(m, res.files);
    }));
    invalidate("diags");
  } catch {
    // Language engine not ready yet; Review offers setup
  }
}

export async function fix(d: Diag, replacement: string) {
  const applied = replaceRange(d.file, d.line, d.colStart, d.colEnd, d.text, replacement);
  if (applied === false) {
    notify("The text changed since this was found — rechecking");
    return recheck(d.file);
  }
  if (applied === null) {
    try {
      await invoke("diag/fix", { path: d.file, line: d.line, colStart: d.colStart, colEnd: d.colEnd, text: d.text, replacement });
    } catch (err) {
      notifyError("Fix failed", err);
      return recheck(d.file);
    }
  }
  // Optimistic: drop the fixed finding and shift same-line neighbours.
  const delta = [...replacement].length - (d.colEnd - d.colStart);
  setDiagMap(d.file, (list) => (list ?? [])
    .filter((x) => !(x.line === d.line && x.colStart === d.colStart && x.ruleId === d.ruleId))
    .map((x) => (x.line === d.line && x.colStart >= d.colEnd ? { ...x, colStart: x.colStart + delta, colEnd: x.colEnd + delta } : x)));
  invalidate("diags");
}

export async function addWord(d: Diag) {
  await invoke("diag/add_word", { word: d.text });
  notify(`“${d.text}” added to the project dictionary`, "success");
  return recheck();
}

/** Ignore this occurrence (in this scene), or the whole rule everywhere. */
export async function ignore(d: Diag, everywhere: boolean) {
  await invoke("diag/ignore", { ruleId: d.ruleId, file: everywhere ? "*" : d.file, text: everywhere ? "" : d.text });
  notify(everywhere ? "Rule turned off" : `Ignoring “${d.text}” in ${sceneName(d.file)}`);
  return everywhere ? recheck() : recheck(d.file);
}

export async function dismiss(d: Diag) {
  if (d.findingId === undefined) return;
  try {
    await invoke("agents/finding_dismiss", { id: d.findingId });
    setDiagMap(d.file, (list) => (list ?? []).filter((x) => x.findingId !== d.findingId));
    invalidate("diags");
  } catch (err) {
    notifyError("Dismiss failed", err);
  }
}

/** Drop findings for files that no longer exist. */
export function prune(livePaths: Set<string>) {
  setDiagMap(produce((m) => { for (const k of Object.keys(m)) if (!livePaths.has(k)) delete m[k]; }));
}

export function resetDiagnostics() {
  setDiagMap(produce((m) => { for (const k of Object.keys(m)) delete m[k]; }));
}

export function wireDiagnostics() {
  onBackend("diag/updated", (p: { files?: Record<string, Diag[]> }) => {
    for (const [file, diags] of Object.entries(p.files ?? {})) setDiagMap(file, diags);
    invalidate("diags");
  });
  onBackend("agents/finding", (p) => { if (p.file) void recheck(p.file); });
  // The language engine loads in the background; check everything once it's up.
  onBackend("diag/ready", () => void recheck());
}
