import { type Component, createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { ArrowLeftRight, ChevronDown, ChevronRight, Lock, RotateCcw } from "lucide-solid";
import type { DiffSpec } from "../center/DiffView";
import { MissingTool } from "../shell/MissingTool";
import { tools } from "../../stores/tools";
import "./HistoryView.css";

interface Change {
  changeId: string;
  commitId: string;
  parentId: string;
  current: boolean; // the working draft
  empty: boolean;
  created: number; // unix seconds
  updated: number;
  files: string[];
  description: string;
}

interface Save {
  commitId: string;
  predecessorId: string;
  timestamp: number;
  files: string[];
}

interface HistoryViewProps {
  activeFile: string | null;
  /** Bumped whenever the backend records new history. */
  version: number;
  onStatus: (message: string) => void;
  onCompare: (spec: DiffSpec) => void;
}

const relativeTime = (unixSeconds: number): string => {
  const delta = Math.floor(Date.now() / 1000) - unixSeconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
};

const fullTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleString();
const clockTime = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const sceneList = (files: string[]) => {
  const names = files.map((f) => f.split("/").pop()!.replace(/\.md$/, ""));
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
};

export const HistoryView: Component<HistoryViewProps> = (props) => {
  const [onlyActive, setOnlyActive] = createSignal(false);
  const filterFile = () => (onlyActive() ? props.activeFile : null);

  // Wrapped in an object: a null source would stop the resource fetching at all.
  const [changes, { refetch }] = createResource(() => ({ file: filterFile() }), async ({ file }) => {
    const res = await window.chronicler.invoke("history/changes", file ? { path: file } : {});
    return res.changes as Change[];
  }, { initialValue: [] });
  createEffect(on(() => props.version, () => refetch(), { defer: true }));

  const draft = () => changes().find((c) => c.current);
  const past = () => changes().filter((c) => !c.current);

  const [lockName, setLockName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);

  const [saves, { refetch: refetchSaves }] = createResource(expanded, async (id) => {
    const res = await window.chronicler.invoke("history/evolog", { changeId: id });
    return res.entries as Save[];
  });
  createEffect(on(() => props.version, () => { if (expanded()) refetchSaves(); }, { defer: true }));

  const canLockIn = () => !busy() && !!lockName().trim() && !!draft() && !draft()!.empty;

  const lockIn = async () => {
    const name = lockName().trim();
    if (!canLockIn()) return;
    setBusy(true);
    try {
      const res = await window.chronicler.invoke("history/lock_in", { message: name });
      if (res.locked) {
        setLockName("");
        props.onStatus(`Locked in “${name}”`);
      } else {
        props.onStatus(res.reason ?? "Nothing to lock in");
      }
      refetch();
    } catch (err: any) {
      props.onStatus(`Lock in failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (change: Change, name: string) => {
    setRenaming(null);
    if (name.trim() === change.description) return;
    try {
      await window.chronicler.invoke("history/describe", { changeId: change.changeId, message: name.trim() });
      refetch();
    } catch (err: any) {
      props.onStatus(`Rename failed: ${err.message}`);
    }
  };

  const restore = async (rev: string, label: string) => {
    const file = props.activeFile;
    const buttons = file ? [`Restore “${file}”`, "Restore whole project", "Cancel"] : ["Restore whole project", "Cancel"];
    const cancel = buttons.length - 1;
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons,
      defaultId: cancel,
      cancelId: cancel,
      message: `Restore from ${label}?`,
      detail: "The restored text becomes part of your working draft. What it replaces stays in history, so you can restore it back.",
    });
    if (r.response === cancel) return;
    const relPath = file && r.response === 0 ? file : undefined;
    try {
      await window.chronicler.invoke("history/restore", relPath ? { rev, path: relPath } : { rev });
      props.onStatus(relPath ? `Restored ${relPath}` : "Restored project"); // file watcher reloads buffers
    } catch (err: any) {
      props.onStatus(`Restore failed: ${err.message}`);
    }
  };

  const labelOf = (c: Change) => c.description || (c.current ? "Working draft" : "Untitled");
  const quoted = (c: Change) => (c.current ? "working draft" : `“${labelOf(c)}”`);

  const showChange = (c: Change) => {
    const parent = changes().find((p) => p.commitId === c.parentId);
    props.onCompare({
      from: c.parentId,
      to: c.current ? "@" : c.commitId,
      fromLabel: parent ? `“${labelOf(parent)}”` : `Before ${quoted(c)}`,
      toLabel: c.current ? "Working draft" : `“${labelOf(c)}”`,
      relPath: filterFile() ?? undefined,
    });
  };

  const compareWithDraft = (c: Change) =>
    props.onCompare({
      from: c.commitId,
      to: "@",
      fromLabel: `“${labelOf(c)}”`,
      toLabel: "Working draft",
      relPath: filterFile() ?? undefined,
    });

  const showSave = (c: Change, s: Save) =>
    props.onCompare({
      from: s.predecessorId || c.parentId,
      to: s.commitId,
      fromLabel: "Previous save",
      toLabel: `Saved ${fullTime(s.timestamp)}`,
    });

  const Saves: Component<{ change: Change }> = (p) => (
    <div class="history-saves">
      <Show when={saves()} fallback={<div class="history-hint">Loading…</div>}>
        <Show when={saves()!.length > 0} fallback={<div class="history-hint">No saves yet.</div>}>
          <For each={saves()}>
            {(save) => (
              <div class="history-save" title={fullTime(save.timestamp)} onClick={() => showSave(p.change, save)}>
                <span class="history-save-time">{clockTime(save.timestamp)}</span>
                <span class="history-save-files">{sceneList(save.files)}</span>
                <button
                  class="history-icon-btn"
                  title="Restore from this save"
                  onClick={(e) => { e.stopPropagation(); restore(save.commitId, `the save at ${fullTime(save.timestamp)}`); }}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );

  const ChangeRow: Component<{ change: Change }> = (p) => {
    const isOpen = () => expanded() === p.change.changeId;
    return (
      <div class="history-change" classList={{ "history-change-current": p.change.current }}>
        <div class="history-change-row">
          <button
            class="history-icon-btn"
            title={isOpen() ? "Hide saves" : "Show every save"}
            onClick={() => setExpanded(isOpen() ? null : p.change.changeId)}
          >
            {isOpen() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div class="history-change-main" onClick={() => !p.change.empty && showChange(p.change)} title="Show what changed">
            <Show
              when={renaming() === p.change.changeId}
              fallback={
                <div
                  class="history-change-name"
                  classList={{ "history-untitled": !p.change.description }}
                  onDblClick={(e) => { e.stopPropagation(); setRenaming(p.change.changeId); }}
                  title="Double-click to rename"
                >
                  {labelOf(p.change)}
                </div>
              }
            >
              <input
                class="history-input"
                ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                value={p.change.description}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => rename(p.change, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            </Show>
            <div class="history-change-meta" title={`Started ${fullTime(p.change.created)}`}>
              {p.change.empty
                ? "No edits yet"
                : `${sceneList(p.change.files)} · ${relativeTime(p.change.updated)}`}
            </div>
          </div>
          <Show when={!p.change.current}>
            <button class="history-icon-btn" title="Compare with working draft" onClick={() => compareWithDraft(p.change)}>
              <ArrowLeftRight size={13} />
            </button>
            <button class="history-icon-btn" title="Restore from this version" onClick={() => restore(p.change.commitId, `“${labelOf(p.change)}”`)}>
              <RotateCcw size={13} />
            </button>
          </Show>
        </div>
        <Show when={isOpen()}>
          <Saves change={p.change} />
        </Show>
      </div>
    );
  };

  return (
    <Show when={tools.loading || tools() === null || tools()?.jj} fallback={<MissingTool tool="jj" />}>
    <div class="history-view">
      <div class="history-toolbar">
        <div class="history-lock">
          <input
            class="history-input"
            placeholder="Name this version…"
            value={lockName()}
            onInput={(e) => setLockName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") lockIn(); }}
            disabled={busy() || !draft() || draft()!.empty}
          />
          <button class="history-lock-btn" onClick={lockIn} disabled={!canLockIn()} title="Name your working draft and start a new one">
            <Lock size={12} /> Lock in
          </button>
        </div>
        <Show when={props.activeFile}>
          <label class="history-filter">
            <input type="checkbox" checked={onlyActive()} onChange={(e) => setOnlyActive(e.currentTarget.checked)} />
            Only versions that touched this scene
          </label>
        </Show>
      </div>

      <div class="history-list">
        <Show when={draft()}>{(d) => <ChangeRow change={d()} />}</Show>
        <For each={past()}>{(change) => <ChangeRow change={change} />}</For>
        <Show when={!changes.loading && past().length === 0}>
          <div class="history-hint history-empty">
            Every save is kept in your working draft. Lock it in with a name when you reach a version you're happy with.
          </div>
        </Show>
      </div>
    </div>
    </Show>
  );
};
