import { type Component, createSignal, For, Show } from "solid-js";
import { RefreshCw } from "lucide-solid";
import { Button, Modal } from "../ui";
import { invoke } from "../../lib/rpc";
import type { CatchUp as CatchUpData } from "../../rpc.gen";
import { notify } from "../../stores/app";
import { openScene, scene, sceneName } from "../../stores/documents";
import { flushSession } from "../../stores/session";
import { threadColor, threads } from "../../stores/story";
import { setMode } from "../../stores/workbench";
import { openSettings } from "../settings/SettingsSheet";
import "./CatchUp.css";

// "Catch me up": for coming back after a break — the story so far (the
// only part the model writes, from the scenes up to here), where the text
// stops, and the threads, notes and dates around it. Read-only.

const [target, setTarget] = createSignal<string | null>(null);

/** Brief the writer on `path` (default: the current scene). */
export const openCatchUp = (path?: string) => {
  const p = path ?? scene();
  if (!p) {
    notify("Open a scene first");
    return;
  }
  setTarget(p);
};

const fmt = (n: number) => n.toLocaleString("en-US");

const ago = (ms: number) => {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** "2026-09-25" (the writer's local date) → "Thu 25 Sep", or today/yesterday. */
const day = (date: string) => {
  const today = new Date();
  const iso = (d: Date) => d.toLocaleDateString("sv-SE");
  if (date === iso(today)) return "today";
  today.setDate(today.getDate() - 1);
  if (date === iso(today)) return "yesterday";
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

const CatchUpBody: Component<{ path: string; onClose: () => void }> = (props) => {
  const [data, setData] = createSignal<CatchUpData | null>(null);
  const [writing, setWriting] = createSignal(false);
  const [error, setError] = createSignal("");
  let token = 0;

  const load = async (refresh = false) => {
    const mine = ++token;
    setError("");
    try {
      if (!refresh) {
        flushSession(); // unsaved typing reaches the journal, which the brief reads
        const facts = await invoke("agents/catch_up", { path: props.path, summary: false });
        if (mine !== token) return;
        setData(facts);
        if (facts.summary !== "pending") return;
      }
      setWriting(true);
      const full = await invoke("agents/catch_up", { path: props.path, refresh });
      if (mine === token) setData(full);
    } catch (err) {
      if (mine === token) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === token) setWriting(false);
    }
  };
  void load();

  const go = (path: string, line?: number) => {
    props.onClose();
    setMode("write");
    void openScene(path, line ? { line, focus: true } : undefined);
  };
  const threadIndex = (id: number) => (threads.latest ?? []).findIndex((t) => t.id === id);
  const d = () => data()!;
  const progress = () => {
    const l = d().leftOff;
    return l.target > 0 ? `${fmt(l.words)} of ${fmt(l.target)} words` : `${fmt(l.words)} words`;
  };
  const details = () => {
    const l = d().leftOff;
    return [l.pov && `point of view: ${l.pov}`, l.location && `at ${l.location}`, l.storyTime].filter(Boolean).join(" · ");
  };

  return (
    <Modal
      title="Catch me up"
      onClose={props.onClose}
      footer={
        <>
          <Show when={data() && data()!.summary !== "no_ai"}>
            <Button variant="ghost" disabled={writing()} onClick={() => void load(true)} title="Write the story so far again">
              <RefreshCw size={13} /> Refresh
            </Button>
          </Show>
          <Button variant="primary" onClick={props.onClose}>Close</Button>
        </>
      }
    >
      <Show when={data()} fallback={<p class="hint">{error() || "Gathering where you are…"}</p>}>
        <div class="catchup selectable">
          <p class="catchup-where">
            <strong>{sceneName(props.path)}</strong>
            <span class="hint">
              {d().chapter ? `${d().chapter} · ` : ""}scene {d().position} of {d().total}
            </span>
          </p>

          <section>
            <h3 class="catchup-heading">The story so far</h3>
            <Show when={d().summary === "ready"}>
              <div class="catchup-story">
                <For each={d().storySoFar.split(/\n\s*\n/).filter((p) => p.trim())}>{(p) => <p>{p}</p>}</For>
              </div>
            </Show>
            <Show when={writing()}>
              <p class="hint">Reading back over the book so far…</p>
            </Show>
            <Show when={!writing() && !error() && d().summary === "pending"}>
              <p class="hint">
                Not written yet. <button type="button" class="link-button" onClick={() => void load(true)}>Write it</button>
              </p>
            </Show>
            <Show when={d().summary === "no_ai"}>
              <p class="hint">
                A summary of the story so far needs AI set up.{" "}
                <button type="button" class="link-button" onClick={() => { props.onClose(); openSettings("ai"); }}>Settings → AI</button>
              </p>
            </Show>
            <Show when={!writing() && (d().summary === "failed" || error())}>
              <p class="hint catchup-error">Couldn't write the summary: {d().summaryError || error()}</p>
            </Show>
            <Show when={d().missingSynopses > 0 && d().summary !== "no_ai"}>
              <p class="hint">
                {d().missingSynopses} earlier scene{d().missingSynopses === 1 ? " has" : "s have"} no synopsis, so the
                summary skips over {d().missingSynopses === 1 ? "it" : "them"}. Agent: Draft Missing Synopses fills them in.
              </p>
            </Show>
          </section>

          <section>
            <h3 class="catchup-heading">Where you left off</h3>
            <p class="catchup-facts">
              <Show when={d().leftOff.status}>
                <span class="catchup-status"><span class="status-dot" data-status={d().leftOff.status} />{d().leftOff.status}</span>
              </Show>
              <span>{progress()}</span>
              <Show when={details()}><span>{details()}</span></Show>
              <Show when={d().leftOff.unsaved}><span class="catchup-unsaved">unsaved changes</span></Show>
            </p>
            <Show
              when={d().leftOff.excerpt}
              fallback={<p class="hint">Nothing written in this scene yet.{d().leftOff.synopsis ? ` The plan: ${d().leftOff.synopsis}` : ""}</p>}
            >
              <button type="button" class="catchup-excerpt" title="Go to this point in the scene" onClick={() => go(d().file, d().leftOff.endLine)}>
                <For each={d().leftOff.excerpt.split("\n\n")}>{(p) => <p>{p}</p>}</For>
              </button>
            </Show>
          </section>

          <Show when={d().threads.length > 0}>
            <section>
              <h3 class="catchup-heading">Threads in this chapter</h3>
              <div class="chip-list">
                <For each={d().threads}>
                  {(t) => (
                    <button
                      type="button"
                      class="chip thread-chip on"
                      style={{ "--thread": threadColor({ ...t, position: 0 }, Math.max(0, threadIndex(t.id))) }}
                      title={t.lastSeen ? `Last seen in ${sceneName(t.lastSeen)}` : `Comes in with ${sceneName(t.scenes[0])}`}
                      onClick={() => go(t.lastSeen ?? t.scenes[0])}
                    >
                      <span class="thread-dot" />
                      {t.name}
                      <small>{t.lastSeen ? sceneName(t.lastSeen) : "later"}</small>
                    </button>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Show when={d().notes.length > 0}>
            <section>
              <h3 class="catchup-heading">Margin notes in this chapter</h3>
              <For each={d().notes}>
                {(n) => (
                  <button type="button" class="list-row catchup-note" onClick={() => go(n.file, n.line)}>
                    <span class="catchup-note-text">{n.text}</span>
                    <span class="row-meta">{sceneName(n.file)}</span>
                  </button>
                )}
              </For>
            </section>
          </Show>

          <section>
            <h3 class="catchup-heading">When you last worked</h3>
            <ul class="catchup-when">
              <Show when={d().lastWorked.sceneAt}>
                <li>This scene: changed {ago(d().lastWorked.sceneAt!)}</li>
              </Show>
              <Show when={d().lastWorked.latestScene && d().lastWorked.latestScene !== d().file}>
                <li>
                  Most recently:{" "}
                  <button type="button" class="link-button" onClick={() => go(d().lastWorked.latestScene!)}>{sceneName(d().lastWorked.latestScene!)}</button>
                  , {ago(d().lastWorked.latestAt!)}
                </li>
              </Show>
              <Show when={d().lastWorked.lastDay}>
                <li>
                  Last writing day: {day(d().lastWorked.lastDay!)} ({d().lastWorked.lastDayWords >= 0 ? "+" : ""}
                  {fmt(d().lastWorked.lastDayWords)} words)
                </li>
              </Show>
            </ul>
          </section>
        </div>
      </Show>
    </Modal>
  );
};

export const CatchUp: Component = () => (
  <Show when={target()} keyed>
    {(path) => <CatchUpBody path={path} onClose={() => setTarget(null)} />}
  </Show>
);
