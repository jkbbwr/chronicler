import { type Component, createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { invoke } from "../../../lib/rpc";
import type { EditorView } from "@codemirror/view";
import { SceneEditor } from "../../editor/SceneEditor";
import { docs, requestReveal } from "../../../stores/documents";
import { addWord, diagKey, dismiss, fix, ignore, SOURCE_LABEL, type Diag } from "../../../stores/diagnostics";
import { Button } from "../../ui";

// The scene with its findings in the margin, each card level with the line
// it's about (pushed down when cards would overlap).

interface ReviewDocProps {
  path: string;
  findings: Diag[];
  active: string | null;
  onActivate: (key: string) => void;
}

const GAP = 8;

export const FindingCard: Component<{ d: Diag; active: boolean; onActivate: () => void; ref?: (el: HTMLDivElement) => void; top?: number }> = (props) => {
  // Spelling fixes are computed on demand (only for the card you're looking at).
  const [suggested] = createResource(
    () => (props.active && props.d.source === "spelling" && (props.d.replacements ?? []).length === 0 ? props.d.text : false),
    async (word) => {
      try {
        return (await invoke("diag/suggest", { word })).suggestions;
      } catch {
        return [];
      }
    },
  );
  const fixes = () => ((props.d.replacements ?? []).length > 0 ? props.d.replacements! : suggested() ?? []);
  return (
  <div
    ref={props.ref}
    class="finding-card"
    classList={{ active: props.active }}
    data-source={props.d.source}
    style={props.top !== undefined ? { top: `${props.top}px` } : undefined}
    onClick={props.onActivate}
  >
    <div class="finding-head">
      <span class="finding-source">{SOURCE_LABEL[props.d.source]}</span>
      <Show when={props.d.text}><q class="finding-quote">{props.d.text}</q></Show>
    </div>
    <div class="finding-message">{props.d.message}</div>
    <Show when={props.active}>
      <Show when={fixes().length > 0}>
        <div class="finding-fixes">
          <For each={fixes().slice(0, 4)}>
            {(r) => (
              <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); void fix(props.d, r); }}>
                {r || "(remove)"}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div class="finding-actions">
        <Show when={props.d.source === "spelling"}>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void addWord(props.d); }}>Add to dictionary</Button>
        </Show>
        <Show
          when={props.d.source === "assistant"}
          fallback={
            <>
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void ignore(props.d, false); }}>Ignore</Button>
              <Button size="sm" variant="ghost" title="Stop flagging this kind of issue anywhere" onClick={(e) => { e.stopPropagation(); void ignore(props.d, true); }}>Turn off rule</Button>
            </>
          }
        >
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void dismiss(props.d); }}>Dismiss</Button>
        </Show>
      </div>
    </Show>
  </div>
  );
};

export const ReviewDoc: Component<ReviewDocProps> = (props) => {
  let scroller!: HTMLDivElement;
  const [view, setView] = createSignal<EditorView | null>(null);
  const [tops, setTops] = createSignal<Record<string, number>>({});
  const cards = new Map<string, HTMLDivElement>();

  /** Desired card tops (line positions), then pushed down to avoid overlap. */
  const layout = () => {
    const v = view();
    if (!v || !scroller) return;
    const base = v.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const sorted = [...props.findings].sort((a, b) => a.line - b.line || a.colStart - b.colStart);
    const next: Record<string, number> = {};
    let floor = 0;
    for (const d of sorted) {
      const doc = v.state.doc;
      if (d.line < 1 || d.line > doc.lines) continue;
      const line = doc.line(d.line);
      const want = base + v.lineBlockAt(Math.min(line.from + d.colStart, line.to)).top;
      const top = Math.max(want, floor);
      const key = diagKey(d);
      next[key] = top;
      floor = top + (cards.get(key)?.offsetHeight ?? 64) + GAP;
    }
    setTops(next);
  };

  let frame = 0;
  const relayout = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      layout();
      // Second pass: heights are known once cards have rendered.
      frame = requestAnimationFrame(layout);
    });
  };

  createEffect(on([view, () => props.findings, () => props.active, () => docs[props.path]?.content], relayout));

  const observer = new ResizeObserver(relayout);
  createEffect(on(view, (v) => {
    observer.disconnect();
    if (v) {
      observer.observe(v.contentDOM);
      observer.observe(scroller);
    }
  }));
  onCleanup(() => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  });

  // Bring the active finding into view in the text.
  createEffect(on(() => props.active, (key) => {
    const d = props.findings.find((x) => diagKey(x) === key);
    if (d) requestReveal(d.file, { line: d.line, colStart: d.colStart, colEnd: d.colEnd, focus: false });
  }, { defer: true }));

  return (
    <div class="review-doc" ref={scroller}>
      <div class="review-sheet">
        <div class="review-text">
          <SceneEditor path={props.path} class="flow" onView={setView} />
        </div>
        <div class="review-margin">
          <For each={props.findings}>
            {(d) => (
              <FindingCard
                d={d}
                active={props.active === diagKey(d)}
                top={tops()[diagKey(d)] ?? 0}
                ref={(el) => cards.set(diagKey(d), el)}
                onActivate={() => props.onActivate(diagKey(d))}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
};
