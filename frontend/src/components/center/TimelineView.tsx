import { type Component, createMemo, createResource, createSignal, For, Index, Show } from "solid-js";
import { Clock, CornerLeftDown, RefreshCw } from "lucide-solid";
import { buildTree, buildCompileChapters, ORDER_FILE, type FileEntry, type OrderMap } from "../../lib/binderTree";
import { Button, Empty } from "../ui";
import "./TimelineView.css";

// The story timeline: ledger facts assembled into story-chronological
// events, drawn as a horizontal spine. Card colour runs cool→warm with
// reading order, and events the reader meets out of story order get a
// flashback badge — so structure is visible at a glance.

interface TimelineEvent {
  when: string;
  what: string;
  scenes: string[];
}

interface TimelineProps {
  refreshVersion: number;
  onOpenScene: (file: string) => void;
  onStatus: (m: string) => void;
}

const CARD_W = 240;
const GAP = 64;
const STEP = CARD_W + GAP;
const SPINE_Y = 0.52; // fraction of height

const sceneName = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

export const TimelineView: Component<TimelineProps> = (props) => {
  const [building, setBuilding] = createSignal(false);

  const [data, { refetch }] = createResource(
    // Wrapped: a bare version number of 0 is falsy and would never fetch.
    () => ({ v: props.refreshVersion }),
    async () => {
      try {
        const [timeline, files, orderRes] = await Promise.all([
          window.chronicler.invoke("agents/timeline"),
          window.chronicler.invoke("project/list_files"),
          window.chronicler.invoke("document/read", { path: ORDER_FILE }).catch(() => null),
        ]);
        let order: OrderMap = {};
        try { if (orderRes?.content) order = JSON.parse(orderRes.content); } catch { /* default order */ }
        const reading: string[] = buildCompileChapters(
          buildTree(files.files as FileEntry[], order)
        ).flatMap(c => c.scenes);
        return { timeline, reading };
      } catch {
        return { timeline: null, reading: [] as string[] };
      }
    }
  );

  const build = async () => {
    setBuilding(true);
    props.onStatus("Agent: assembling the story timeline from the ledger...");
    try {
      await window.chronicler.invoke("agents/timeline_build", {});
      props.onStatus("Story timeline rebuilt");
    } catch (err: any) {
      props.onStatus(`Timeline build failed: ${err.message}`);
    } finally {
      setBuilding(false);
      refetch();
    }
  };

  /** Events enriched with reading order + out-of-order (flashback) flags. */
  const events = createMemo(() => {
    const d = data();
    const evs: TimelineEvent[] = d?.timeline?.events ?? [];
    const reading = d?.reading ?? [];
    const readIdx = (scenes: string[]) => {
      const idxs = scenes.map(s => reading.indexOf(s)).filter(i => i >= 0);
      return idxs.length ? Math.min(...idxs) : Number.MAX_SAFE_INTEGER;
    };
    const enriched = evs.map((e, i) => ({ ...e, story: i, read: readIdx(e.scenes) }));
    // An event is told out of order when some LATER story event is read earlier
    const suffixMin: number[] = new Array(enriched.length).fill(Number.MAX_SAFE_INTEGER);
    for (let i = enriched.length - 2; i >= 0; i--) {
      suffixMin[i] = Math.min(suffixMin[i + 1], enriched[i + 1].read);
    }
    return enriched.map((e, i) => ({ ...e, flashback: e.read > suffixMin[i] }));
  });

  /** Cool→warm by reading position, so the eye can follow the telling. */
  const tone = (e: { read: number; flashback: boolean }) => {
    if (e.flashback) return "var(--ai)";
    const read = e.read;
    const n = Math.max(1, (data()?.reading.length ?? 1) - 1);
    const t = Math.min(1, read / n);
    return `color-mix(in oklab, var(--info) ${Math.round((1 - t) * 100)}%, var(--warning))`;
  };

  const width = () => 80 + events().length * STEP + 60;
  const spineY = `${SPINE_Y * 100}%`;

  return (
    <div class="tl-view">
      <div class="tl-toolbar">
        <Clock size={14} class="tl-toolbar-icon" />
        <span class="tl-title">Story time</span>
        <Show when={data()?.timeline?.builtAt}>
          <span class="tl-built">built {new Date(data()!.timeline!.builtAt * 1000).toLocaleString()}</span>
        </Show>
        <span class="tl-legend">
          <CornerLeftDown size={11} class="tl-flash-icon" /> told out of order
        </span>
        <Button size="sm" onClick={build} disabled={building()} title="Rebuild from the fact ledger">
          <RefreshCw size={12} class={building() ? "tl-spinning" : ""} />
          {building() ? "Assembling…" : "Rebuild"}
        </Button>
      </div>

      <Show
        when={events().length > 0}
        fallback={
          <div class="tl-empty">
            <Empty icon={<Clock size={28} />}>
              <p>
                No timeline yet. Build the fact ledger, then choose <b>Rebuild</b> — the agent
                gathers every mention of story time into a single chronology.
              </p>
            </Empty>
          </div>
        }
      >
        <div class="tl-scroll">
          <div class="tl-canvas" style={{ width: `${width()}px` }}>
            {/* Spine + connectors */}
            <svg width={width()} height="100%" class="tl-svg" preserveAspectRatio="none">
              <defs>
                {/* userSpaceOnUse: a straight line has a zero-height bounding
                    box, which silently kills objectBoundingBox gradients */}
                <linearGradient id="tl-spine" gradientUnits="userSpaceOnUse" x1="30" y1="0" x2={width() - 30} y2="0">
                  <stop offset="0%" class="tl-stop-early" />
                  <stop offset="100%" class="tl-stop-late" />
                </linearGradient>
              </defs>
              <line
                class="tl-spine"
                x1="30" x2={width() - 30}
                y1={spineY} y2={spineY}
                stroke="url(#tl-spine)" stroke-width="2.5" stroke-linecap="round"
              />
              <Index each={events()}>
                {(e, i) => (
                  <g
                    class="tl-node"
                    style={{ "--tl-color": tone(e()), "animation-delay": `${i * 70}ms` }}
                  >
                    <line
                      class="tl-connector"
                      x1={80 + i * STEP + CARD_W / 2} x2={80 + i * STEP + CARD_W / 2}
                      y1={spineY}
                      y2={i % 2 === 0 ? `${SPINE_Y * 100 - 9}%` : `${SPINE_Y * 100 + 9}%`}
                    />
                    <circle class="tl-dot" cx={80 + i * STEP + CARD_W / 2} cy={spineY} r="7" />
                  </g>
                )}
              </Index>
            </svg>

            {/* Event cards, alternating above/below the spine */}
            <Index each={events()}>
              {(e, i) => (
                <div
                  class="tl-card"
                  style={{
                    "--tl-color": tone(e()),
                    left: `${80 + i * STEP}px`,
                    width: `${CARD_W}px`,
                    top: i % 2 === 0 ? "auto" : `${SPINE_Y * 100 + 10.5}%`,
                    bottom: i % 2 === 0 ? `${(1 - SPINE_Y) * 100 + 10.5}%` : "auto",
                    "animation-delay": `${i * 70}ms`,
                  }}
                >
                  <div class="tl-card-head">
                    <span class="tl-when">{e().when}</span>
                    <Show when={e().flashback}>
                      <span title="The reader meets this after later story events">
                        <CornerLeftDown size={11} class="tl-flash-icon" />
                      </span>
                    </Show>
                  </div>
                  <div class="tl-what">{e().what}</div>
                  <div class="tl-chips">
                    <For each={e().scenes}>
                      {(scene) => (
                        <button type="button" class="tl-chip" title={scene} onClick={() => props.onOpenScene(scene)}>
                          {sceneName(scene)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </Index>
          </div>
        </div>
      </Show>
    </div>
  );
};
