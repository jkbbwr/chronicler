import { type Component, For, Show } from "solid-js";
import { chapterName } from "../lib/binderTree";
import { Modal } from "./ui";
import "./StatsModal.css";

// Writing statistics: today's progress, manuscript progress, a 14-day
// history, and per-chapter counts.

export interface ProjectStats {
  total: number;
  files: { file: string; words: number }[];
  today: { date: string; written: number };
  history: { date: string; written: number }[];
}

export interface WritingTargets {
  dailyTarget: number;
  projectTarget: number;
}

interface StatsModalProps {
  open: boolean;
  stats: ProjectStats | null;
  targets: WritingTargets;
  onClose: () => void;
  onSaveTargets: (t: WritingTargets) => void;
}

const fmt = (n: number) => n.toLocaleString("en-US");

const Bar: Component<{ value: number; max: number; met?: boolean; thin?: boolean }> = (props) => (
  <div class={`stats-bar${props.thin ? " stats-bar-thin" : ""}`}>
    <div
      class={`stats-bar-fill${props.met ? " met" : ""}`}
      style={{ width: `${Math.min(100, props.max > 0 ? (props.value / props.max) * 100 : 0)}%` }}
    />
  </div>
);

export const StatsModal: Component<StatsModalProps> = (props) => {
  const chapters = () => {
    const groups = new Map<string, number>();
    for (const f of props.stats?.files ?? []) {
      const top = f.file.includes("/") ? f.file.split("/")[0] : f.file.replace(/\.md$/, "");
      groups.set(top, (groups.get(top) ?? 0) + f.words);
    }
    const max = Math.max(1, ...groups.values());
    return [...groups.entries()].map(([name, words]) => ({ name: chapterName(name), words, max }));
  };

  // Always 14 calendar-day slots ending today, so one day of history shows
  // as one bar in its place, not a full-width smear.
  const days = () => {
    const byDate = new Map((props.stats?.history ?? []).map(d => [d.date, d.written]));
    const slots: { date: string; written: number; hasData: boolean }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toLocaleDateString("sv-SE");
      slots.push({ date, written: byDate.get(date) ?? 0, hasData: byDate.has(date) });
    }
    return slots;
  };
  const maxDay = () => Math.max(props.targets.dailyTarget, 1, ...days().map(d => d.written));
  const todayWritten = () => props.stats?.today.written ?? 0;

  return (
    <Show when={props.open}>
      <Modal title="Writing statistics" onClose={props.onClose}>
        <div class="stats">
          <section>
            <div class="stats-row-head">
              <h3 class="stats-heading">Today</h3>
              <span class="stats-figure">{fmt(todayWritten())} / {fmt(props.targets.dailyTarget)} words</span>
            </div>
            <Bar
              value={todayWritten()}
              max={props.targets.dailyTarget}
              met={props.targets.dailyTarget > 0 && todayWritten() >= props.targets.dailyTarget}
            />
          </section>

          <section>
            <div class="stats-row-head">
              <h3 class="stats-heading">Manuscript</h3>
              <span class="stats-figure">{fmt(props.stats?.total ?? 0)} / {fmt(props.targets.projectTarget)} words</span>
            </div>
            <Bar value={props.stats?.total ?? 0} max={props.targets.projectTarget} />
          </section>

          <section>
            <h3 class="stats-heading">Last two weeks</h3>
            <div class="stats-days">
              <For each={days()}>
                {(d) => (
                  <div
                    title={`${d.date}: ${d.hasData ? fmt(d.written) + " words" : "no writing recorded"}`}
                    class="stats-day"
                    classList={{
                      wrote: d.written > 0,
                      met: d.written > 0 && d.written >= props.targets.dailyTarget,
                      today: d.date === props.stats?.today.date,
                    }}
                    style={d.written > 0 ? { height: `${Math.max(6, (d.written / maxDay()) * 100)}%` } : undefined}
                  />
                )}
              </For>
            </div>
            <div class="stats-days-axis">
              <span>{days()[0]?.date.slice(5)}</span>
              <span>today</span>
            </div>
            <p class="hint">
              Green bars hit the daily target. Deleting words counts down — revision days happen.
            </p>
          </section>

          <section>
            <h3 class="stats-heading">By chapter</h3>
            <For each={chapters()}>
              {(c) => (
                <div class="stats-chapter">
                  <span class="stats-chapter-name">{c.name}</span>
                  <Bar value={c.words} max={c.max} thin />
                  <span class="stats-chapter-count">{fmt(c.words)}</span>
                </div>
              )}
            </For>
          </section>

          <div class="stats-targets">
            <div class="field">
              <label for="stats-daily">Daily target</label>
              <input
                id="stats-daily"
                class="input"
                type="number" min="0" step="50"
                value={props.targets.dailyTarget}
                onChange={(e) => props.onSaveTargets({ ...props.targets, dailyTarget: parseInt(e.currentTarget.value, 10) || 0 })}
              />
            </div>
            <div class="field">
              <label for="stats-project">Manuscript target</label>
              <input
                id="stats-project"
                class="input"
                type="number" min="0" step="5000"
                value={props.targets.projectTarget}
                onChange={(e) => props.onSaveTargets({ ...props.targets, projectTarget: parseInt(e.currentTarget.value, 10) || 0 })}
              />
            </div>
          </div>
        </div>
      </Modal>
    </Show>
  );
};
