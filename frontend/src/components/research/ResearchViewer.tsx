import { type Component, createEffect, createSignal, Match, on, Show, Switch } from "solid-js";
import { ExternalLink, FolderOpen, X } from "lucide-solid";
import { Empty, IconButton } from "../ui";
import { createQuery, invoke, topicVersion } from "../../lib/rpc";
import { parseSceneHref, renderMarkdown } from "../../lib/markdown";
import { revealLabel } from "../../lib/project";
import { notifyError } from "../../stores/app";
import { openScene } from "../../stores/documents";
import { clippingSource, hostOf, KIND_LABEL, researchKind, researchName, researchUrl } from "./research";
import { KindIcon } from "./ResearchView";
import "./ResearchViewer.css";

export { isEditableNote, isResearchPath, researchKind } from "./research";

// One research item beside the text: a picture, a PDF, or a note/clipping
// rendered as reading text. Read-only; notes can be opened in an editor by
// the caller instead (see `isEditableNote`).

const openExternal = (href: string) => window.open(href, "_blank");

export const ResearchViewer: Component<{
  /** Project-relative path inside Research/. */
  path: string;
  /** Shows a close button in the header when given. */
  onClose?: () => void;
}> = (props) => {
  const kind = () => researchKind(props.path);
  const isText = () => kind() === "note" || kind() === "clipping";

  const text = createQuery(
    ["files"],
    (path: string) => invoke("research/read", { path }).then((r) => r.text),
    () => (isText() ? props.path : null),
  );
  const source = () => (kind() === "clipping" && text.latest ? clippingSource(text.latest) : null);

  // Images show fitted; a click toggles actual size.
  const [actual, setActual] = createSignal(false);
  createEffect(on(() => props.path, () => setActual(false)));

  const reveal = async () => {
    const r = await window.chronicler.revealInFileManager(props.path);
    if (r?.error) notifyError("Couldn't reveal", r.error);
  };

  const onLinkClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    const scene = parseSceneHref(href);
    if (scene) void openScene(scene.path, scene.line ? { line: scene.line } : undefined);
    else if (/^https?:/i.test(href)) openExternal(href);
  };

  return (
    <div class="research-viewer">
      <header class="research-viewer-header">
        <span class="research-viewer-icon">
          <KindIcon kind={kind()} size={15} />
        </span>
        <div class="research-viewer-title">
          <span class="research-viewer-name" title={props.path}>{researchName(props.path)}</span>
          <span class="research-viewer-kind">
            {KIND_LABEL[kind()]}
            <Show when={source()}>
              {(s) => (
                <>
                  {" · from "}
                  <a href={s()} class="research-viewer-source" onClick={(e) => { e.preventDefault(); openExternal(s()); }} title={s()}>
                    {hostOf(s())}
                  </a>
                </>
              )}
            </Show>
          </span>
        </div>
        <Show when={source()}>
          {(s) => (
            <IconButton label="Open the original page" onClick={() => openExternal(s())}>
              <ExternalLink size={14} />
            </IconButton>
          )}
        </Show>
        <IconButton label={revealLabel} onClick={() => void reveal()}>
          <FolderOpen size={14} />
        </IconButton>
        <Show when={props.onClose}>
          <IconButton label="Close" onClick={() => props.onClose!()}>
            <X size={14} />
          </IconButton>
        </Show>
      </header>

      <div class="research-viewer-body">
        <Switch>
          <Match when={kind() === "image"}>
            <div class="research-image" classList={{ actual: actual() }} onClick={() => setActual((v) => !v)}>
              <img
                src={researchUrl(props.path, topicVersion("files"))}
                alt={researchName(props.path)}
                title={actual() ? "Click to fit" : "Click for actual size"}
                draggable={false}
              />
            </div>
          </Match>
          <Match when={kind() === "pdf"}>
            <iframe class="research-pdf" src={researchUrl(props.path)} title={researchName(props.path)} />
          </Match>
          <Match when={isText()}>
            <Show
              when={text.latest !== undefined}
              fallback={
                <Show when={text.error}>
                  <Empty title="Couldn't open this">
                    <p class="hint">{String(text.error?.message ?? text.error)}</p>
                  </Empty>
                </Show>
              }
            >
              <div class="markdown-preview research-text selectable" innerHTML={renderMarkdown(text.latest ?? "")} onClick={onLinkClick} />
            </Show>
          </Match>
          <Match when={kind() === "other"}>
            <Empty title="Chronicler can't show this kind of file">
              <p class="hint">It's kept safe in your Research folder. Open it from Finder with the app it belongs to.</p>
              <button type="button" class="btn btn-secondary" onClick={() => void reveal()}>
                {revealLabel}
              </button>
            </Empty>
          </Match>
        </Switch>
      </div>
    </div>
  );
};
