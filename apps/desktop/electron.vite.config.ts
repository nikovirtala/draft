import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// draft-core is a workspace package shipped as TypeScript source (the "source" export
// condition), so it is bundled into the main process instead of externalized; its own
// dependencies are dependencies of this package and stay external.
const core = { exclude: ["@nikovirtala/draft-core"] };

export default defineConfig({
  main: {
    resolve: { conditions: ["source"] },
    build: { externalizeDeps: core },
  },
  preload: {
    build: {
      externalizeDeps: core,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    resolve: { conditions: ["source"] },
    plugins: [react()],
  },
});
