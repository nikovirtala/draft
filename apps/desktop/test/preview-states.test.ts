import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStates } from "../scripts/screenshot-states.ts";

/**
 * Every named state has a design preview that draws that same state (docs/design/draft-design-spec.md,
 * L3): the state names its preview in e2e/states.json, and the preview says which screenshots it
 * draws with a `data-draws="<screenshot name> …"` attribute on the element that draws them. A state
 * with no preview, or a preview that does not claim it, fails here; it never falls back to another.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const states = loadStates();
const name = (screenshot: string) => screenshot.replace(/\.png$/, "");

/** The screenshot names a preview claims to draw. */
function draws(html: string): string[] {
  return [...html.matchAll(/data-draws="([^"]*)"/g)].flatMap((m) =>
    (m[1] ?? "").split(/\s+/).filter((t) => t !== ""),
  );
}

describe("the previews of the named states", () => {
  it.each(states.map((s) => [s.screenshot, s] as const))(
    "%s names a preview that draws it",
    (_, s) => {
      expect(s.preview, `${s.state} has no preview`).not.toBeNull();
      const file = join(root, s.preview as string);
      expect(existsSync(file), `${s.preview} does not exist`).toBe(true);
      expect(draws(readFileSync(file, "utf8"))).toContain(name(s.screenshot));
    },
  );

  it("has no preview that claims a screenshot no state names", () => {
    const known = new Set(states.map((s) => name(s.screenshot)));
    const components = join(root, "docs/design-system/components");
    for (const dir of readdirSync(components)) {
      const file = join(components, dir, "preview.html");
      if (!existsSync(file)) continue;
      for (const claimed of draws(readFileSync(file, "utf8")))
        expect(known.has(claimed), `${dir} draws ${claimed}, which is not a state`).toBe(true);
    }
  });

  it("gives each preview a README and no literal colour", () => {
    for (const preview of new Set(states.map((s) => s.preview as string))) {
      const dir = dirname(join(root, preview));
      expect(existsSync(join(dir, "README.md")), `${preview} has no README.md`).toBe(true);
      const html = readFileSync(join(root, preview), "utf8");
      expect(
        html.match(/#[0-9a-fA-F]{6}\b|\brgba?\(/g) ?? [],
        `${preview} writes a colour`,
      ).toEqual([]);
    }
  });
});
