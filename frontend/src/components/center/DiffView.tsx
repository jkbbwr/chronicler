import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { ChevronDown, ChevronRight, FileText, RotateCcw } from "lucide-solid";
import { workbench } from "../../stores/workbench";
import "./DiffView.css";

type SegmentTag = "equal" | "insert" | "delete";

interface Paragraph {
  /** `modify` paragraphs mix equal, inserted and deleted segments. */
  tag: SegmentTag | "modify";
  segments: [SegmentTag, string][];
}

interface FileDiff {
  status: "added" | "removed" | "modified" | "renamed" | "copied";
  path: string;
  oldPath: string;
  binary: boolean;
  wordsAdded: number;
  wordsRemoved: number;
  paragraphs: Paragraph[];
}

export interface DiffSpec {
  /** Older side: a commit id, change id, or `@`. */
  from: string;
  /** Newer side. */
  to: string;
  fromLabel: string;
  toLabel: string;
  relPath?: string;
}

interface DiffViewProps extends DiffSpec {
  onOpenFile: (path: string) => void;
  onStatus: (message: string) => void;
}

/** Unchanged paragraphs shown around each change before collapsing. */
const CONTEXT = 1;

type Row =
  | { kind: "para"; para: Paragraph }
  | { kind: "gap"; key: string; hidden: Paragraph[] };

/** Collapse long unchanged stretches, keeping CONTEXT paragraphs next to changes. */
const layoutRows = (file: FileDiff, expanded: Set<string>): Row[] => {
  const rows: Row[] = [];
  const paras = file.paragraphs;
  let i = 0;
  while (i < paras.length) {
    if (paras[i].tag !== "equal") {
      rows.push({ kind: "para", para: paras[i++] });
      continue;
    }
    let j = i;
    while (j < paras.length && paras[j].tag === "equal") j++;
    const run = paras.slice(i, j);
    const lead = i === 0 ? 0 : CONTEXT; // context after the previous change
    const tail = j === paras.length ? 0 : CONTEXT; // context before the next change
    const key = `${file.path}:${i}`;
    if (run.length > lead + tail + 1 && !expanded.has(key)) {
      run.slice(0, lead).forEach(para => rows.push({ kind: "para", para }));
      rows.push({ kind: "gap", key, hidden: run.slice(lead, run.length - tail) });
      run.slice(run.length - tail).forEach(para => rows.push({ kind: "para", para }));
    } else {
      run.forEach(para => rows.push({ kind: "para", para }));
    }
    i = j;
  }
  return rows;
};

const STATUS_LABEL: Record<FileDiff["status"], string> = {
  added: "New",
  removed: "Deleted",
  modified: "Edited",
  renamed: "Moved",
  copied: "Copied",
};

const sceneName = (path: string) => path.replace(/\.md$/, "");

export const DiffView: Component<DiffViewProps> = (props) => {
  const [diff] = createResource(
    () => ({ from: props.from, to: props.to, path: props.relPath }),
    async (params) => (await window.chronicler.invoke("history/diff", params)).files as FileDiff[],
  );
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [collapsedFiles, setCollapsedFiles] = createSignal(new Set<string>());

  const toggle = (set: () => Set<string>, write: (s: Set<string>) => void, key: string) => {
    const next = new Set(set());
    if (next.has(key)) next.delete(key); else next.add(key);
    write(next);
  };

  const totals = () => (diff() ?? []).reduce(
    (acc, f) => ({ added: acc.added + f.wordsAdded, removed: acc.removed + f.wordsRemoved }),
    { added: 0, removed: 0 },
  );

  const restoreFile = async (file: FileDiff) => {
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Restore", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Put “${sceneName(file.oldPath)}” back as it was in ${props.fromLabel}?`,
      detail: "The restored text becomes part of your working draft. What it replaces stays in history.",
    });
    if (r.response !== 0) return;
    try {
      await window.chronicler.invoke("history/restore", { rev: props.from, path: file.oldPath });
      props.onStatus(`Restored ${file.oldPath}`);
    } catch (err: any) {
      props.onStatus(`Restore failed: ${err.message}`);
    }
  };

  return (
    <div class="diff-view">
      <div class="diff-page" style={{ "font-family": workbench.settings.fontFamily }}>
        <header class="diff-header">
          <div class="diff-range">
            <span>{props.fromLabel}</span>
            <span class="diff-arrow">→</span>
            <span>{props.toLabel}</span>
          </div>
          <Show when={diff()}>
            <div class="diff-summary">
              {diff()!.length} {diff()!.length === 1 ? "file" : "files"}
              <span class="diff-count-add">+{totals().added.toLocaleString()} words</span>
              <span class="diff-count-del">−{totals().removed.toLocaleString()} words</span>
            </div>
          </Show>
        </header>

        <Show when={diff.error}>
          <div class="diff-empty">Couldn't compare these versions: {String(diff.error?.message ?? diff.error)}</div>
        </Show>
        <Show when={diff() && diff()!.length === 0}>
          <div class="diff-empty">No differences.</div>
        </Show>

        <For each={diff() ?? []}>
          {(file) => {
            const open = () => !collapsedFiles().has(file.path);
            return (
              <section class="diff-file">
                <div class="diff-file-header">
                  <button class="diff-icon-btn" onClick={() => toggle(collapsedFiles, setCollapsedFiles, file.path)}>
                    {open() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <span class={`diff-badge diff-badge-${file.status}`}>{STATUS_LABEL[file.status]}</span>
                  <span class="diff-file-name">
                    <Show when={file.status === "renamed"}>
                      <span class="diff-old-name">{sceneName(file.oldPath)}</span> →{" "}
                    </Show>
                    {sceneName(file.path)}
                  </span>
                  <span class="diff-count-add">+{file.wordsAdded}</span>
                  <span class="diff-count-del">−{file.wordsRemoved}</span>
                  <Show when={file.status !== "removed"}>
                    <button class="diff-icon-btn" title="Open this scene" onClick={() => props.onOpenFile(file.path)}>
                      <FileText size={13} />
                    </button>
                  </Show>
                  <Show when={file.status !== "added"}>
                    <button class="diff-icon-btn" title={`Restore as it was in ${props.fromLabel}`} onClick={() => restoreFile(file)}>
                      <RotateCcw size={13} />
                    </button>
                  </Show>
                </div>
                <Show when={open()}>
                  <Show when={!file.binary} fallback={<div class="diff-empty">Not a text file.</div>}>
                    <div class="diff-body">
                      <For each={layoutRows(file, expanded())}>
                        {(row) =>
                          row.kind === "gap" ? (
                            <button class="diff-gap" onClick={() => toggle(expanded, setExpanded, row.key)}>
                              ⋯ {row.hidden.length} unchanged {row.hidden.length === 1 ? "paragraph" : "paragraphs"}
                            </button>
                          ) : (
                            <p class={`diff-para diff-para-${row.para.tag}`}>
                              <For each={row.para.segments}>
                                {([tag, text]) =>
                                  tag === "insert" ? <ins>{text}</ins> : tag === "delete" ? <del>{text}</del> : <>{text}</>
                                }
                              </For>
                            </p>
                          )
                        }
                      </For>
                    </div>
                  </Show>
                </Show>
              </section>
            );
          }}
        </For>
      </div>
    </div>
  );
};
