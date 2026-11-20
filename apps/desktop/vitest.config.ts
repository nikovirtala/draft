import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The tests use draft-core's TypeScript source, so they need no build of it first. An alias, not
// the "source" export condition: some third-party packages publish a "source" condition too.
const core = (path: string) =>
  fileURLToPath(new URL(`../../packages/core/src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@nikovirtala\/draft-core$/, replacement: core("index.ts") },
      { find: /^@nikovirtala\/draft-core\/view$/, replacement: core("view.ts") },
    ],
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
