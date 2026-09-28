import { type Component, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { Link2, Share2, Sparkles } from "lucide-solid";
import { Button, Empty } from "../ui";
import "./GraphView.css";

// The codex as a constellation. Three layers: faint scene co-occurrence
// edges (pure mention math), dashed agent-derived relations, and solid
// human-drawn relations. Force-directed, draggable, click-through.
// Entity-kind colours live in GraphView.css (data-kind on each node).

const W = 1600;
const H = 900;

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
  const [loaded, setLoaded] = createSignal(false);
  const [g, setG] = createStore<{ nodes: GNode[]; co: CoEdge[]; rels: Relation[] }>({
    nodes: [], co: [], rels: [],
  });
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [linkMode, setLinkMode] = createSignal(false);
  const [linkFrom, setLinkFrom] = createSignal<number | null>(null);
  const [linkTo, setLinkTo] = createSignal<number | null>(null);
  const [deriving, setDeriving] = createSignal(false);

  let alpha = 0;
  let raf = 0;
  let svgRef: SVGSVGElement | undefined;

  const [, { refetch }] = createResource(
    // Wrapped: a bare version number of 0 is falsy and would never fetch.
    () => ({ v: props.refreshVersion }),
    async () => {
      try {
        const res = await window.chronicler.invoke("codex/graph");
        const prev = new Map(g.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
        const nodes = (res.nodes as any[]).map((n, i) => {
          const old = prev.get(n.id);
          const angle = (i / Math.max(1, res.nodes.length)) * Math.PI * 2;
          return {
            ...n,
            x: old?.x ?? W / 2 + Math.cos(angle) * 260,
            y: old?.y ?? H / 2 + Math.sin(angle) * 200,
            vx: 0, vy: 0,
            r: Math.min(26, 9 + Math.sqrt(n.mentions) * 2.4),
          };
        });
        setG(reconcile({ nodes, co: res.coEdges, rels: res.relations }, { key: null }));
        setLoaded(true);
        reheat();
        return res;
      } catch {
        setLoaded(true);
        return null;
      }
    }
  );

  const byId = (id: number) => g.nodes.find(n => n.id === id);

  const step = () => {
    setG(produce(s => {
      const nodes = s.nodes;
      const find = (id: number) => nodes.find(n => n.id === id);
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
      const spring = (ai: number, bi: number, rest: number, k: number) => {
        const a = find(ai), b = find(bi);
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = (d - rest) * k * alpha;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      };
      for (const e of s.co) spring(e.a, e.b, 170 - Math.min(60, e.weight * 12), 0.06);
      for (const r of s.rels) spring(r.from, r.to, 190, 0.05);
      for (const n of nodes) {
        if (dragging === n.id) continue;
        n.vx += (W / 2 - n.x) * 0.004 * alpha;
        n.vy += (H / 2 - n.y) * 0.004 * alpha;
        n.x = Math.max(40, Math.min(W - 40, n.x + n.vx));
        n.y = Math.max(48, Math.min(H - 56, n.y + n.vy));
        n.vx *= 0.82; n.vy *= 0.82;
      }
    }));
    alpha *= 0.985;
    if (alpha > 0.004 || dragging !== null) raf = requestAnimationFrame(step);
    else raf = 0;
  };

  const reheat = () => {
    alpha = 1;
    if (!raf) raf = requestAnimationFrame(step);
  };
  onCleanup(() => cancelAnimationFrame(raf));

  // ---- Dragging (with click detection) ----
  let dragging: number | null = null;
  let dragMoved = 0;

  const svgPoint = (e: PointerEvent) => {
    const rect = svgRef!.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const ox = (rect.width - W * scale) / 2;
    const oy = (rect.height - H * scale) / 2;
    return { x: (e.clientX - rect.left - ox) / scale, y: (e.clientY - rect.top - oy) / scale };
  };

  const onNodeDown = (n: GNode, e: PointerEvent) => {
    dragging = n.id;
    dragMoved = 0;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging === null) return;
    const p = svgPoint(e);
    setG(produce(s => {
      const n = s.nodes.find(n => n.id === dragging);
      if (!n) return;
      dragMoved += Math.abs(p.x - n.x) + Math.abs(p.y - n.y);
      n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
    }));
    if (!raf) { alpha = Math.max(alpha, 0.08); raf = requestAnimationFrame(step); }
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
    g.co.some(e => (e.a === id || e.b === id) && (e.a === hovered() || e.b === hovered())) ||
    g.rels.some(r => (r.from === id || r.to === id) && (r.from === hovered() || r.to === hovered()));
  const dimmed = (id: number) => hovered() !== null && hovered() !== id && !adjacent(id);

  return (
    <div class="gv-view">
      <div class="gv-toolbar">
        <Share2 size={14} class="gv-toolbar-icon" />
        <span class="gv-title">Relationships</span>
        <div class="gv-legend">
          <span>
            <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" class="gv-co" stroke-width="2" opacity="0.5" /></svg>
            share scenes
          </span>
          <span>
            <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" class="gv-rel agent" /></svg>
            suggested by the agent
          </span>
          <span>
            <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" class="gv-rel human" /></svg>
            yours
          </span>
        </div>
        <Button
          size="sm"
          class={linkMode() ? "gv-linking" : ""}
          onClick={() => (linkMode() ? cancelLink() : (setLinkMode(true), props.onStatus("Link mode: click two entities")))}
        >
          <Link2 size={12} /> {linkMode() ? "Cancel link" : "Add link"}
        </Button>
        <Button size="sm" onClick={derive} disabled={deriving()}>
          <Sparkles size={12} /> {deriving() ? "Deriving…" : "Derive links"}
        </Button>
      </div>

      <div class="gv-stage">
        <svg
          ref={svgRef}
          class="gv-svg"
          classList={{ linking: linkMode() }}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={onPointerMove}
        >
          <Show when={loaded()}>
            <>
              {/* Scene co-occurrence */}
              <For each={g.co}>
                {(e) => {
                  const a = byId(e.a), b = byId(e.b);
                  return a && b ? (
                    <line
                      class="gv-co"
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke-width={Math.min(4, 0.8 + e.weight * 0.7)}
                      opacity={dimmed(e.a) || dimmed(e.b) ? 0.06 : 0.22}
                    />
                  ) : null;
                }}
              </For>
              {/* Typed relations */}
              <For each={g.rels}>
                {(r) => {
                  const a = byId(r.from), b = byId(r.to);
                  if (!a || !b) return null;
                  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                  const faded = dimmed(r.from) || dimmed(r.to);
                  return (
                    <g opacity={faded ? 0.08 : 1}>
                      <line
                        class={`gv-rel ${r.source === "human" ? "human" : "agent"}`}
                        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      />
                      <text
                        x={mx} y={my - 5}
                        text-anchor="middle"
                        class="gv-edge-label"
                        onClick={() => deleteRelation(r)}
                      >
                        {r.label}
                      </text>
                    </g>
                  );
                }}
              </For>
              {/* Nodes */}
              <For each={g.nodes}>
                {(n) => (
                  <g
                    class="gv-node"
                    classList={{ picked: linkFrom() === n.id || linkTo() === n.id }}
                    data-kind={n.kind}
                    opacity={dimmed(n.id) ? 0.18 : 1}
                    onPointerDown={(e) => onNodeDown(n, e)}
                    onPointerUp={() => onPointerUp(n)}
                    onPointerEnter={() => setHovered(n.id)}
                    onPointerLeave={() => setHovered(null)}
                  >
                    <circle cx={n.x} cy={n.y} r={n.r} />
                    <text x={n.x} y={n.y + n.r + 14} text-anchor="middle" class="gv-node-label">
                      {n.name}
                    </text>
                  </g>
                )}
              </For>
            </>
          </Show>
        </svg>

        {/* Label form for a pending human link */}
        <Show when={linkFrom() !== null && linkTo() !== null}>
          <div class="gv-link-form">
            <span>{byId(linkFrom()!)?.name}</span>
            <input
              class="input"
              autofocus
              value={labelDraft()}
              onInput={(e) => setLabelDraft(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLink(); if (e.key === "Escape") cancelLink(); }}
              placeholder="captain of…"
            />
            <span>{byId(linkTo()!)?.name}</span>
            <Button size="sm" variant="primary" onClick={saveLink}>Save</Button>
          </div>
        </Show>

        <Show when={loaded() && g.nodes.length === 0}>
          <div class="gv-empty">
            <Empty>No codex entries yet — the graph draws itself once the world bible has people in it.</Empty>
          </div>
        </Show>
      </div>
    </div>
  );
};
