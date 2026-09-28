import { type Component, Show } from "solid-js";
import { IndexCardsView } from "../center/IndexCardsView";
import { TimelineView } from "../center/TimelineView";
import { GraphView } from "../center/GraphView";
import { ThreadsView } from "../center/ThreadsView";
import { Button, Empty, Segmented } from "../ui";
import { setMode, setWorkbench, workbench, type PlanView } from "../../stores/workbench";
import { openScene } from "../../stores/documents";
import { openEntity } from "../../stores/codex";
import { createQuery, invalidate, invoke, topicVersion } from "../../lib/rpc";
import { notify } from "../../stores/app";
import { renderMarkdown } from "../../lib/markdown";
import { updateLedger } from "../../lib/agentActions";

// Plan: the book from above — the corkboard, the story's timeline, who's
// connected to whom, and the facts the agent has on file.

const ledger = createQuery(["timeline"], async () => {
  try {
    return (await invoke("agents/facts", {})).markdown;
  } catch {
    return null;
  }
}, () => workbench.mode === "plan" && workbench.planView === "ledger");

const writeScene = (file: string) => {
  setMode("write");
  void openScene(file);
};

export const PlanMode: Component = () => (
  <div class="mode-surface plan-mode">
    <div class="plan-column">
      <div class="plan-bar">
        <Segmented<PlanView>
          value={workbench.planView}
          options={[
            { value: "cards", label: "Cards" },
            { value: "threads", label: "Threads" },
            { value: "timeline", label: "Timeline" },
            { value: "graph", label: "Relationships" },
            { value: "ledger", label: "Fact ledger" },
          ]}
          onChange={(v) => setWorkbench("planView", v)}
        />
      </div>
      <div class="plan-body">
        <Show when={workbench.planView === "cards"}>
          <IndexCardsView
            refreshVersion={topicVersion("files") + topicVersion("meta")}
            onOpenScene={writeScene}
            onStatus={notify}
            onMetaChanged={() => invalidate("meta")}
          />
        </Show>
        <Show when={workbench.planView === "threads"}>
          <ThreadsView onOpenScene={writeScene} />
        </Show>
        <Show when={workbench.planView === "timeline"}>
          <TimelineView refreshVersion={topicVersion("timeline")} onOpenScene={writeScene} onStatus={notify} />
        </Show>
        <Show when={workbench.planView === "graph"}>
          <GraphView refreshVersion={topicVersion("graph") + topicVersion("codex")} onOpenEntity={(id) => openEntity(id)} onStatus={notify} />
        </Show>
        <Show when={workbench.planView === "ledger"}>
          <Show
            when={ledger.latest}
            fallback={
              <Empty title="No facts on file yet">
                <p>The agent reads each scene and notes what it establishes — who was where, what they know, what changed.</p>
                <Button variant="primary" onClick={() => void updateLedger()}>Build the fact ledger</Button>
              </Empty>
            }
          >
            <div class="report-page selectable">
              <div class="report-actions">
                <Button size="sm" onClick={() => void updateLedger()}>Update</Button>
              </div>
              <div class="agent-md report-body" innerHTML={renderMarkdown(ledger.latest ?? "")} />
            </div>
          </Show>
        </Show>
      </div>
    </div>
  </div>
);
