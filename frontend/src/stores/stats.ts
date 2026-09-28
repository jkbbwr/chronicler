import { createSignal } from "solid-js";
import { invoke } from "../lib/rpc";
import { notifyError } from "./app";
import type { ProjectStats, WritingTargets } from "../components/StatsModal";

// Word counts against the writer's targets. Refreshed a little after saves
// settle (the backend re-reads the manuscript for it).

export const [stats, setStats] = createSignal<ProjectStats | null>(null);
export const [targets, setTargets] = createSignal<WritingTargets>({ dailyTarget: 500, projectTarget: 80000 });

const today = () => new Date().toLocaleDateString("sv-SE"); // yyyy-mm-dd

export async function fetchStats() {
  try {
    setStats(await invoke("stats/get", { today: today() }));
  } catch {
    // backend restarting
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
export function fetchStatsSoon() {
  clearTimeout(timer);
  timer = setTimeout(fetchStats, 2500);
}

/** `seed` (from the New Project wizard) applies only if nothing is stored yet. */
export async function loadTargets(seed?: WritingTargets) {
  try {
    const res = await invoke("db/get", { key: "writing" });
    if (res.value) {
      setTargets((t) => ({ ...t, ...JSON.parse(res.value!) }));
      return;
    }
  } catch {
    return; // keep defaults rather than overwrite
  }
  if (seed) await saveTargets(seed);
}

export async function saveTargets(t: WritingTargets) {
  setTargets(t);
  try {
    await invoke("db/set", { key: "writing", value: JSON.stringify(t) });
  } catch (err) {
    notifyError("Saving targets failed", err);
  }
}

export function resetStats() {
  setStats(null);
}
