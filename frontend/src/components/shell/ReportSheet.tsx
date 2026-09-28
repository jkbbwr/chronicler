import { type Component, createSignal, Show } from "solid-js";
import { Modal } from "../ui";
import { renderMarkdown, parseSceneHref } from "../../lib/markdown";
import { setMode } from "../../stores/workbench";
import { openScene } from "../../stores/documents";

// A readable sheet for agent reports (voice analysis and the like).

const [report, setReport] = createSignal<{ title: string; markdown: string } | null>(null);

export const showReport = (title: string, markdown: string) => setReport({ title, markdown });

export const ReportSheet: Component = () => (
  <Show when={report()}>
    <Modal title={report()!.title} wide onClose={() => setReport(null)}>
      <div
        class="agent-md report-body selectable"
        innerHTML={renderMarkdown(report()!.markdown)}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (!a) return;
          e.preventDefault();
          const target = parseSceneHref(a.getAttribute("href") ?? "");
          if (target) {
            setReport(null);
            setMode("write");
            void openScene(target.path, target.line ? { line: target.line } : undefined);
          }
        }}
      />
    </Modal>
  </Show>
);
