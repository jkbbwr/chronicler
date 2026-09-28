import { type Component, createSignal, Match, Switch } from "solid-js";
import { CodexView } from "../sidebar/CodexView";
import { EntitySheet } from "../center/EntitySheet";
import { InboxView } from "../center/InboxView";
import { Button, Empty, Resizer } from "../ui";
import { codexDraft, codexSelection, openEntity, openInbox, setCodexDraft, setCodexSelection } from "../../stores/codex";
import { setMode, setWorkbench } from "../../stores/workbench";
import { openScene, scene } from "../../stores/documents";
import { invalidate, topicVersion } from "../../lib/rpc";
import { notify } from "../../stores/app";
import { voiceReport } from "../../lib/agentActions";
import { showReport } from "../shell/ReportSheet";

// Codex: the world bible as pages — every character, place and thing, and
// the inbox of names the manuscript has surfaced.

const writeAt = (file: string, line: number) => {
  setMode("write");
  void openScene(file, { line });
};

export const CodexMode: Component = () => {
  const [indexWidth, setIndexWidth] = createSignal(280);
  const selection = codexSelection;
  return (
    <div class="mode-surface codex-mode">
      <aside class="side side-left" style={{ width: `${indexWidth()}px` }}>
        <div class="side-body">
          <CodexView
            activeFile={scene()}
            refreshVersion={topicVersion("codex")}
            promoteDraft={codexDraft()}
            onDraftHandled={() => setCodexDraft(null)}
            onOpenEntity={(id) => openEntity(id)}
            onOpenInbox={openInbox}
            onStatus={notify}
          />
        </div>
      </aside>
      <Resizer side="left" width={indexWidth()} min={220} max={440} onResize={setIndexWidth} />
      <main class="codex-main">
        <Switch fallback={
          <Empty title="The codex">
            <p>Pick someone or somewhere on the left, or review the names the manuscript has surfaced.</p>
            <div style={{ display: "flex", gap: "8px", "justify-content": "center" }}>
              <Button onClick={openInbox}>Review discovered names</Button>
              <Button variant="ghost" onClick={() => { setWorkbench({ mode: "plan", planView: "graph" }); }}>Relationships</Button>
            </div>
          </Empty>
        }>
          <Match when={selection()?.kind === "entity" && selection() as { kind: "entity"; id: number }} keyed>
            {(sel) => (
              <EntitySheet
                entityId={sel.id}
                refreshVersion={topicVersion("codex")}
                onTitleChange={() => invalidate("codex")}
                onOpenFile={writeAt}
                onStatus={notify}
                onDeleted={() => { setCodexSelection(null); invalidate("codex"); }}
                onVoiceReport={async (id, name) => {
                  const md = await voiceReport(id, name);
                  if (md) showReport(`${name}'s voice`, md);
                }}
              />
            )}
          </Match>
          <Match when={selection()?.kind === "inbox"}>
            <InboxView
              activeFile={scene()}
              refreshVersion={topicVersion("codex")}
              onStatus={notify}
              onChanged={() => invalidate("codex")}
              onOpenEntity={(id) => openEntity(id)}
              onOpenFile={writeAt}
            />
          </Match>
        </Switch>
      </main>
    </div>
  );
};

