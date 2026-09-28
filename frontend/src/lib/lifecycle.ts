import { invalidate, invoke, onBackend, startEventBus, wireTopics } from "./rpc";
import { loadProject, notify, project, projectName, resetProject, setOverlays } from "../stores/app";
import { flush, reconcileExternal, resetDocuments } from "../stores/documents";
import { prune, recheck, resetDiagnostics, wireDiagnostics } from "../stores/diagnostics";
import { fetchStats, fetchStatsSoon, loadTargets, resetStats } from "../stores/stats";
import { flushSession, resetJournal, restoreSession } from "../stores/session";
import { setWorkbench } from "../stores/workbench";
import { setCodexSelection } from "../stores/codex";

// Opening, switching and closing projects, and the backend pushes that keep
// open state honest.

export async function initProject() {
  try {
    if (!(await loadProject())) {
      notify("No project open");
      return;
    }
    if (project.root) await restoreSession(project.root);
    notify(`Opened ${projectName()}`, "success");
    invalidate("files", "codex", "meta", "history", "stats");
    void recheck();
    void loadTargets(project.meta?.targets);
    void fetchStats();
  } catch (err) {
    notify(`Couldn't connect to the backend: ${err instanceof Error ? err.message : err}`, "error");
  }
}

/** Tear down the current project's state (its session is flushed first). */
function teardown() {
  flushSession(); // while project.root still names the project being left
  resetJournal();
  resetProject();
  resetDocuments();
  resetDiagnostics();
  resetStats();
  setCodexSelection(null);
  setWorkbench({ zenMode: false });
  setOverlays({ newProject: false });
}

export async function closeProject() {
  await flush();
  flushSession();
  await window.chronicler.closeProject();
}

async function handleFilesChanged(paths: string[]) {
  await reconcileExternal(paths);
  fetchStatsSoon();
  // Deleted files never get a diag/updated push; drop their findings.
  try {
    const res = await invoke("project/list_files");
    prune(new Set(res.files.map((f) => f.path)));
  } catch {
    // backend restarting
  }
}

export function startLifecycle() {
  startEventBus();
  wireTopics();
  wireDiagnostics();
  onBackend("project/changed", (p: { paths?: string[] }) => void handleFilesChanged(p.paths ?? []));
  onBackend("codex/changed", (p: { newCandidates?: number }) => {
    const n = p.newCandidates ?? 0;
    if (n > 0) notify(`${n} new name${n === 1 ? "" : "s"} discovered — see Codex`);
  });
  onBackend("system/recompiling", () => notify("Backend restarting…", "progress"));
  onBackend("agents/sweep", (p: { note?: string }) => notify(`Agent: ${p.note ?? "working"}`, "progress"));

  window.chronicler.onMenuAction((action: string) => {
    if (action === "project-opened" || action === "project-closed") {
      teardown();
      notify(action === "project-opened" ? "Opening project…" : "No project open", "progress");
      void initProject();
    }
  });

  window.addEventListener("beforeunload", () => { void flush(); });
  void initProject();
}
