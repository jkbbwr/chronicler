import { type Component, createSignal, For, Show } from "solid-js";
import { RefreshCw } from "lucide-solid";
import { Empty, IconButton } from "../../ui";
import { createQuery, invoke } from "../../../lib/rpc";
import { openScene, sceneName } from "../../../stores/documents";
import { setMode } from "../../../stores/workbench";
import type { ProseReport as Report } from "../../../rpc.gen";
import "./ProseReport.css";

// The whole-book prose report: crutch words, the writer's own most
// repeated words, and sentence rhythm scene by scene. All local, no AI.

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

const goTo = (file: string, line?: number) => {
  setMode("write");
  void openScene(file, line ? { line } : undefined);
};

export const ProseReport: Component = () => {
  // Bumped by the refresh button; the report also refreshes after checks.
  const [round, setRound] = createSignal(1);
  const report = createQuery<Report | null, number>(
    ["diags", "files"],
    async () => {
      try {
        return await invoke("diag/prose_report");
      } catch {
        return null;
      }
    },
    round,
  );
  const data = () => report.latest;
  const maxStdev = () => Math.max(1, ...(data()?.scenes ?? []).map((s) => s.stdev));

  return (
    <div class="report-page selectable">
      <div class="prose-report">
        <header class="prose-report-head">
          <div>
            <h1>Prose report</h1>
            <Show when={data()}>
              {(r) => (
                <p class="hint">
                  {fmt(r().words)} words across {r().scenes.length} {r().scenes.length === 1 ? "scene" : "scenes"}.
                  Front and back matter aren't counted.
                </p>
              )}
            </Show>
          </div>
          <IconButton label="Count again" onClick={() => setRound((n) => n + 1)}>
            <RefreshCw size={14} />
          </IconButton>
        </header>

        <Show
          when={data()}
          fallback={
            <Show when={!report.loading} fallback={<Empty>Reading the book…</Empty>}>
              <Empty title="No report yet">Open a project with some scenes to see how the prose reads.</Empty>
            </Show>
          }
        >
          {(r) => (
            <Show when={r().words > 0} fallback={<Empty title="Nothing to count">Write a scene and come back.</Empty>}>
              <section class="prose-report-section">
                <h2>Crutch words</h2>
                <p class="hint">Common words and phrases that pad out prose. A few are fine; lots start to show.</p>
                <Show when={r().crutch.length > 0} fallback={<p class="hint">None found.</p>}>
                  <table class="prose-table">
                    <thead>
                      <tr><th>Word</th><th class="num">Uses</th><th class="num">Per 10,000 words</th></tr>
                    </thead>
                    <tbody>
                      <For each={r().crutch}>
                        {(c) => (
                          <tr><td class="prose-word">{c.word}</td><td class="num">{fmt(c.count)}</td><td class="num">{fmt(c.per10k)}</td></tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="prose-report-section">
                <h2>Your most repeated words</h2>
                <p class="hint">Words you reach for most often, leaving out everyday words and codex names. Click a place to go there.</p>
                <Show when={r().overused.length > 0} fallback={<p class="hint">No word stands out yet.</p>}>
                  <table class="prose-table">
                    <thead>
                      <tr><th>Word</th><th class="num">Uses</th><th class="num">Per 10,000</th><th>Where</th></tr>
                    </thead>
                    <tbody>
                      <For each={r().overused}>
                        {(o) => (
                          <tr>
                            <td class="prose-word">{o.word}</td>
                            <td class="num">{fmt(o.count)}</td>
                            <td class="num">{fmt(o.per10k)}</td>
                            <td class="prose-places">
                              <For each={o.examples}>
                                {(e) => (
                                  <button type="button" class="prose-place" title={`${e.file}, line ${e.line}`} onClick={() => goTo(e.file, e.line)}>
                                    {sceneName(e.file)} · {e.line}
                                  </button>
                                )}
                              </For>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>

              <section class="prose-report-section">
                <h2>Sentence rhythm</h2>
                <p class="hint">Average sentence length in each scene. A longer bar means the lengths vary more; a short one means they're all alike.</p>
                <div class="prose-rhythm">
                  <div class="prose-rhythm-row prose-rhythm-head">
                    <span>Scene</span><span class="num">Sentences</span><span class="num">Avg. words</span><span>Variety</span>
                  </div>
                  <For each={r().scenes}>
                    {(s) => (
                      <button type="button" class="prose-rhythm-row" title={s.file} onClick={() => goTo(s.file)}>
                        <span class="prose-scene">{sceneName(s.file)}</span>
                        <span class="num">{fmt(s.sentences)}</span>
                        <span class="num">{fmt(s.avgLength)}</span>
                        <span class="prose-bar" title={`Varies by about ${fmt(s.stdev)} words`}>
                          <span class="prose-bar-fill" style={{ width: `${(s.stdev / maxStdev()) * 100}%` }} />
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
};
