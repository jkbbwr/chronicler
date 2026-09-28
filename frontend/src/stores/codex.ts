import { createMemo, createRoot, createSignal } from "solid-js";
import { createQuery, invoke } from "../lib/rpc";
import { setMode } from "./workbench";
import type { EntityRef } from "../components/editor/entityLinks";

// The codex (world bible): entity list, name matching for the editor, and
// what Codex mode is showing.

export interface Entity {
  id: number;
  name: string;
  kind: string;
  summary: string;
  aliases: string[];
  mentionCount: number;
  [key: string]: unknown;
}

// App-lifetime computations live in their own root.
const codexData = createRoot(() => {
  const entities = createQuery(["codex"], async () => {
    try {
      return (await invoke("codex/list")).entities;
    } catch {
      return [] as Entity[];
    }
  });

  /** Names and aliases for in-editor matching, longest-first. */
  const entityRefs = createMemo<EntityRef[]>(() => {
    const refs: EntityRef[] = [];
    for (const e of entities.latest ?? []) {
      const base = { id: e.id, name: e.name, kind: e.kind, summary: e.summary, mentions: e.mentionCount };
      refs.push({ pattern: e.name.toLowerCase(), display: e.name, ...base });
      for (const a of e.aliases ?? []) refs.push({ pattern: a.toLowerCase(), display: a, ...base });
    }
    return refs.filter((r) => r.pattern.length >= 2).sort((a, b) => b.pattern.length - a.pattern.length);
  });
  return { entities, entityRefs };
});

export const entities = codexData.entities;
/** Names and aliases for in-editor matching, longest-first. */
export const entityRefs = codexData.entityRefs;

export type CodexSelection = { kind: "entity"; id: number } | { kind: "inbox" } | null;
export const [codexSelection, setCodexSelection] = createSignal<CodexSelection>(null);

/** A name the writer wants to add (from a selection), pre-filled in Codex mode. */
export const [codexDraft, setCodexDraft] = createSignal<{ name: string; line: number } | null>(null);

export function openEntity(id: number) {
  setCodexSelection({ kind: "entity", id });
  setMode("codex");
}

export function openInbox() {
  setCodexSelection({ kind: "inbox" });
  setMode("codex");
}
