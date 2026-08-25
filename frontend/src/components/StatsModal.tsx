import { type Component, For, Show } from "solid-js";
import { X, TrendingUp } from "lucide-solid";
import { chapterName } from "../lib/binderTree";

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

const Bar: Component<{ value: number; max: number; color?: string; height?: string }> = (props) => (
  <div style={{ background: "var(--bg-color)", border: "1px solid var(--border-color)", "border-radius": "6px", height: props.height ?? "10px", overflow: "hidden" }}>
    <div style={{
      width: `${Math.min(100, props.max > 0 ? (props.value / props.max) * 100 : 0)}%`,
      height: "100%",
      background: props.color ?? "var(--accent)",
      "border-radius": "6px",
      transition: "width 0.4s ease",
    }} />
  </div>
);

const numInput = {
  width: "110px", padding: "6px 9px", background: "var(--bg-color)",
  border: "1px solid var(--border-color)", color: "var(--text-main)",
  "border-radius": "5px", outline: "none", "font-size": "13px",
} as const;

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

  return (
    <Show when={props.open}>
      <div
        style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)", "backdrop-filter": "blur(2px)", "z-index": 2000,
          display: "flex", "justify-content": "center", "align-items": "center",
        }}
        onClick={props.onClose}
      >
        <div
          style={{
            background: "var(--panel-bg)", width: "600px", "max-height": "80vh",
            border: "1px solid var(--border-color)", "border-radius": "10px",
            display: "flex", "flex-direction": "column", overflow: "hidden",
            "box-shadow": "0 15px 50px rgba(0,0,0,0.6)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding: "14px 20px", display: "flex", "align-items": "center", "justify-content": "space-between", "border-bottom": "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", color: "var(--text-main)", "font-size": "14px", "font-weight": 600 }}>
              <TrendingUp size={16} /> Writing Statistics
            </div>
            <X size={18} style={{ cursor: "pointer", color: "var(--text-muted)" }} onClick={props.onClose} />
          </div>

          <div style={{ "overflow-y": "auto", padding: "20px", display: "flex", "flex-direction": "column", gap: "22px" }}>
            {/* Today */}
            <div>
              <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "7px", "font-size": "13px" }}>
                <span style={{ color: "var(--text-main)", "font-weight": 600 }}>Today</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {fmt(props.stats?.today.written ?? 0)} / {fmt(props.targets.dailyTarget)} words
                </span>
              </div>
              <Bar value={props.stats?.today.written ?? 0} max={props.targets.dailyTarget} color="var(--entity)" />
            </div>

            {/* Manuscript */}
            <div>
              <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "7px", "font-size": "13px" }}>
                <span style={{ color: "var(--text-main)", "font-weight": 600 }}>Manuscript</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {fmt(props.stats?.total ?? 0)} / {fmt(props.targets.projectTarget)} words
                </span>
              </div>
              <Bar value={props.stats?.total ?? 0} max={props.targets.projectTarget} />
            </div>

            {/* 14-day history */}
            <div>
              <div style={{ "font-size": "13px", color: "var(--text-main)", "font-weight": 600, "margin-bottom": "8px" }}>Last two weeks</div>
              <div style={{ display: "flex", "align-items": "flex-end", gap: "5px", height: "64px" }}>
                <For each={days()}>
                  {(d) => (
                    <div
                      title={`${d.date}: ${d.hasData ? fmt(d.written) + " words" : "no writing recorded"}`}
                      style={{
                        flex: 1,
                        height: d.written > 0 ? `${Math.max(6, (d.written / maxDay()) * 100)}%` : "3px",
                        background: d.written > 0
                          ? (d.written >= props.targets.dailyTarget ? "var(--entity)" : "var(--accent)")
                          : "var(--border-color)",
                        opacity: d.date === props.stats?.today.date ? 1 : 0.6,
                        "border-radius": "3px 3px 0 0",
                      }}
                    />
                  )}
                </For>
              </div>
              <div style={{ display: "flex", "justify-content": "space-between", "font-size": "10px", color: "var(--text-faint)", "margin-top": "3px" }}>
                <span>{days()[0]?.date.slice(5)}</span>
                <span>today</span>
              </div>
              <div style={{ "font-size": "11px", color: "var(--text-faint)", "margin-top": "5px" }}>
                Green bars hit the daily target. Deleting words counts down — revision days happen.
              </div>
            </div>

            {/* Per chapter */}
            <div>
              <div style={{ "font-size": "13px", color: "var(--text-main)", "font-weight": 600, "margin-bottom": "8px" }}>By chapter</div>
              <For each={chapters()}>
                {(c) => (
                  <div style={{ display: "flex", "align-items": "center", gap: "12px", "margin-bottom": "6px" }}>
                    <span style={{ width: "180px", "font-size": "12px", color: "var(--text-muted)", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>{c.name}</span>
                    <div style={{ flex: 1 }}><Bar value={c.words} max={c.max} height="7px" /></div>
                    <span style={{ width: "60px", "text-align": "right", "font-size": "12px", color: "var(--text-main)" }}>{fmt(c.words)}</span>
                  </div>
                )}
              </For>
            </div>

            {/* Targets */}
            <div style={{ display: "flex", gap: "24px", "border-top": "1px solid var(--border-color)", "padding-top": "16px" }}>
              <label style={{ "font-size": "12px", color: "var(--text-muted)" }}>
                Daily target<br />
                <input
                  style={{ ...numInput, "margin-top": "5px" }} type="number" min="0" step="50"
                  value={props.targets.dailyTarget}
                  onChange={(e) => props.onSaveTargets({ ...props.targets, dailyTarget: parseInt(e.currentTarget.value, 10) || 0 })}
                />
              </label>
              <label style={{ "font-size": "12px", color: "var(--text-muted)" }}>
                Manuscript target<br />
                <input
                  style={{ ...numInput, "margin-top": "5px" }} type="number" min="0" step="5000"
                  value={props.targets.projectTarget}
                  onChange={(e) => props.onSaveTargets({ ...props.targets, projectTarget: parseInt(e.currentTarget.value, 10) || 0 })}
                />
              </label>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};
