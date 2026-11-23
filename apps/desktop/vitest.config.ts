import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The tests use draft-core's TypeScript source, so they need no build of it first. An alias, not
// the "source" export condition: some third-party packages publish a "source" condition too. Every
// subpath core exports gets one, read from core's package.json as electron.vite.config.ts does.
const coreDir = new URL("../../packages/core/", import.meta.url);
const coreExports = JSON.parse(readFileSync(new URL("package.json", coreDir), "utf8"))
  .exports as Record<string, { source: string }>;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alias = Object.entries(coreExports).map(([subpath, target]) => ({
  find: new RegExp(`^${escapeRegExp(`@nikovirtala/draft-core${subpath.slice(1)}`)}$`),
  replacement: fileURLToPath(new URL(target.source, coreDir)),
}));

export default defineConfig({
  resolve: { alias },
  test: { include: ["test/**/*.test.{ts,tsx}"], testTimeout: 20_000 },
});
