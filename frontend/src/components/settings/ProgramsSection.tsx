import { type Component, For, onMount, Show } from "solid-js";
import { Button } from "../ui";
import { Row } from "./sections";
import { invoke } from "../../lib/rpc";
import { notifyError } from "../../stores/app";
import { INSTALL, recheckTools, setTools, tools } from "../../stores/tools";
import type { Tool } from "../../rpc.gen";

// Programs Chronicler runs, for every book: found on PATH, or wherever the
// writer says they are.

const TOOLS: Tool[] = ["jj", "typst"];

export const ProgramsSection: Component = () => {
  onMount(() => void recheckTools());
  const version = (t: Tool) => (t === "jj" ? tools()?.jj : tools()?.typst);
  const path = (t: Tool) => (t === "jj" ? tools()?.jjPath : tools()?.typstPath) ?? "";
  const save = async (tool: Tool, value: string) => {
    try {
      setTools(await invoke("system/tools_set", { tool, path: value.trim() }));
    } catch (err) {
      notifyError("Couldn't save the location", err);
    }
  };
  return (
    <>
      <p class="hint settings-intro">
        Chronicler uses two programs you install yourself. It looks for them on your PATH; if one is installed
        somewhere else, give its full path here.
      </p>
      <For each={TOOLS}>
        {(t) => (
          <Row
            name={INSTALL[t].name}
            hint={`${INSTALL[t].what}. ${version(t) ? `Found version ${version(t)}.` : tools.loading ? "Checking…" : "Not found."}`}
          >
            <div class="settings-inline">
              <input
                class="input"
                placeholder={`${INSTALL[t].name} (on PATH)`}
                value={path(t)}
                onChange={(e) => void save(t, e.currentTarget.value)}
              />
              <Show when={path(t)}>
                <Button variant="ghost" onClick={() => void save(t, "")}>Use PATH</Button>
              </Show>
            </div>
          </Row>
        )}
      </For>
    </>
  );
};
