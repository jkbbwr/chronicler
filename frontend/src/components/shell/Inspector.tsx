import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { X } from "lucide-solid";
import { IconButton, Resizer, Tabs, Button } from "../ui";
import { setMode, setWorkbench, workbench } from "../../stores/workbench";
import { chapterOf, countWords, docs, openScene, requestReveal, scene, sceneName } from "../../stores/documents";
import { diagsFor, SOURCE_LABEL } from "../../stores/diagnostics";
import { entities, entityRefs, openEntity } from "../../stores/codex";
import { entitiesIn } from "../editor/entityLinks";
import { createQuery, invoke } from "../../lib/rpc";
import { createThread, detailsFor, setDetails, threadColor, threads, toggleThread } from "../../stores/story";
import { notify, notifyError } from "../../stores/app";
import { openSettings } from "../settings/SettingsSheet";
import { AgentView } from "../sidebar/AgentView";
import { runContinuity, sweeping } from "../../lib/agentActions";
import type { Diag } from "../editor/diagSquiggles";

// The contextual inspector: what you need to know about the scene you're in,
// and the agent, one keystroke away in every mode.

const STATUSES = [
  { id: "idea", label: "Idea" },
  { id: "draft", label: "Draft" },
  { id: "revised", label: "Revised" },
  { id: "final", label: "Final" },
];

/** Plain wording for how long a scene reads at novel pace. */
const readingMinutes = (words: number) => Math.max(1, Math.round(words / 250));

/** Headings and margin notes, with 1-based lines. */
function landmarks(text: string) {
  const headings: { line: number; level: number; text: string }[] = [];
  const notes: { line: number; text: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) headings.push({ line: i + 1, level: h[1].length, text: h[2].trim() });
  });
  for (const m of text.matchAll(/<!--([\s\S]*?)(?:-->|$)/g)) {
    const line = text.slice(0, m.index).split("\n").length;
    const body = m[1].trim();
    if (body) notes.push({ line, text: body });
  }
  return { headings, notes };
}

