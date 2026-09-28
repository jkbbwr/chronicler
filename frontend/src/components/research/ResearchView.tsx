import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { File, FileText, Globe, Image, Newspaper, Plus, Upload } from "lucide-solid";
import { Button, Empty, Modal } from "../ui";
import { createQuery, invalidate, invoke } from "../../lib/rpc";
import { revealLabel } from "../../lib/project";
import { notify, notifyError, withProgress } from "../../stores/app";
import { forget, retarget } from "../../stores/documents";
import type { ResearchItem, ResearchKind } from "../../rpc.gen";
import { formatSize, hostOf } from "./research";
import "./ResearchView.css";

// The Research tab of the binder drawer: everything in the project's
// Research folder, grouped by kind. Never part of the manuscript.

const GROUPS: { kind: ResearchKind; label: string }[] = [
  { kind: "note", label: "Notes" },
  { kind: "clipping", label: "Clippings" },
  { kind: "image", label: "Images" },
  { kind: "pdf", label: "PDFs" },
  { kind: "other", label: "Other" },
];

export const KindIcon: Component<{ kind: ResearchKind; size?: number }> = (props) => {
  const size = () => props.size ?? 14;
  switch (props.kind) {
    case "note":
      return <FileText size={size()} />;
    case "clipping":
      return <Newspaper size={size()} />;
    case "image":
      return <Image size={size()} />;
    case "pdf":
      return <File size={size()} />;
    default:
      return <File size={size()} />;
  }
};

type Prompt =
  | { type: "clip" }
  | { type: "note" }
  | { type: "rename"; item: ResearchItem };

const MENU_W = 200;
const MENU_H = 150;

