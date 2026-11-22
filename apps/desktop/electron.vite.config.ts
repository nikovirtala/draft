import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { buildInfo } from "./build-info.ts";

const build = buildInfo();

// draft-core is a workspace package bundled from its TypeScript source, so the app never builds
// against a stale dist/. An alias rather than the "source" export condition, which Vite applies
// only to client builds and which some third-party packages also publish. Its own dependencies
// are dependencies of this package and stay external.
const core = { exclude: ["@nikovirtala/draft-core"] };
const coreSource = (path: string) =>
  fileURLToPath(new URL(`../../packages/core/src/${path}`, import.meta.url));
const alias = [
  { find: /^@nikovirtala\/draft-core$/, replacement: coreSource("index.ts") },
  { find: /^@nikovirtala\/draft-core\/view$/, replacement: coreSource("view.ts") },
  { find: /^@nikovirtala\/draft-core\/map-graph$/, replacement: coreSource("map-graph.ts") },
  { find: /^@nikovirtala\/draft-core\/map-layout$/, replacement: coreSource("map-layout.ts") },
];

export default defineConfig({
  main: {
    resolve: { alias },
    // draft's deploy provenance, for its own telemetry (src/main/provenance.ts).
    define: {
      __DRAFT_REVISION__: JSON.stringify(build.revision),
      __DRAFT_REPOSITORY__: JSON.stringify(build.repository),
    },
    build: { externalizeDeps: core },
  },
  preload: {
    build: {
      externalizeDeps: core,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
  },
});
