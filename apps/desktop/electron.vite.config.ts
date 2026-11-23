import { readFileSync } from "node:fs";
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
// Every subpath core exports gets an alias to its "source" file, read from core's package.json, so
// adding an export can't leave the app unable to resolve it in development.
const coreDir = new URL("../../packages/core/", import.meta.url);
const coreExports = JSON.parse(readFileSync(new URL("package.json", coreDir), "utf8"))
  .exports as Record<string, { source: string }>;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alias = Object.entries(coreExports).map(([subpath, target]) => ({
  find: new RegExp(`^${escapeRegExp(`@nikovirtala/draft-core${subpath.slice(1)}`)}$`),
  replacement: fileURLToPath(new URL(target.source, coreDir)),
}));

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
