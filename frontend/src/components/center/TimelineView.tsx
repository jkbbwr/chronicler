import { type Component, createMemo, createResource, createSignal, For, Index, Show } from "solid-js";
import { Clock, CornerLeftDown, Maximize2, Minimize2, RefreshCw } from "lucide-solid";
import { workbench, setWorkbench } from "../../stores/workbench";
import { buildTree, buildCompileChapters, ORDER_FILE, type FileEntry, type OrderMap } from "../../lib/binderTree";

// The story timeline: ledger facts assembled into story-chronological
// events, drawn as a horizontal spine. Card color runs cool→warm with
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
    () => props.refreshVersion,
    async () => {
      try {
        const [timeline, files, orderRes] = await Promise.all([
          window.chronicler.invoke("agents/timeline"),
          window.chronicler.invoke("project/list_files"),
          window.chronicler.invoke("document/read", { rel_path: ORDER_FILE }).catch(() => null),
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

  /** Cool→warm hue by reading position, so the eye can follow the telling. */
  const hue = (read: number) => {
    const n = Math.max(1, (data()?.reading.length ?? 1) - 1);
    const t = Math.min(1, read / n);
    return 210 - t * 175; // 210 (blue) → 35 (amber)
  };

  const width = () => 80 + events().length * STEP + 60;

  return (
    <div style={{ height: "100%", display: "flex", "flex-direction": "column" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "12px 18px 0" }}>
        <Clock size={14} style={{ color: "var(--text-muted)" }} />
        <span style={{ "font-size": "13px", "font-weight": 600, color: "var(--text-main)" }}>Story time</span>
        <Show when={data()?.timeline?.builtAt}>
          <span style={{ "font-size": "11px", color: "var(--text-faint)" }}>
            built {new Date(data()!.timeline.builtAt * 1000).toLocaleString()}
          </span>
        </Show>
        <div style={{ flex: 1 }} />
        <span style={{ "font-size": "11px", color: "var(--text-faint)", display: "flex", "align-items": "center", gap: "4px" }}>
          <CornerLeftDown size={11} color="#b689e0" /> told out of order
        </span>
        <button
          onClick={build} disabled={building()}
          title="Rebuild from the fact ledger"
          style={{ display: "flex", "align-items": "center", gap: "5px", padding: "5px 12px", background: "transparent", border: "1px solid var(--border-color)", color: "var(--text-muted)", "border-radius": "6px", cursor: "pointer", "font-size": "12px", opacity: building() ? 0.6 : 1 }}
        >
          <RefreshCw size={12} style={building() ? { animation: "spin 1s linear infinite" } : {}} />
          {building() ? "Assembling…" : "Rebuild"}
        </button>
        <button
          onClick={() => setWorkbench("zenMode", z => !z)}
          title={workbench.zenMode ? "Exit full screen" : "Full screen"}
          style={{ display: "flex", "align-items": "center", "justify-content": "center", width: "28px", height: "28px", padding: 0, background: "transparent", border: "1px solid var(--border-color)", "border-radius": "6px", color: "var(--text-muted)", cursor: "pointer" }}
        >
          {workbench.zenMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      <Show
        when={events().length > 0}
        fallback={
          <div style={{ flex: 1, display: "flex", "align-items": "center", "justify-content": "center" }}>
            <div style={{ "max-width": "420px", "text-align": "center", color: "var(--text-faint)", "font-size": "13px", "line-height": "1.7" }}>
              <Clock size={28} style={{ opacity: 0.4, "margin-bottom": "10px" }} />
              <div>
                No timeline yet. Build the fact ledger, then hit <b>Rebuild</b> — the agent
                assembles every story-time marker into a single chronology.
              </div>
            </div>
          </div>
        }
      >
        <div style={{ flex: 1, "overflow-x": "auto", "overflow-y": "hidden", position: "relative" }}>
          <div class="timeline-canvas" style={{ position: "relative", width: `${width()}px`, height: "100%", "min-height": "420px" }}>
            {/* Spine + connectors */}
            <svg width={width()} height="100%" style={{ position: "absolute", inset: 0 }} preserveAspectRatio="none">
              <defs>
                <linearGradient id="tl-spine" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stop-color="hsl(210 70% 55%)" />
                  <stop offset="100%" stop-color="hsl(35 80% 55%)" />
                </linearGradient>
              </defs>
              <line
                class="timeline-spine"
                x1="30" x2={width() - 30}
                y1={`${SPINE_Y * 100}%`} y2={`${SPINE_Y * 100}%`}
                stroke="url(#tl-spine)" stroke-width="2.5" stroke-linecap="round"
              />
              <Index each={events()}>
                {(e, i) => (
                  <g class="timeline-node" style={{ "animation-delay": `${i * 70}ms` }}>
                    <line
                      x1={80 + i * STEP + CARD_W / 2} x2={80 + i * STEP + CARD_W / 2}
                      y1={`${SPINE_Y * 100}%`}
                      y2={i % 2 === 0 ? `${SPINE_Y * 100 - 9}%` : `${SPINE_Y * 100 + 9}%`}
                      stroke={`hsl(${hue(e().read)} 60% 50% / 0.55)`} stroke-width="1.5" stroke-dasharray="3 3"
                    />
                    <circle
                      cx={80 + i * STEP + CARD_W / 2} cy={`${SPINE_Y * 100}%`} r="7"
                      fill="var(--bg-color)"
                      stroke={e().flashback ? "#b689e0" : `hsl(${hue(e().read)} 70% 55%)`}
                      stroke-width="2.5"
                    />
                  </g>
                )}
              </Index>
            </svg>

            {/* Event cards, alternating above/below the spine */}
            <Index each={events()}>
              {(e, i) => (
                <div
                  class="timeline-card"
                  style={{
                    position: "absolute",
                    left: `${80 + i * STEP}px`,
                    width: `${CARD_W}px`,
                    top: i % 2 === 0 ? "auto" : `${SPINE_Y * 100 + 10.5}%`,
                    bottom: i % 2 === 0 ? `${(1 - SPINE_Y) * 100 + 10.5}%` : "auto",
                    "border-top": `3px solid ${e().flashback ? "#b689e0" : `hsl(${hue(e().read)} 70% 55%)`}`,
                    "animation-delay": `${i * 70}ms`,
                  }}
                >
                  <div style={{ display: "flex", "align-items": "baseline", gap: "6px" }}>
                    <span style={{ "font-size": "11px", "font-weight": 700, "letter-spacing": "0.4px", "text-transform": "uppercase", color: e().flashback ? "#b689e0" : `hsl(${hue(e().read)} 65% 60%)` }}>
                      {e().when}
                    </span>
                    <Show when={e().flashback}>
                      <span title="The reader meets this after later story events" style={{ "flex-shrink": 0 }}>
                        <CornerLeftDown size={11} color="#b689e0" />
                      </span>
                    </Show>
                  </div>
                  <div style={{ "font-size": "12.5px", color: "var(--text-main)", "line-height": "1.5", margin: "5px 0 8px" }}>
                    {e().what}
                  </div>
                  <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
                    <For each={e().scenes}>
                      {(scene) => (
                        <span
                          onClick={() => props.onOpenScene(scene)}
                          title={scene}
                          class="timeline-chip"
                        >
                          {sceneName(scene)}
                        </span>
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
