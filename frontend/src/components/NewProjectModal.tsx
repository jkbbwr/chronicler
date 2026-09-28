import { type Component, createSignal, onMount, Show, For } from "solid-js";
import { FolderOpen, ChevronLeft, ChevronRight } from "lucide-solid";
import { Button, Modal } from "./ui";
import "./NewProjectModal.css";

// IDE-style New Project wizard: name the book, say where it lives, lay down
// the first chapter and scene, set the goals. Replaces the native save panel,
// whose filename-field-names-the-folder model misled writers into projects
// called "Untitled" in the wrong place.

interface NewProjectModalProps {
  onClose: () => void;
}

const shortenHome = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Mirrors projectFolderName() in electron/main.ts so the preview is honest. */
const folderName = (name: string) =>
  name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();

const STEPS = ["Project", "Structure", "Goals"] as const;

export const NewProjectModal: Component<NewProjectModalProps> = (props) => {
  const [step, setStep] = createSignal(0);
  const [name, setName] = createSignal("");
  const [author, setAuthor] = createSignal("");
  const [parent, setParent] = createSignal("");
  const [scaffold, setScaffold] = createSignal(true);
  const [chapter, setChapter] = createSignal("Chapter One");
  const [scene, setScene] = createSignal("First Scene");
  const [projectTarget, setProjectTarget] = createSignal(80000);
  const [dailyTarget, setDailyTarget] = createSignal(500);
  const [error, setError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  let nameInput!: HTMLInputElement;

  onMount(async () => {
    setParent(await window.chronicler.defaultProjectParent());
    nameInput?.focus();
  });

  const folder = () => folderName(name());
  const canAdvance = () => (step() === 0 ? !!folder() : true);

  const browse = async () => {
    const chosen = await window.chronicler.chooseProjectParent();
    if (chosen) {
      setParent(chosen);
      setError(null);
    }
  };

  const next = () => {
    if (!canAdvance()) {
      setError("Give the project a name first.");
      return;
    }
    setError(null);
    if (step() < STEPS.length - 1) setStep(s => s + 1);
    else create();
  };

  const back = () => {
    setError(null);
    if (step() > 0) setStep(s => s - 1);
  };

  const create = async () => {
    if (!folder() || creating()) return;
    setCreating(true);
    setError(null);
    const res = await window.chronicler.createProjectIn(parent(), {
      name: name().trim(),
      author: author().trim(),
      scaffold: scaffold(),
      chapter: chapter().trim(),
      scene: scene().trim(),
      targets: { dailyTarget: dailyTarget(), projectTarget: projectTarget() },
    });
    if (res.error) {
      setError(res.error);
      setCreating(false);
      setStep(0);
      return;
    }
    props.onClose(); // main takes over: backend restart + project-opened
  };

  const numberInput = (id: string, value: () => number, set: (n: number) => void) => (
    <input
      id={id}
      class="input"
      type="number"
      min="0"
      step="100"
      value={value()}
      onInput={(e) => set(Math.max(0, Number(e.currentTarget.value) || 0))}
      onKeyDown={(e) => { if (e.key === "Enter") next(); }}
    />
  );

  return (
    <Modal
      title="New project"
      onClose={props.onClose}
      footer={
        <>
          <Show when={step() > 0}>
            <Button variant="ghost" class="np-back" onClick={back}>
              <ChevronLeft size={14} /> Back
            </Button>
          </Show>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={next} disabled={!canAdvance() || creating()}>
            <Show
              when={step() === STEPS.length - 1}
              fallback={<>Next <ChevronRight size={14} /></>}
            >
              {creating() ? "Creating…" : "Create project"}
            </Show>
          </Button>
        </>
      }
    >
      <div class="np-steps">
        <For each={STEPS}>
          {(title, i) => (
            <>
              <Show when={i() > 0}>
                <div class="np-step-rule" />
              </Show>
              <span class="np-step" classList={{ current: i() === step(), done: i() < step() }}>
                {i() + 1}. {title}
              </span>
            </>
          )}
        </For>
      </div>

      <Show when={step() === 0}>
        <div class="np-page">
          <p class="hint">A project is a folder holding the manuscript, codex, and history.</p>

          <div class="field">
            <label for="np-name">Project name</label>
            <input
              id="np-name"
              ref={nameInput}
              class="input"
              placeholder="e.g. The Necromancer and the Paladin"
              value={name()}
              onInput={(e) => { setName(e.currentTarget.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") next(); }}
            />
          </div>

          <div class="field">
            <label for="np-author">Author</label>
            <input
              id="np-author"
              class="input"
              placeholder="Whose name goes on the title page"
              value={author()}
              onInput={(e) => setAuthor(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") next(); }}
            />
          </div>

          <div class="field">
            <label>Location</label>
            <div class="np-location">
              <div class="input np-location-path" title={parent()}>
                <span>{shortenHome(parent())}</span>
              </div>
              <Button onClick={browse}>
                <FolderOpen size={14} /> Browse…
              </Button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={step() === 1}>
        <div class="np-page">
          <p class="hint">
            Chapters are folders, scenes are files inside them. Numbers keep the
            binder in order; you can rename or reorder any of it later.
          </p>

          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={scaffold()}
              onChange={(e) => setScaffold(e.currentTarget.checked)}
            />
            Start with a first chapter and scene
          </label>

          <Show when={scaffold()} fallback={
            <p class="hint">The project will start empty — add chapters from the binder.</p>
          }>
            <div class="field">
              <label for="np-chapter">First chapter</label>
              <input
                id="np-chapter"
                class="input"
                placeholder="Chapter One"
                value={chapter()}
                onInput={(e) => setChapter(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") next(); }}
              />
            </div>

            <div class="field">
              <label for="np-scene">First scene</label>
              <input
                id="np-scene"
                class="input"
                placeholder="First Scene"
                value={scene()}
                onInput={(e) => setScene(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") next(); }}
              />
            </div>

            <div class="np-tree">
              <div>{folder() || "Project"}/</div>
              <div class="np-tree-2">01 {folderName(chapter()) || "Chapter One"}/</div>
              <div class="np-tree-3">01 {folderName(scene()) || "First Scene"}.md</div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={step() === 2}>
        <div class="np-page">
          <p class="hint">
            Goals drive the progress bar in the status bar. Change them any
            time from the writing statistics panel.
          </p>

          <div class="field">
            <label for="np-length">Target length (words)</label>
            {numberInput("np-length", projectTarget, setProjectTarget)}
          </div>

          <div class="field">
            <label for="np-daily">Daily goal (words)</label>
            {numberInput("np-daily", dailyTarget, setDailyTarget)}
          </div>

          <div class="np-summary">
            <div><strong>{name().trim() || "Untitled"}</strong>{author().trim() ? ` — ${author().trim()}` : ""}</div>
            <div class="np-summary-path">{shortenHome(parent())}/{folder()}</div>
          </div>
        </div>
      </Show>

      <div class="np-status" classList={{ error: !!error() }}>
        <Show when={!error()} fallback={error()}>
          <Show when={step() === 0 && folder()}>
            Will be created at {shortenHome(parent())}/{folder()}
          </Show>
        </Show>
      </div>
    </Modal>
  );
};
