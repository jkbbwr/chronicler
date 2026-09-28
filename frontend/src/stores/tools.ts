import { createResource, createRoot } from "solid-js";
import { invoke } from "../lib/rpc";
import type { Tools } from "../rpc.gen";

// Outside programs Chronicler needs: jj (history) and typst (compiling).
// Checked once; "Check again" after installing.

export const [tools, { refetch: recheckTools }] = createRoot(() =>
  createResource<Tools | null>(async () => {
    try {
      return await invoke("system/tools");
    } catch {
      return null; // backend restarting: don't claim anything is missing
    }
  }),
);

export const INSTALL = {
  jj: { name: "jj", what: "Version history", brew: "brew install jj", url: "https://jj-vcs.github.io/jj/latest/install-and-setup/" },
  typst: { name: "typst", what: "Compiling to PDF", brew: "brew install typst", url: "https://github.com/typst/typst#installation" },
} as const;
