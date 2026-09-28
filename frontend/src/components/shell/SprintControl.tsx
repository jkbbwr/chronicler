import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { Timer } from "lucide-solid";
import { Button, Modal } from "../ui";
import { finishSprint, fmtClock, sprint, sprintHistory, sprintRemaining, sprintWords, startSprint } from "../../stores/sprint";
import { setMode } from "../../stores/workbench";

// The footer's sprint control: idle, it offers a sprint; running, it's the
// countdown and the words so far (click to stop).

const LENGTHS = [10, 15, 25, 45, 60];

const [dialogOpen, setDialogOpen] = createSignal(false);
/** Open the sprint dialog (from the palette). */
export const openSprintDialog = () => setDialogOpen(true);

const SprintDialog: Component<{ onClose: () => void }> = (props) => {
  const [minutes, setMinutes] = createSignal(25);
  const [goal, setGoal] = createSignal(0);
  const [history] = createResource(sprintHistory);
  const best = () => Math.max(0, ...(history() ?? []).map((h) => Math.round(h.words / h.minutes * 60)));
  const start = () => {
    startSprint(minutes(), goal());
    setMode("write");
    props.onClose();
  };
  return (
    <Modal
      title="Writing sprint"
      onClose={props.onClose}
      footer={<><Button variant="ghost" onClick={props.onClose}>Cancel</Button><Button variant="primary" onClick={start}>Start</Button></>}
    >
      <div class="field">
        <label>How long</label>
        <div class="segmented">
          <For each={LENGTHS}>
            {(m) => <button type="button" class={minutes() === m ? "active" : ""} onClick={() => setMinutes(m)}>{m} min</button>}
          </For>
        </div>
      </div>
      <div class="field" style={{ "margin-top": "16px" }}>
        <label>Word goal (optional)</label>
        <input class="input" type="number" min="0" step="50" style={{ width: "140px" }} value={goal() || ""} placeholder="none" onInput={(e) => setGoal(Math.max(0, +e.currentTarget.value || 0))} />
      </div>
      <Show when={(history() ?? []).length > 0}>
        <p class="hint" style={{ "margin-top": "16px" }}>
          {history()!.length} sprint{history()!.length === 1 ? "" : "s"} so far · best pace about {best().toLocaleString()} words an hour.
        </p>
      </Show>
    </Modal>
  );
};

export const SprintControl: Component = () => {
  const open = dialogOpen;
  const setOpen = setDialogOpen;
  const progress = () => {
    const s = sprint();
    return s && s.goal > 0 ? Math.min(1, sprintWords() / s.goal) : 0;
  };
  return (
    <>
      <Show
        when={sprint()}
        fallback={
          <span class="footer-item clickable" title="Start a writing sprint" onClick={() => setOpen(true)}>
            <Timer size={12} /> Sprint
          </span>
        }
      >
        <span class="footer-item clickable sprint-running" title="Click to stop the sprint" onClick={() => void finishSprint(false)}>
          <Timer size={12} />
          {fmtClock(sprintRemaining())} · {sprintWords().toLocaleString()}
          <Show when={sprint()!.goal > 0}> / {sprint()!.goal.toLocaleString()}</Show> words
          <Show when={sprint()!.goal > 0}>
            <span class="sprint-bar"><span class="sprint-fill" style={{ width: `${progress() * 100}%` }} /></span>
          </Show>
        </span>
      </Show>
      <Show when={open()}><SprintDialog onClose={() => setOpen(false)} /></Show>
    </>
  );
};
