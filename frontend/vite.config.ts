import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import electron from "vite-plugin-electron/simple";
import type { Plugin } from "vite";

/**
 * Renderer edits reload the whole page instead of hot-swapping modules. The
 * app keeps its state in module-level stores; hot-swapping one leaves stale
 * copies behind (e.g. the editor switching a mode the shell no longer
 * reads). Sessions and unsaved edits are restored on reload, so nothing is
 * lost.
 */
const fullReload = (): Plugin => ({
  name: "chronicler-full-reload",
  apply: "serve",
  handleHotUpdate({ file, server }) {
    if (file.includes("/src/")) {
      server.ws.send({ type: "full-reload" });
      return [];
    }
  },
});

export default defineConfig({
  plugins: [
    fullReload(),
    solid(),
    electron({
      main: {
        // Main process entry
        entry: "electron/main.ts",
      },
      preload: {
        // Preload scripts entry
        input: "electron/preload.ts",
      },
      // No `renderer` option: the renderer talks to the backend via the
      // contextBridge preload only and must not have Node access.
    }),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
