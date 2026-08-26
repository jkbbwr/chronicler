import { type Component, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { Link2, Maximize2, Minimize2, Share2, Sparkles } from "lucide-solid";
import { workbench, setWorkbench } from "../../stores/workbench";

// The codex as a constellation. Three layers: gray scene co-occurrence
// edges (pure mention math), dashed agent-derived relations, and solid
// human-drawn relations. Force-directed, draggable, click-through.

const W = 1600;
const H = 900;

const KIND_COLOR: Record<string, string> = {
  character: "#61afef",
  place: "#98c379",
  faction: "#e5c07b",
  item: "#d19a66",
  creature: "#e06c75",
  event: "#c678dd",
  lore: "#56b6c2",
};

interface GNode {
  id: number;
  name: string;
  kind: string;
  mentions: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface CoEdge { a: number; b: number; weight: number }
interface Relation { id: number; from: number; to: number; label: string; source: string }

interface GraphProps {
  refreshVersion: number;
  onOpenEntity: (id: number, name: string) => void;
  onStatus: (m: string) => void;
}

export const GraphView: Component<GraphProps> = (props) => {
  const [tick, setTick] = createSignal(0);
  const [loaded, setLoaded] = createSignal<{ n: number } | null>(null);
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [linkMode, setLinkMode] = createSignal(false);
  const [linkFrom, setLinkFrom] = createSignal<number | null>(null);
  const [linkTo, setLinkTo] = createSignal<number | null>(null);
  const [deriving, setDeriving] = createSignal(false);

  let nodes: GNode[] = [];
  let coEdges: CoEdge[] = [];
  let relations: Relation[] = [];
  let alpha = 0;
  let raf = 0;
  let svgRef: SVGSVGElement | undefined;

  const [, { refetch }] = createResource(
    () => props.refreshVersion,
    async () => {
      try {
        const g = await window.chronicler.invoke("codex/graph");
        const prev = new Map(nodes.map(n => [n.id, n]));
        nodes = (g.nodes as any[]).map((n, i) => {
          const old = prev.get(n.id);
          const angle = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
          return {
            ...n,
            x: old?.x ?? W / 2 + Math.cos(angle) * 260,
            y: old?.y ?? H / 2 + Math.sin(angle) * 200,
            vx: 0, vy: 0,
            r: Math.min(26, 9 + Math.sqrt(n.mentions) * 2.4),
          };
        });
        coEdges = g.coEdges;
        relations = g.relations;
        setLoaded({ n: nodes.length });
        reheat();
        return g;
      } catch {
        setLoaded({ n: 0 });
        return null;
      }
    }
  );

  const byId = (id: number) => nodes.find(n => n.id === id);

  const step = () => {
    // Pairwise repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = Math.min(12, 26000 / d2) * alpha;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
    }
    // Springs
    const spring = (ai: number, bi: number, rest: number, k: number) => {
      const a = byId(ai), b = byId(bi);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - rest) * k * alpha;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    };
    for (const e of coEdges) spring(e.a, e.b, 170 - Math.min(60, e.weight * 12), 0.06);
    for (const r of relations) spring(r.from, r.to, 190, 0.05);
    // Gravity + integrate
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.004 * alpha;
      n.vy += (H / 2 - n.y) * 0.004 * alpha;
      n.x = Math.max(40, Math.min(W - 40, n.x + n.vx));
      n.y = Math.max(48, Math.min(H - 56, n.y + n.vy));
      n.vx *= 0.82; n.vy *= 0.82;
    }
    alpha *= 0.985;
    setTick(t => t + 1);
    if (alpha > 0.004 || dragging) raf = requestAnimationFrame(step);
    else raf = 0;
  };

  const reheat = () => {
    alpha = 1;
    if (!raf) raf = requestAnimationFrame(step);
  };
  onCleanup(() => cancelAnimationFrame(raf));

  // ---- Dragging (with click detection) ----
  let dragging: GNode | null = null;
  let dragMoved = 0;

  const svgPoint = (e: PointerEvent) => {
    const rect = svgRef!.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const ox = (rect.width - W * scale) / 2;
    const oy = (rect.height - H * scale) / 2;
    return { x: (e.clientX - rect.left - ox) / scale, y: (e.clientY - rect.top - oy) / scale };
  };

  const onNodeDown = (n: GNode, e: PointerEvent) => {
    dragging = n;
    dragMoved = 0;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const p = svgPoint(e);
    dragMoved += Math.abs(p.x - dragging.x) + Math.abs(p.y - dragging.y);
    dragging.x = p.x;
    dragging.y = p.y;
    dragging.vx = 0; dragging.vy = 0;
    if (!raf) { alpha = Math.max(alpha, 0.08); raf = requestAnimationFrame(step); }
    setTick(t => t + 1);
  };
  const onPointerUp = (n: GNode) => {
    const wasClick = dragMoved < 6;
    dragging = null;
    reheat();
    if (!wasClick) return;
    if (linkMode()) {
      if (linkFrom() === null) {
        setLinkFrom(n.id);
      } else if (linkFrom() !== n.id && linkTo() === null) {
        setLinkTo(n.id);
      }
    } else {
      props.onOpenEntity(n.id, n.name);
    }
  };

  // ---- Human links ----
  const [labelDraft, setLabelDraft] = createSignal("");
  const saveLink = async () => {
    const from = linkFrom(), to = linkTo();
    const label = labelDraft().trim();
    if (from === null || to === null || !label) return;
    try {
      await window.chronicler.invoke("relations/add", { from, to, label });
      props.onStatus(`Linked: ${byId(from)?.name} —${label}→ ${byId(to)?.name}`);
    } catch (err: any) {
      props.onStatus(`Link failed: ${err.message}`);
    }
    cancelLink();
    refetch();
  };
  const cancelLink = () => {
    setLinkFrom(null); setLinkTo(null); setLabelDraft(""); setLinkMode(false);
  };

  const deleteRelation = async (r: Relation) => {
    const from = byId(r.from)?.name ?? "?";
    const to = byId(r.to)?.name ?? "?";
    const res = await window.chronicler.showMessageBox({
      type: "question", buttons: ["Delete link", "Cancel"], defaultId: 1, cancelId: 1,
      message: `Delete "${from} —${r.label}→ ${to}"?`,
      detail: r.source === "llm" ? "Agent-derived — Derive links may bring it back." : "One of yours.",
    });
    if (res.response !== 0) return;
    await window.chronicler.invoke("relations/delete", { id: r.id });
    refetch();
  };

  const derive = async () => {
    setDeriving(true);
    props.onStatus("Agent: deriving relationships from the ledger and codex...");
    try {
      const res = await window.chronicler.invoke("agents/relations_build", {});
      props.onStatus(`Agent linked ${res.links} relationship(s)`);
    } catch (err: any) {
      props.onStatus(`Derive failed: ${err.message}`);
    } finally {
      setDeriving(false);
      refetch();
    }
  };

  const adjacent = (id: number) =>
    coEdges.some(e => (e.a === id || e.b === id) && (e.a === hovered() || e.b === hovered())) ||
    relations.some(r => (r.from === id || r.to === id) && (r.from === hovered() || r.to === hovered()));
  const dimmed = (id: number) => hovered() !== null && hovered() !== id && !adjacent(id);

  const btn = {
    display: "flex", "align-items": "center", gap: "5px", padding: "5px 12px",
    background: "transparent", border: "1px solid var(--border-color)",
    color: "var(--text-muted)", "border-radius": "6px", cursor: "pointer", "font-size": "12px",
  } as const;

  return (
    <div style={{ height: "100%", display: "flex", "flex-direction": "column" }}>
      <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "12px 18px 8px" }}>
        <Share2 size={14} style={{ color: "var(--text-muted)" }} />
        <span style={{ "font-size": "13px", "font-weight": 600, color: "var(--text-main)" }}>Relationships</span>
        <span style={{ "font-size": "11px", color: "var(--text-faint)" }}>
          gray = shared scenes · dashed = agent · solid = yours
        </span>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...btn, ...(linkMode() ? { color: "var(--accent)", "border-color": "var(--accent)" } : {}) }}
          onClick={() => (linkMode() ? cancelLink() : (setLinkMode(true), props.onStatus("Link mode: click two entities")))}
        >
          <Link2 size={12} /> {linkMode() ? "Cancel link" : "Add link"}
        </button>
        <button style={btn} onClick={derive} disabled={deriving()}>
          <Sparkles size={12} /> {deriving() ? "Deriving…" : "Derive links"}
        </button>
        <button
          style={{ ...btn, width: "28px", "justify-content": "center", padding: 0, height: "27px" }}
          onClick={() => setWorkbench("zenMode", z => !z)}
          title={workbench.zenMode ? "Exit full screen" : "Full screen"}
        >
          {workbench.zenMode ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      <div style={{ flex: 1, "min-height": 0, position: "relative" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "100%", height: "100%", display: "block" }}
          onPointerMove={onPointerMove}
        >
          {(tick() >= 0 && loaded()) && (
            <>
              {/* Scene co-occurrence */}
              <For each={coEdges}>
                {(e) => {
                  const a = byId(e.a), b = byId(e.b);
                  return a && b ? (
                    <line
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="var(--text-faint)"
                      stroke-width={Math.min(4, 0.8 + e.weight * 0.7)}
                      opacity={dimmed(e.a) || dimmed(e.b) ? 0.06 : 0.22}
                    />
                  ) : null;
                }}
              </For>
              {/* Typed relations */}
              <For each={relations}>
                {(r) => {
                  const a = byId(r.from), b = byId(r.to);
                  if (!a || !b) return null;
                  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                  const faded = dimmed(r.from) || dimmed(r.to);
                  return (
                    <g opacity={faded ? 0.08 : 1}>
                      <line
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={r.source === "human" ? "#98c379" : "var(--accent)"}
                        stroke-width="1.6"
                        stroke-dasharray={r.source === "llm" ? "5 4" : undefined}
                        opacity="0.75"
                      />
                      <text
                        x={mx} y={my - 5}
                        text-anchor="middle"
                        class="graph-edge-label"
                        onClick={() => deleteRelation(r)}
                      >
                        {r.label}
                      </text>
                    </g>
                  );
                }}
              </For>
              {/* Nodes */}
              <For each={nodes}>
                {(n) => (
                  <g
                    opacity={dimmed(n.id) ? 0.18 : 1}
                    style={{ cursor: linkMode() ? "crosshair" : "pointer", transition: "opacity 0.15s" }}
                    onPointerDown={(e) => onNodeDown(n, e)}
                    onPointerUp={() => onPointerUp(n)}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <circle
                      cx={n.x} cy={n.y} r={n.r}
                      fill={KIND_COLOR[n.kind] ?? "#8b949e"}
                      fill-opacity="0.16"
                      stroke={linkFrom() === n.id || linkTo() === n.id ? "var(--accent)" : KIND_COLOR[n.kind] ?? "#8b949e"}
                      stroke-width={linkFrom() === n.id || linkTo() === n.id ? 3 : 2}
                    />
                    <text x={n.x} y={n.y + n.r + 14} text-anchor="middle" class="graph-node-label">
                      {n.name}
                    </text>
                  </g>
                )}
              </For>
            </>
          )}
        </svg>

        {/* Label form for a pending human link */}
        <Show when={linkFrom() !== null && linkTo() !== null}>
          <div style={{
            position: "absolute", left: "50%", top: "18px", transform: "translateX(-50%)",
            background: "var(--panel-bg)", border: "1px solid var(--border-color)", "border-radius": "8px",
            padding: "10px 12px", display: "flex", gap: "8px", "align-items": "center",
            "box-shadow": "0 6px 18px rgba(0,0,0,0.35)", "font-size": "12.5px", color: "var(--text-main)",
          }}>
            <span>{byId(linkFrom()!)?.name}</span>
            <input
              autofocus
              value={labelDraft()}
              onInput={(e) => setLabelDraft(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLink(); if (e.key === "Escape") cancelLink(); }}
              placeholder="captain of…"
              style={{ width: "140px", background: "var(--bg-color)", border: "1px solid var(--border-color)", "border-radius": "5px", color: "var(--text-main)", padding: "4px 8px", "font-size": "12px", outline: "none" }}
            />
            <span>{byId(linkTo()!)?.name}</span>
            <button style={{ ...btn, padding: "4px 10px", color: "var(--accent)", "border-color": "var(--accent)" }} onClick={saveLink}>Save</button>
          </div>
        </Show>

        <Show when={loaded() && loaded()!.n === 0}>
          <div style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center", color: "var(--text-faint)", "font-size": "13px" }}>
            No codex entities yet — the graph draws itself once the world bible has people in it.
          </div>
        </Show>
      </div>
    </div>
  );
};
