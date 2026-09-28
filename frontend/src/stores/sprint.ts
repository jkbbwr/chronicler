import { createSignal } from "solid-js";
import { countWords, docs, getContent } from "./documents";
import { notify } from "./app";
import { invoke } from "../lib/rpc";

// Writing sprints: a timer, an optional word goal, and a count of words
// written since the start (net: cutting counts against it, as it should).

export interface Sprint {
  minutes: number;
  goal: number;
  startedAt: number;
  endsAt: number;
  /** Word counts of open scenes at the start (scenes opened later are added when first seen). */
  baseline: Record<string, number>;
}

export interface SprintRecord {
  date: string;
  minutes: number;
  words: number;
  goal: number;
}

const [sprint, setSprint] = createSignal<Sprint | null>(null);
const [now, setNow] = createSignal(Date.now());
export { sprint };

const HISTORY_KEY = "sprints";

/** Net words written since the sprint began. */
export const sprintWords = () => {
  const s = sprint();
  if (!s) return 0;
  now(); // re-evaluate as time passes (content mirrors lag slightly)
  let total = 0;
  for (const d of Object.values(docs)) {
    if (d.loading) continue;
    // A scene opened mid-sprint starts from what it held when it appeared.
    if (!(d.path in s.baseline)) s.baseline[d.path] = countWords(d.content);
    total += countWords(d.content) - s.baseline[d.path];
  }
  return total;
};

export const sprintRemaining = () => {
  const s = sprint();
  return s ? Math.max(0, s.endsAt - now()) : 0;
};

let ticker: ReturnType<typeof setInterval> | undefined;

export function startSprint(minutes: number, goal = 0) {
  const baseline: Record<string, number> = {};
  for (const d of Object.values(docs)) baseline[d.path] = countWords(getContent(d.path));
  const startedAt = Date.now();
  setSprint({ minutes, goal, startedAt, endsAt: startedAt + minutes * 60_000, baseline });
  setNow(startedAt);
  clearInterval(ticker);
  ticker = setInterval(() => {
    setNow(Date.now());
    if (sprintRemaining() === 0) void finishSprint(true);
  }, 1000);
}

export async function finishSprint(completed: boolean) {
  const s = sprint();
  if (!s) return;
  clearInterval(ticker);
  const words = sprintWords();
  setSprint(null);
  const minutes = Math.max(1, Math.round((Math.min(Date.now(), s.endsAt) - s.startedAt) / 60_000));
  const metGoal = s.goal > 0 && words >= s.goal;
  notify(
    completed
      ? `Sprint done: ${words.toLocaleString()} words in ${minutes} min${metGoal ? " — goal met" : ""}`
      : `Sprint stopped: ${words.toLocaleString()} words in ${minutes} min`,
    metGoal || (completed && s.goal === 0) ? "success" : "info",
  );
  if (words > 0 || completed) {
    try {
      const prior = (await invoke("db/get", { key: HISTORY_KEY })).value;
      const list: SprintRecord[] = prior ? JSON.parse(prior) : [];
      list.push({ date: new Date(s.startedAt).toISOString(), minutes, words, goal: s.goal });
      await invoke("db/set", { key: HISTORY_KEY, value: JSON.stringify(list.slice(-200)) });
    } catch {
      // history is a nicety
    }
  }
}

export async function sprintHistory(): Promise<SprintRecord[]> {
  try {
    const v = (await invoke("db/get", { key: HISTORY_KEY })).value;
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
}

export const fmtClock = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
