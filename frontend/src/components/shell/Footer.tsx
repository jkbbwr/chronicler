import { type Component, Show } from "solid-js";
import { notice, setOverlays } from "../../stores/app";
import { countWords, docs, scene } from "../../stores/documents";
import { fetchStats, stats, targets } from "../../stores/stats";
import { workbench } from "../../stores/workbench";
import { SprintControl } from "./SprintControl";

const fmt = (n: number) => n.toLocaleString();

/** Today's words against the daily goal, as a small ring. */
export const GoalRing: Component<{ size?: number }> = (props) => {
  const size = () => props.size ?? 14;
  const r = () => size() / 2 - 2;
  const c = () => 2 * Math.PI * r();
  const written = () => Math.max(0, stats()?.today.written ?? 0);
  const goal = () => targets().dailyTarget;
  const frac = () => (goal() > 0 ? Math.min(1, written() / goal()) : 0);
  return (
    <svg class="goal-ring" classList={{ met: goal() > 0 && written() >= goal() }} width={size()} height={size()} aria-hidden="true">
      <circle class="track" cx={size() / 2} cy={size() / 2} r={r()} />
      <circle class="fill" cx={size() / 2} cy={size() / 2} r={r()} stroke-dasharray={String(c())} stroke-dashoffset={String(c() * (1 - frac()))} />
    </svg>
  );
};

export const sceneWords = () => {
  const s = scene();
  return s && docs[s] ? countWords(docs[s].content) : 0;
};

export const Footer: Component = () => {
  const openStats = () => {
    void fetchStats();
    setOverlays("stats", true);
  };
  return (
    <footer class="footer">
      <div class="footer-notice" data-kind={notice()?.kind} title={notice()?.message}>
        {notice()?.message ?? ""}
      </div>
      <Show when={workbench.mode === "write" && scene()}>
        <span class="footer-item" title="Words in this scene">
          {fmt(sceneWords())} words
          <Show when={docs[scene()!]?.dirty}><span title="Unsaved — saves automatically">•</span></Show>
        </span>
      </Show>
      <SprintControl />
      <Show when={stats()}>
        <span class="footer-item clickable" onClick={openStats} title="Today's words against your daily goal — click for statistics">
          <GoalRing />
          {fmt(Math.max(0, stats()!.today.written))} / {fmt(targets().dailyTarget)} today
        </span>
      </Show>
    </footer>
  );
};
