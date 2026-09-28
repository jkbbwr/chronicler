import { type Component, createSignal, For, Show } from "solid-js";
import { FolderOpen, FilePlus, X } from "lucide-solid";
import { Button, IconButton } from "./ui";
import "./WelcomeScreen.css";

interface RecentProject {
  path: string;
  openedAt: string;
}

interface WelcomeScreenProps {
  recents: RecentProject[];
  onNewProject: () => void;
}

const basename = (p: string) => p.split("/").pop() || p;

const shortenHome = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

export const WelcomeScreen: Component<WelcomeScreenProps> = (props) => {
  const [recents, setRecents] = createSignal(props.recents);

  const removeRecent = async (e: MouseEvent, path: string) => {
    e.stopPropagation();
    setRecents(await window.chronicler.removeRecent(path));
  };

  return (
    <div class="welcome">
      {/* Keep the frameless window draggable */}
      <div class="titlebar" />

      <div class="welcome-body" classList={{ "has-recents": recents().length > 0 }}>
        <div class="welcome-hero">
          <h1 class="welcome-title">Chronicler</h1>
          <p class="welcome-tagline">The IDE for fiction writing</p>
          <div class="welcome-actions">
            <Button variant="primary" onClick={props.onNewProject}>
              <FilePlus size={15} /> New project
            </Button>
            <Button onClick={() => window.chronicler.openProject()}>
              <FolderOpen size={15} /> Open…
            </Button>
          </div>
        </div>

        <Show when={recents().length > 0}>
          <section class="welcome-recents">
            <div class="section-label">Recent projects</div>
            <For each={recents()}>
              {(project) => (
                <div
                  class="list-row welcome-recent"
                  role="button"
                  tabIndex={0}
                  onClick={() => window.chronicler.openProject(project.path)}
                  onKeyDown={(e) => { if (e.key === "Enter") window.chronicler.openProject(project.path); }}
                >
                  <div class="welcome-recent-text">
                    <div class="welcome-recent-name">{basename(project.path)}</div>
                    <div class="welcome-recent-path">{shortenHome(project.path)}</div>
                  </div>
                  <div class="row-actions">
                    <IconButton size="sm" label="Remove from recent projects" onClick={(e) => removeRecent(e, project.path)}>
                      <X size={13} />
                    </IconButton>
                  </div>
                </div>
              )}
            </For>
          </section>
        </Show>
      </div>
    </div>
  );
};