export const ResearchView: Component<{
  /** Show one item (the reference pane). */
  onOpen: (path: string) => void;
  /** The item currently shown, highlighted in the list. */
  activePath?: string | null;
}> = (props) => {
  const items = createQuery(["files"], () => invoke("research/list"));
  const list = () => items.latest?.items ?? [];
  const byKind = (kind: ResearchKind) => list().filter((i) => i.kind === kind);

  const [menu, setMenu] = createSignal<{ x: number; y: number; item: ResearchItem } | null>(null);
  const [prompt, setPrompt] = createSignal<Prompt | null>(null);
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    onCleanup(() => window.removeEventListener("click", close));
  });

  const opened = (path: string) => {
    invalidate("files");
    props.onOpen(path);
  };

  const addFiles = async () => {
    const r = await window.chronicler.researchImport();
    if (r.errors.length) notify(`Couldn't add ${r.errors.join("; ")}`, "error");
    if (r.paths.length) {
      invalidate("files");
      notify(r.paths.length === 1 ? "Added to Research" : `Added ${r.paths.length} files to Research`);
      props.onOpen(r.paths[r.paths.length - 1]);
    }
  };

  const openPrompt = (p: Prompt) => {
    setValue(p.type === "rename" ? p.item.name : "");
    setPrompt(p);
  };

  const submit = async () => {
    const p = prompt();
    const v = value().trim();
    if (!p || !v || busy()) return;
    setBusy(true);
    try {
      if (p.type === "clip") {
        setPrompt(null);
        const r = await withProgress("Clipping the page…", () => invoke("research/clip", { url: v }));
        if (r) {
          notify(`Clipped “${r.title}”`);
          opened(r.path);
        }
      } else if (p.type === "note") {
        const r = await invoke("research/new_note", { name: v });
        setPrompt(null);
        opened(r.path);
      } else {
        const from = p.item.path;
        const dir = from.slice(0, from.lastIndexOf("/"));
        const keepExt = p.item.kind === "note" || p.item.kind === "clipping" ? from.slice(from.lastIndexOf(".")) : "";
        const name = v.replace(/[/\\:]/g, "-").replace(/^\.+/, "");
        const to = `${dir}/${name}${keepExt}`;
        if (!name || to === from) {
          setPrompt(null);
          return;
        }
        await invoke("project/rename", { from, to });
        retarget(from, to);
        setPrompt(null);
        invalidate("files");
      }
    } catch (err) {
      notifyError(p.type === "note" ? "Couldn't create the note" : p.type === "rename" ? "Couldn't rename" : "Couldn't clip the page", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: ResearchItem) => {
    const r = await window.chronicler.showMessageBox({
      type: "warning",
      buttons: ["Move to Trash", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Delete “${item.name}”?`,
      detail: "It goes to the Trash, where you can still recover it.",
    });
    if (r.response !== 0) return;
    try {
      await invoke("project/delete", { path: item.path });
      forget(item.path);
      invalidate("files");
    } catch (err) {
      notifyError("Couldn't delete", err);
    }
  };

  const reveal = async (path: string) => {
    const r = await window.chronicler.revealInFileManager(path);
    if (r?.error) notifyError("Couldn't reveal", r.error);
  };

  const act = (e: MouseEvent, action: () => void) => {
    e.stopPropagation();
    setMenu(null);
    action();
  };

  const meta = (item: ResearchItem) => (item.source ? hostOf(item.source) : item.kind === "note" ? "" : formatSize(item.size));

  return (
    <div class="research-view">
      <div class="research-actions">
        <Button size="sm" onClick={() => void addFiles()} title="Copy pictures, maps, PDFs or notes into the Research folder">
          <Upload size={13} /> Add files…
        </Button>
        <Button size="sm" onClick={() => openPrompt({ type: "clip" })} title="Save the text of a web article">
          <Globe size={13} /> Clip a page…
        </Button>
        <Button size="sm" onClick={() => openPrompt({ type: "note" })}>
          <Plus size={13} /> New note
        </Button>
      </div>

      <div class="research-list">
        <Show
          when={list().length > 0}
          fallback={
            <Show when={!items.loading || items.latest}>
              <Empty title="No research yet">
                <p class="hint">
                  Keep maps, pictures, PDFs, web articles and notes here. They sit beside your book but are never part of it — not
                  compiled, counted or checked.
                </p>
              </Empty>
            </Show>
          }
        >
          <For each={GROUPS.filter((g) => byKind(g.kind).length > 0)}>
            {(g) => (
              <div class="research-group">
                <div class="section-label">
                  {g.label}
                  <span class="count-badge">{byKind(g.kind).length}</span>
                </div>
                <For each={byKind(g.kind)}>
                  {(item) => (
                    <div
                      class="list-row research-row"
                      classList={{ active: props.activePath === item.path }}
                      title={item.path}
                      onClick={() => props.onOpen(item.path)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenu({ x: e.clientX, y: e.clientY, item });
                      }}
                    >
                      <span class="research-icon">
                        <KindIcon kind={item.kind} />
                      </span>
                      <span class="research-name">{item.name}</span>
                      <span class="row-meta">{meta(item)}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>

      <Show when={menu()}>
        {(m) => (
          <div
            class="menu"
            style={{ left: `${Math.min(m().x, window.innerWidth - MENU_W - 8)}px`, top: `${Math.min(m().y, window.innerHeight - MENU_H - 8)}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="menu-item" onClick={(e) => act(e, () => props.onOpen(m().item.path))}>Open</div>
            <div class="menu-item" onClick={(e) => act(e, () => openPrompt({ type: "rename", item: m().item }))}>Rename…</div>
            <div class="menu-item" onClick={(e) => act(e, () => void reveal(m().item.path))}>{revealLabel}</div>
            <div class="menu-sep" />
            <div class="menu-item danger" onClick={(e) => act(e, () => void remove(m().item))}>Delete…</div>
          </div>
        )}
      </Show>

      <Show when={prompt()}>
        {(p) => (
          <Modal
            title={p().type === "clip" ? "Clip a web page" : p().type === "note" ? "New research note" : "Rename"}
            onClose={() => setPrompt(null)}
            footer={
              <>
                <Button variant="ghost" onClick={() => setPrompt(null)}>Cancel</Button>
                <Button variant="primary" disabled={!value().trim() || busy()} onClick={() => void submit()}>
                  {p().type === "clip" ? "Clip" : p().type === "note" ? "Create" : "Rename"}
                </Button>
              </>
            }
          >
            <form
              class="field"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label for="research-prompt">{p().type === "clip" ? "Web address" : "Name"}</label>
              <input
                id="research-prompt"
                class="input"
                ref={(el) => setTimeout(() => el.focus())}
                type={p().type === "clip" ? "url" : "text"}
                placeholder={p().type === "clip" ? "https://…" : p().type === "note" ? "e.g. Harbour people" : ""}
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
              />
              <Show when={p().type === "clip"}>
                <p class="hint">Chronicler saves the article's text (not ads or menus) as a clipping in Research, with a link back to the page.</p>
              </Show>
            </form>
          </Modal>
        )}
      </Show>
    </div>
  );
};
