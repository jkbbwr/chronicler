import { type Component, createSignal, Show } from "solid-js";
import { Button, Modal } from "../ui";
import { invalidate, invoke } from "../../lib/rpc";
import { notify, notifyError } from "../../stores/app";
import { flush } from "../../stores/documents";

// Name the working draft and start a new one, from anywhere.

const [open, setOpen] = createSignal(false);
export const openLockIn = () => setOpen(true);

export const LockInPrompt: Component = () => {
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    const message = name().trim();
    if (!message || busy()) return;
    setBusy(true);
    try {
      await flush(); // lock in what's on screen, not what was last autosaved
      const res = await invoke("history/lock_in", { message });
      if (res.locked) {
        notify(`Locked in “${message}”`, "success");
        setName("");
        setOpen(false);
        invalidate("history");
      } else {
        notify(res.reason ?? "Nothing to lock in");
      }
    } catch (err) {
      notifyError("Lock in failed", err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={open()}>
      <Modal
        title="Lock in this version"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name().trim() || busy()} onClick={() => void submit()}>Lock in</Button>
          </>
        }
      >
        <p class="hint" style={{ "margin-top": 0 }}>
          Every save is already kept. Locking in names this point so you can find it, compare against it, or go back to it.
        </p>
        <input
          class="input"
          placeholder="e.g. First draft, After beta readers…"
          value={name()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
      </Modal>
    </Show>
  );
};
