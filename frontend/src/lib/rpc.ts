import { createResource, createRoot, getOwner, type Resource } from "solid-js";
import { createStore } from "solid-js/store";

// The one door to the backend: request/response calls, backend-pushed
// events, and topic-based invalidation so views refetch when the data they
// show changes (instead of prop-drilled "version" counters).

import type { NoParams, Rpc, RpcEvent, RpcEventMethod, RpcEventParams } from "../rpc.gen";

type ParamsArg<M extends keyof Rpc> = Rpc[M]["params"] extends NoParams ? [params?: Rpc[M]["params"]] : [params: Rpc[M]["params"]];

/** Typed call into the backend (method table generated from the Rust side). */
export const invoke = <M extends keyof Rpc>(method: M, ...params: ParamsArg<M>): Promise<Rpc[M]["result"]> =>
  window.chronicler.invoke(method, params[0] ?? ({} as Rpc[M]["params"]));

// ---- Backend events ----

type Handler = (params: any) => void;
const handlers = new Map<string, Set<Handler>>();

/** Subscribe to a backend notification. A trailing `*` matches a prefix. Returns an unsubscribe. */
export function onBackend<M extends RpcEventMethod>(method: M, handler: (params: RpcEventParams<M>) => void): () => void;
export function onBackend(method: `${string}*`, handler: (params: RpcEvent["params"] & { method: RpcEventMethod }) => void): () => void;
export function onBackend(method: string, handler: Handler): () => void {
  let set = handlers.get(method);
  if (!set) handlers.set(method, (set = new Set()));
  set.add(handler);
  return () => set!.delete(handler);
}

let started = false;
export function startEventBus() {
  if (started) return;
  started = true;
  window.chronicler.onEvent((event: RpcEvent) => {
    const params: any = event.params ?? {};
    handlers.get(event.method)?.forEach((h) => h(params));
    for (const [key, set] of handlers) {
      if (key.endsWith("*") && event.method.startsWith(key.slice(0, -1))) set.forEach((h) => h({ ...params, method: event.method }));
    }
  });
}

// ---- Invalidation topics ----

export type Topic =
  | "files" // the manuscript tree (create/rename/delete/order)
  | "meta" // scene synopsis/status
  | "codex" // entities, aliases, candidates
  | "history"
  | "diags" // spelling/grammar/agent findings
  | "critique"
  | "timeline"
  | "graph"
  | "stats"
  | "settings";

const [versions, setVersions] = createStore<Record<Topic, number>>({
  files: 0, meta: 0, codex: 0, history: 0, diags: 0, critique: 0, timeline: 0, graph: 0, stats: 0, settings: 0,
});

/** Reactive read of a topic's version (use inside effects/memos to track it). */
export const topicVersion = (t: Topic) => versions[t];

export function invalidate(...topics: Topic[]) {
  for (const t of topics) setVersions(t, (v) => v + 1);
}

/**
 * A resource that refetches whenever any of `topics` is invalidated (or the
 * optional `key` changes). Read `.latest` to keep showing old data while it
 * refreshes.
 */
export function createQuery<T, K = true>(
  topics: Topic[],
  fetcher: (key: K) => Promise<T>,
  key?: () => K | null | undefined | false,
): Resource<T> {
  // Module-level queries live for the app's lifetime in their own root.
  if (!getOwner()) return createRoot(() => createQuery(topics, fetcher, key));
  const [resource] = createResource(
    () => {
      const k = key ? key() : (true as K);
      if (k === null || k === undefined || k === false) return false;
      return { k, v: topics.map((t) => versions[t]).join(":") };
    },
    (src) => fetcher(src.k),
  );
  return resource;
}

// Backend pushes that map straight onto topics.
export function wireTopics() {
  onBackend("history/changed", () => invalidate("history"));
  onBackend("codex/changed", () => invalidate("codex"));
  onBackend("project/changed", () => invalidate("files", "stats"));
}
