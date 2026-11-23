import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const e2e = fileURLToPath(new URL("../e2e/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const specs = readdirSync(e2e).filter((f) => f.endsWith(".spec.ts"));
const source = (f: string) => readFileSync(join(e2e, f), "utf8");

describe("the named states of the screenshot comment", () => {
  const states = JSON.parse(readFileSync(join(e2e, "states.json"), "utf8")) as {
    state: string;
    screenshot: string;
    preview: string | null;
    width: number;
  }[];
  const taken = specs.map(source).join("\n");

  it("has each state once, with a width", () => {
    expect(new Set(states.map((s) => s.state)).size).toBe(states.length);
    expect(new Set(states.map((s) => s.screenshot)).size).toBe(states.length);
    for (const s of states) expect(s.width).toBeGreaterThan(0);
  });

  it.each(states.map((s) => [s.screenshot, s] as const))("%s is taken by a spec", (name) => {
    expect(taken).toContain(`"${name.replace(/\.png$/, "")}"`);
  });

  it.each(states.flatMap((s) => (s.preview === null ? [] : [[s.preview] as const])))(
    "%s exists",
    (preview) => {
      expect(existsSync(join(root, preview))).toBe(true);
    },
  );
});
