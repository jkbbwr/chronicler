import { type Component, createSignal, For, Show } from "solid-js";
import { Download, ScanSearch, Sparkles, X } from "lucide-solid";
import { KINDS } from "../sidebar/CodexView";
import { Button, Empty } from "../ui";
import { createQuery, invalidate, invoke } from "../../lib/rpc";
import { entities } from "../../stores/codex";
import { sceneName } from "../../stores/documents";
import "./CodexPage.css";

// Discovered: names the manuscript has turned up (from the name finder, AI
// reads, and your own selections), waiting for a yes or no. Nothing enters
// the codex until you approve it.

interface ContextRef { file: string; line: number; text: string }

interface CandidateRow {
  name: string;
  kindGuess: string;
  count: number;
  files: string[];
  contexts: ContextRef[];
  source: string;
  summary: string;
}

const SOURCE_LABEL: Record<string, string> = { ner: "name finder", llm: "AI read", ai: "AI read", manual: "you", hygiene: "codex check" };

interface InboxViewProps {
  activeFile: string | null;
  refreshVersion: number;
  onStatus: (message: string) => void;
  /** Bump shared codex state after changes. */
  onChanged: () => void;
  onOpenEntity: (id: number, title: string) => void;
  onOpenFile: (file: string, line: number) => void;
}

const candidates = createQuery(["codex"], async () => {
  try {
    return (await invoke("codex/candidates")).candidates;
  } catch {
    return [] as CandidateRow[];
  }
});

const finder = createQuery(["codex"], async () => {
  try {
    return await invoke("ner/status");
  } catch {
    return { ready: false };
  }
});

const defaultKind = (c: CandidateRow) => ((KINDS as readonly string[]).includes(c.kindGuess) ? c.kindGuess : "character");

export const InboxView: Component<InboxViewProps> = (props) => {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [kindChoice, setKindChoice] = createSignal<Record<string, string>>({});

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      props.onStatus(await fn());
    } catch (err) {
      props.onStatus(`${label} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
      props.onChanged();
    }
  };

  const setupFinder = () => run("Setting up the name finder", async () => {
    await invoke("ner/ensure");
    return "Name finder ready";
  });

  const scanBook = () => run("Looking for names", async () => {
    const res = await invoke("codex/scan", {});
    return `Found ${res.newCandidates} new name(s) across ${res.scanned} scene(s)`;
  });

  const aiRead = () => run("AI read", async () => {
    if (!props.activeFile) throw new Error("open a scene first");
    const res = await invoke("ai/scan", { path: props.activeFile });
    return `AI read: ${res.newCandidates} new name(s), ${res.aliasesAdded} alias(es) attached`;
  });

  const promote = async (c: CandidateRow, opts: { asAliasOf?: number; edit?: boolean } = {}) => {
    try {
      const kind = kindChoice()[c.name] ?? defaultKind(c);
      const res = await invoke("codex/promote", { name: c.name, kind, summary: c.summary ?? "", asAliasOf: opts.asAliasOf });
      invalidate("codex");
      if ("created" in res && opts.edit) props.onOpenEntity(res.created, c.name);
      else if ("created" in res) props.onStatus(`“${c.name}” added to the codex`);
      else if (opts.asAliasOf) props.onStatus(`“${c.name}” added as another name`);
    } catch (err) {
      props.onStatus(`Couldn't add it: ${err instanceof Error ? err.message : err}`);
    }
  };

  const dismiss = async (name: string) => {
    await invoke("codex/dismiss", { name });
    invalidate("codex");
  };

  return (
    <div class="codex-page">
      <header class="codex-page-header">
        <div>
          <h1 class="codex-page-title">Discovered</h1>
          <p class="hint">Names the manuscript has turned up. Nothing enters the codex until you say so.</p>
        </div>
        <div class="codex-page-actions">
          <Show when={finder.latest?.ready} fallback={
            <Button variant="primary" disabled={!!busy()} onClick={() => void setupFinder()}><Download size={13} /> Set up name finder (110 MB)</Button>
          }>
            <Button disabled={!!busy()} onClick={() => void scanBook()}><ScanSearch size={13} /> Find names in the book</Button>
          </Show>
          <Button disabled={!!busy() || !props.activeFile} onClick={() => void aiRead()} title="Ask the AI to read the open scene for names (uses AI credits)">
            <Sparkles size={13} /> AI read this scene
          </Button>
        </div>
      </header>
      <Show when={busy()}><p class="hint codex-busy">{busy()}…</p></Show>

      <Show when={(candidates.latest ?? []).length > 0} fallback={
        <Empty title="Inbox zero">Keep writing — new names show up here. Or select a name in the text and press ⌘⇧K.</Empty>
      }>
        <For each={candidates.latest ?? []}>
          {(c) => {
            const ctx = () => c.contexts[0];
            const canOpen = () => !!ctx() && !!ctx()!.file && ctx()!.line > 0;
            return (
              <article class="candidate">
                <div class="candidate-head">
                  <span class="candidate-name">{c.name}</span>
                  <span class="hint">
                    from {SOURCE_LABEL[c.source] ?? c.source} · {c.count} scene{c.count === 1 ? "" : "s"} · {c.files.slice(0, 3).map(sceneName).join(", ")}{c.files.length > 3 ? "…" : ""}
                  </span>
                </div>
                <Show when={c.summary}><p class="candidate-summary">{c.summary}</p></Show>
                <Show when={ctx()?.text}>
                  <blockquote
                    class="candidate-context"
                    classList={{ link: canOpen() }}
                    title={canOpen() ? `Open ${sceneName(ctx()!.file)} at this line` : undefined}
                    onClick={() => { if (canOpen()) props.onOpenFile(ctx()!.file, ctx()!.line); }}
                  >
                    {ctx()!.text}
                  </blockquote>
                </Show>
                <div class="candidate-actions">
                  <select class="input candidate-kind" value={kindChoice()[c.name] ?? defaultKind(c)} onChange={(ev) => setKindChoice((k) => ({ ...k, [c.name]: ev.currentTarget.value }))}>
                    <For each={[...KINDS]}>{(k) => <option value={k}>{k}</option>}</For>
                  </select>
                  <Button size="sm" variant="primary" onClick={() => void promote(c)}>Add to codex</Button>
                  <Button size="sm" onClick={() => void promote(c, { edit: true })}>Add and open</Button>
                  <select
                    class="input candidate-alias"
                    onChange={(ev) => {
                      const id = parseInt(ev.currentTarget.value, 10);
                      if (!Number.isNaN(id)) void promote(c, { asAliasOf: id });
                      ev.currentTarget.value = "";
                    }}
                  >
                    <option value="">Another name for…</option>
                    <For each={entities.latest ?? []}>{(e) => <option value={e.id}>{e.name}</option>}</For>
                  </select>
                  <div style={{ flex: 1 }} />
                  <Button size="sm" variant="ghost" onClick={() => void dismiss(c.name)} title="Don't suggest this again"><X size={12} /> Not a name</Button>
                </div>
              </article>
            );
          }}
        </For>
      </Show>
    </div>
  );
};
