import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { Button, Modal } from "../ui";
import { invalidate, invoke } from "../../lib/rpc";
import { chapterOf, flush, isOpen, replaceContent, sceneName } from "../../stores/documents";
import type { RenamePreview, RenameResult } from "../../rpc.gen";
import "./RenameModal.css";

// Renaming a codex entry: every place the old name is written, scene by
// scene, to tick off before the manuscript is rewritten.

interface RenameModalProps {
  entityId: number;
  from: string;
  to: string;
  preview: RenamePreview;
  /** The rename landed (in the codex, and wherever the writer chose). */
  onDone: (result: RenameResult) => void;
  onClose: () => void;
}

const key = (path: string, start: number) => `${path}\u0000${start}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const RenameModal: Component<RenameModalProps> = (props) => {
  const all = props.preview.scenes.flatMap((s) => s.occurrences.map((o) => key(s.path, o.start)));
  const [chosen, setChosen] = createSignal(new Set(all));
  const [keepAlias, setKeepAlias] = createSignal(false);
  const [updateNotes, setUpdateNotes] = createSignal(props.preview.notes.length > 0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(chosen());
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    setChosen(next);
  };

  const run = async (everywhere: boolean) => {
    setBusy(true);
    setError("");
    try {
      // The backend rewrites the saved text; nothing typed may be lost.
      if (everywhere && !(await flush())) throw new Error("Couldn't save the open scenes first");
      const picked = everywhere
        ? props.preview.scenes
            .map((s) => ({ path: s.path, starts: s.occurrences.filter((o) => chosen().has(key(s.path, o.start))).map((o) => o.start) }))
            .filter((c) => c.starts.length > 0)
        : [];
      const res = await invoke("codex/rename_apply", {
        id: props.entityId,
        from: props.from,
        to: props.to,
        chosen: picked,
        keepAlias: keepAlias(),
        updateNotes: updateNotes(),
      });
      // Open scenes pick up the new text now rather than on the watcher's echo.
      for (const { path } of picked) {
        if (!isOpen(path)) continue;
        try {
          replaceContent(path, (await invoke("document/read", { path })).content);
        } catch { /* the watcher reconciles it */ }
      }
      invalidate("codex", "files", "meta");
      props.onDone(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const total = () => chosen().size;

  return (
    <Modal
      wide
      title={`Rename “${props.from}” to “${props.to}”?`}
      onClose={() => !busy() && props.onClose()}
      footer={
        <>
          <Show when={error()}><span class="rename-error">{error()}</span></Show>
          <Button variant="ghost" disabled={busy()} onClick={props.onClose}>Cancel</Button>
          <Button disabled={busy()} onClick={() => void run(false)} title="Change the name in the codex; leave the manuscript as it is">
            Rename in codex only
          </Button>
          <Button variant="primary" disabled={busy() || total() === 0} onClick={() => void run(true)}>
            {busy() ? "Renaming…" : "Rename everywhere"}
          </Button>
        </>
      }
    >
      <p class="rename-summary">
        “{props.from}” is written {plural(props.preview.total, "time")} in {plural(props.preview.scenes.length, "scene")}.
        <Show when={total() !== props.preview.total}> {total()} will change.</Show>
      </p>

      <div class="rename-scenes">
        <For each={props.preview.scenes}>
          {(scene) => {
            const keys = scene.occurrences.map((o) => key(scene.path, o.start));
            const picked = () => keys.filter((k) => chosen().has(k)).length;
            return (
              <div class="rename-scene">
                <label class="rename-scene-head">
                  <input
                    type="checkbox"
                    checked={picked() === keys.length}
                    onChange={(e) => toggle(keys, e.currentTarget.checked)}
                    ref={(el) => createEffect(() => { el.indeterminate = picked() > 0 && picked() < keys.length; })}
                  />
                  <span class="rename-scene-name">{sceneName(scene.path)}</span>
                  <span class="hint">{chapterOf(scene.path)}</span>
                  <span class="row-meta">{picked() === keys.length ? keys.length : `${picked()} of ${keys.length}`}</span>
                </label>
                <For each={scene.occurrences}>
                  {(o) => {
                    const k = key(scene.path, o.start);
                    return (
                      <label class="rename-hit" classList={{ skipped: !chosen().has(k) }} title={`Line ${o.line}`}>
                        <input type="checkbox" checked={chosen().has(k)} onChange={(e) => toggle([k], e.currentTarget.checked)} />
                        <span class="rename-snippet">
                          {o.before}
                          <del>{o.found}</del>
                          <ins>{o.replacement}</ins>
                          {o.after}
                        </span>
                      </label>
                    );
                  }}
                </For>
              </div>
            );
          }}
        </For>
      </div>

      <div class="rename-options">
        <label class="checkbox-row">
          <input type="checkbox" checked={keepAlias()} onChange={(e) => setKeepAlias(e.currentTarget.checked)} />
          Keep “{props.from}” as another name
        </label>
        <Show when={props.preview.notes.length > 0}>
          <label class="checkbox-row" title={props.preview.notes.map((n) => (n.kind === "entry" ? n.name : `${sceneName(n.name)} (synopsis)`)).join(", ")}>
            <input type="checkbox" checked={updateNotes()} onChange={(e) => setUpdateNotes(e.currentTarget.checked)} />
            Also update codex entries and scene synopses ({props.preview.notes.length})
          </label>
        </Show>
      </div>
    </Modal>
  );
};
