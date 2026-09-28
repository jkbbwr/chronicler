import { type Component, createSignal, Show } from "solid-js";
import { BinderView } from "../sidebar/BinderView";
import { SearchView } from "../sidebar/SearchView";
import { ResearchView } from "../research/ResearchView";
import { Resizer, Tabs } from "../ui";
import { setWorkbench, workbench } from "../../stores/workbench";
import { notify, project, projectName } from "../../stores/app";
import { openScene, reference, scene, setReference } from "../../stores/documents";
import { topicVersion } from "../../lib/rpc";
import { deletePath, mergeWithNext, newFolder, newScene, renamePath, revealInFileManager } from "../../lib/fileOps";
import { runContinuity } from "../../lib/agentActions";

// The manuscript drawer (Write and Review): the binder, project search, or
// the Research folder (shown beside the text, never part of the book).

type DrawerTab = "binder" | "search" | "research";
export const [drawerTab, setDrawerTab] = createSignal<DrawerTab>("binder");

const [createTrigger, setCreateTrigger] = createSignal<"file" | "folder" | null>(null);

/** Start creating a scene or folder inline in the binder. */
export function triggerCreate(kind: "file" | "folder") {
  setWorkbench("layout", "binderOpen", true);
  setDrawerTab("binder");
  setCreateTrigger(kind);
  setTimeout(() => setCreateTrigger(null), 100);
}

export function openSearchDrawer() {
  setWorkbench("layout", "binderOpen", true);
  setDrawerTab("search");
}

export function openResearchDrawer() {
  setWorkbench("layout", "binderOpen", true);
  setDrawerTab("research");
}

export const BinderDrawer: Component = () => (
  <>
    <aside class="side side-left" style={{ width: `${workbench.layout.binderWidth}px` }}>
      <div class="side-header">
        <Tabs
          value={drawerTab()}
          options={[
            { value: "binder", label: "Manuscript" },
            { value: "search", label: "Search" },
            { value: "research", label: "Research" },
          ]}
          onChange={setDrawerTab}
        />
      </div>
      <div class="side-body">
        <Show when={drawerTab() === "binder"}>
          <BinderView
            activeFile={scene() ?? ""}
            createTrigger={createTrigger()}
            refreshVersion={topicVersion("files") + topicVersion("meta")}
            projectName={projectName()}
            projectPath={project.root ?? undefined}
            onReveal={revealInFileManager}
            onFileSelect={(f) => void openScene(f)}
            onNewFile={(name) => void newScene(name)}
            onNewFolder={(name) => void newFolder(name)}
            onRename={(a, b) => void renamePath(a, b)}
            onDelete={(p) => void deletePath(p)}
            onCheckContinuity={(file) => void runContinuity(file)}
            onMergeNext={(file) => void mergeWithNext(file)}
          />
        </Show>
        <Show when={drawerTab() === "search"}>
          <SearchView onOpenResult={(file, line) => void openScene(file, { line })} onStatus={notify} />
        </Show>
        <Show when={drawerTab() === "research"}>
          {/* Refreshes on the "files" topic, which project/changed also bumps. */}
          <ResearchView activePath={reference()} onOpen={(path) => setReference(path)} />
        </Show>
      </div>
    </aside>
    <Resizer side="left" width={workbench.layout.binderWidth} min={200} max={480} onResize={(w) => setWorkbench("layout", "binderWidth", w)} />
  </>
);
