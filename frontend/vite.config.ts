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
      // Optional: Use Node.js API in the Renderer process
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
