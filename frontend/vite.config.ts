import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
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