/** Point of view, location, story time and word target. */
const DetailsSection: Component<{ path: string; words: number }> = (props) => {
  const d = () => detailsFor(props.path);
  const characters = () => (entities.latest ?? []).filter((e) => e.kind === "character");
  const places = () => (entities.latest ?? []).filter((e) => e.kind === "place");
  const [storyTime, setStoryTime] = createSignal("");
  createEffect(on([() => props.path, () => d().storyTime], () => setStoryTime(d().storyTime)));
  const progress = () => (d().target > 0 ? Math.min(1, props.words / d().target) : 0);
  return (
    <section class="inspector-section">
      <h4>Details</h4>
      <div class="detail-grid">
        <label for="d-pov">Point of view</label>
        <select id="d-pov" class="input" value={d().pov ?? 0} onChange={(e) => void setDetails(props.path, { pov: +e.currentTarget.value })}>
          <option value={0}>—</option>
          <For each={characters()}>{(c) => <option value={c.id}>{c.name}</option>}</For>
        </select>
        <label for="d-loc">Location</label>
        <select id="d-loc" class="input" value={d().location ?? 0} onChange={(e) => void setDetails(props.path, { location: +e.currentTarget.value })}>
          <option value={0}>—</option>
          <For each={places()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
        </select>
        <label for="d-time">Story time</label>
        <input
          id="d-time"
          class="input"
          placeholder="e.g. Day 3, dusk"
          value={storyTime()}
          onInput={(e) => setStoryTime(e.currentTarget.value)}
          onChange={(e) => void setDetails(props.path, { storyTime: e.currentTarget.value })}
        />
        <label for="d-target">Word target</label>
        <input
          id="d-target"
          class="input"
          type="number"
          min="0"
          step="100"
          placeholder="none"
          value={d().target || ""}
          onChange={(e) => void setDetails(props.path, { target: Math.max(0, Math.round(+e.currentTarget.value || 0)) })}
        />
      </div>
      <Show when={d().target > 0}>
        <div class="target-bar" title={`${props.words.toLocaleString()} of ${d().target.toLocaleString()} words`}>
          <div class="target-fill" classList={{ met: progress() >= 1 }} style={{ width: `${progress() * 100}%` }} />
        </div>
        <div class="hint">{props.words.toLocaleString()} / {d().target.toLocaleString()} words</div>
      </Show>
    </section>
  );
};

/** Plot threads this scene carries, as toggles. */
const ThreadsSection: Component<{ path: string }> = (props) => {
  const [adding, setAdding] = createSignal(false);
  const on_ = (id: number) => detailsFor(props.path).threads.includes(id);
  const add = async (name: string) => {
    setAdding(false);
    if (!name.trim()) return;
    const id = await createThread(name.trim());
    if (id !== undefined) void toggleThread(props.path, id);
  };
  return (
    <section class="inspector-section">
      <h4>Plot threads</h4>
      <div class="chip-list">
        <For each={threads.latest ?? []}>
          {(t, i) => (
            <button
              type="button"
              class="chip thread-chip"
              classList={{ on: on_(t.id) }}
              style={{ "--thread": threadColor(t, i()) }}
              onClick={() => void toggleThread(props.path, t.id)}
              title={on_(t.id) ? "Carried by this scene — click to remove" : "Click if this scene carries it"}
            >
              <span class="thread-dot" />
              {t.name}
            </button>
          )}
        </For>
        <Show
          when={adding()}
          fallback={<button type="button" class="chip" onClick={() => setAdding(true)}>+ Thread</button>}
        >
          <input
            class="input thread-input"
            placeholder="Thread name"
            ref={(el) => queueMicrotask(() => el.focus())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add(e.currentTarget.value);
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={(e) => void add(e.currentTarget.value)}
          />
        </Show>
      </div>
    </section>
  );
};

/** What the reader has been told, by this point, about who's in the scene. */
const ReaderSection: Component<{ path: string }> = (props) => {
  const knowledge = createQuery(["codex", "files", "meta"], async (path: string) => {
    try {
      return await invoke("story/reader_knowledge", { path });
    } catch {
      return null;
    }
  }, () => props.path);
  const k = () => knowledge.latest;
  return (
    <section class="inspector-section">
      <h4>What the reader knows</h4>
      <Show when={k()} fallback={<div class="hint">…</div>}>
        <Show when={k()!.introduced.length > 0}>
          <div class="reader-intro">
            <span class="hint">First appearance here: </span>
            <For each={k()!.introduced}>
              {(e, i) => (
                <>
                  <button type="button" class="link-button" onClick={() => openEntity(e.id)}>{e.name}</button>
                  {i() < k()!.introduced.length - 1 ? ", " : ""}
                </>
              )}
            </For>
          </div>
        </Show>
        <For each={k()!.known}>
          {(e) => (
            <details class="reader-entity">
              <summary>
                <span class="reader-name">{e.name}</span>
                <span class="row-meta">{e.facts.length ? `${e.facts.length} thing${e.facts.length === 1 ? "" : "s"}` : "nothing noted"}</span>
              </summary>
              <For each={e.facts}>
                {(f) => (
                  <div class="reader-fact" title={`From ${sceneName(f.scene)}`}>
                    {f.fact}
                    <Show when={f.basis === "claimed"}><span class="hint"> (claimed)</span></Show>
                    <button type="button" class="reader-source" onClick={() => void openScene(f.scene)}>{sceneName(f.scene)}</button>
                  </div>
                )}
              </For>
            </details>
          )}
        </For>
        <Show when={k()!.introduced.length === 0 && k()!.known.length === 0}>
          <div class="hint">No codex names appear in this scene.</div>
        </Show>
        <Show when={k()!.unreadScenes > 0}>
          <div class="hint reader-gap">
            {k()!.unreadScenes} earlier scene{k()!.unreadScenes === 1 ? " hasn't" : "s haven't"} been noted yet, so this may be incomplete.
          </div>
        </Show>
      </Show>
    </section>
  );
};

const SceneTab: Component<{ path: string }> = (props) => {
  const text = () => docs[props.path]?.content ?? "";
  const words = () => countWords(text());
  const meta = () => detailsFor(props.path);
  const marks = createMemo(() => landmarks(text()));
  const cast = createMemo(() => entitiesIn(text(), entityRefs()).slice(0, 24));
  const findings = () => {
    const by = new Map<Diag["source"], number>();
    for (const d of diagsFor(props.path)) by.set(d.source, (by.get(d.source) ?? 0) + 1);
    return [...by.entries()];
  };

  const setStatus = async (status: string) => {
    try {
      await setDetails(props.path, { status: meta().status === status ? "" : status });
    } catch (err) {
      notifyError("Couldn't set the status", err);
    }
  };

  // Synopsis: local draft, saved after a pause and on blur.
  const [synopsis, setSynopsis] = createSignal("");
  let synopsisTimer: ReturnType<typeof setTimeout> | undefined;
  let editingSynopsis = false;
  createEffect(on([() => props.path, () => meta().synopsis], () => {
    if (!editingSynopsis) setSynopsis(meta().synopsis ?? "");
  }));
  const saveSynopsis = async (path: string, value: string) => {
    clearTimeout(synopsisTimer);
    try {
      await setDetails(path, { synopsis: value });
    } catch (err) {
      notifyError("Couldn't save the synopsis", err);
    }
  };

  return (
    <>
      <section class="inspector-section">
        <h3 class="inspector-title">{sceneName(props.path)}</h3>
        <Show when={chapterOf(props.path)}><div class="inspector-chapter">{chapterOf(props.path)}</div></Show>
        <div class="inspector-stats">
          <span><strong>{words().toLocaleString()}</strong> words</span>
          <span><strong>{readingMinutes(words())}</strong> min read</span>
        </div>
      </section>

      <section class="inspector-section">
        <h4>Status</h4>
        <div class="status-picker">
          <For each={STATUSES}>
            {(s) => (
              <button type="button" class={meta().status === s.id ? "active" : ""} onClick={() => setStatus(s.id)}>
                <span class="status-dot" data-status={s.id} />
                {s.label}
              </button>
            )}
          </For>
        </div>
      </section>

      <DetailsSection path={props.path} words={words()} />
      <ThreadsSection path={props.path} />

      <section class="inspector-section">
        <h4>Synopsis</h4>
        <textarea
          class="synopsis-input"
          placeholder="What happens here, in a line or two…"
          value={synopsis()}
          onFocus={() => (editingSynopsis = true)}
          onInput={(e) => {
            const path = props.path;
            const value = e.currentTarget.value;
            setSynopsis(value);
            clearTimeout(synopsisTimer);
            synopsisTimer = setTimeout(() => void saveSynopsis(path, value), 800);
          }}
          onBlur={() => {
            editingSynopsis = false;
            if (synopsis() !== (meta().synopsis ?? "")) void saveSynopsis(props.path, synopsis());
          }}
        />
      </section>

      <Show when={marks().headings.length > 0}>
        <section class="inspector-section">
          <h4>Outline</h4>
          <For each={marks().headings}>
            {(h) => (
              <div class="list-row" style={{ "padding-left": `${(h.level - 1) * 12 + 4}px` }} onClick={() => requestReveal(props.path, { line: h.line })}>
                {h.text}
              </div>
            )}
          </For>
        </section>
      </Show>

      <Show when={marks().notes.length > 0}>
        <section class="inspector-section">
          <h4>Margin notes</h4>
          <For each={marks().notes}>
            {(n) => (
              <div class="list-row" title={`Line ${n.line}`} onClick={() => requestReveal(props.path, { line: n.line })}>
                <span style={{ "font-style": "italic" }}>{n.text.length > 90 ? `${n.text.slice(0, 90)}…` : n.text}</span>
              </div>
            )}
          </For>
        </section>
      </Show>

      <ReaderSection path={props.path} />

      <section class="inspector-section">
        <h4>In this scene</h4>
        <Show when={cast().length > 0} fallback={<div class="hint">No codex names appear here yet.</div>}>
          <div class="chip-list">
            <For each={cast()}>
              {(c) => (
                <button type="button" class="chip" title={c.ref.summary || c.ref.kind} onClick={() => openEntity(c.ref.id)}>
                  {c.ref.name} <small>{c.count}</small>
                </button>
              )}
            </For>
          </div>
        </Show>
      </section>

      <section class="inspector-section">
        <h4>Findings</h4>
        <Show when={findings().length > 0} fallback={<div class="hint">Nothing flagged in this scene.</div>}>
          <For each={findings()}>
            {([source, n]) => (
              <div class="list-row" onClick={() => { setWorkbench({ reviewSection: "problems", reviewScope: "scene" }); setMode("review"); }}>
                {SOURCE_LABEL[source]}
                <span class="row-meta">{n}</span>
              </div>
            )}
          </For>
        </Show>
        <div style={{ display: "flex", gap: "8px", "margin-top": "10px" }}>
          <Button size="sm" onClick={() => void runContinuity(props.path)}>
            {sweeping() ? "Stop checking" : "Check continuity"}
          </Button>
        </div>
      </section>
    </>
  );
};

export const Inspector: Component = () => (
  <>
    <Resizer side="right" width={workbench.layout.inspectorWidth} min={260} max={560} onResize={(w) => setWorkbench("layout", "inspectorWidth", w)} />
    <aside class="side side-right" style={{ width: `${workbench.layout.inspectorWidth}px` }}>
      <div class="side-header">
        <Tabs
          value={workbench.layout.inspectorTab}
          options={[{ value: "scene", label: "Scene" }, { value: "agent", label: "Agent" }]}
          onChange={(t) => setWorkbench("layout", "inspectorTab", t)}
        />
        <IconButton label="Close inspector" size="sm" onClick={() => setWorkbench("layout", "inspectorOpen", false)}>
          <X size={14} />
        </IconButton>
      </div>
      <div class="side-body">
        <Show when={workbench.layout.inspectorTab === "scene"}>
          <Show when={scene()} fallback={<div class="empty">Open a scene to see its details.</div>}>
            <SceneTab path={scene()!} />
          </Show>
        </Show>
        <Show when={workbench.layout.inspectorTab === "agent"}>
          <AgentView
            activeScene={() => {
              const s = scene();
              return s && docs[s] ? { file: s, content: docs[s].content } : null;
            }}
            onStatus={notify}
            onOpenSettings={() => openSettings("ai")}
            onOpenScene={(file, line) => { setMode("write"); void openScene(file, line ? { line } : undefined); }}
          />
        </Show>
      </div>
    </aside>
  </>
);
