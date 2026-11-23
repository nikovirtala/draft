import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { style, value } from "../src/shared/palette.ts";

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/src/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const declarationsOf = (body: string): Map<string, string> =>
  new Map(
    [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((d) => [
      d[1] as string,
      (d[2] as string).trim().replace(/\s+/g, " "),
    ]),
  );

/** The declarations of the rule whose selector is exactly `selector`, or null. */
function ruleOrNull(selector: string): Map<string, string> | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(CSS);
  return m === null ? null : declarationsOf(m[1] as string);
}

function rule(selector: string): Map<string, string> {
  const found = ruleOrNull(selector);
  if (found === null) throw new Error(`no rule for ${selector}`);
  return found;
}

/** The one rule that gives every state pill its geometry: its selectors, and its declarations. */
function sharedChip(): { selectors: string[]; body: Map<string, string> } {
  const m = /(\.pending,[^{]*)\{([^}]*)\}/.exec(CSS);
  if (m === null) throw new Error("no shared chip rule");
  return {
    selectors: (m[1] as string).split(",").map((x) => x.trim()),
    body: declarationsOf(m[2] as string),
  };
}

describe("a pull request's state in its status stub: how each looks", () => {
  it("draws merged in the colour for done, filled, as passed checks are", () => {
    const merged = rule(".pr-state.pr-merged");
    const checks = rule(".pending.good");
    expect(merged.get("color")).toBe("var(--done-word)");
    expect(merged.get("background")).toBe("var(--done-fill)");
    expect(checks.get("color")).toBe(merged.get("color"));
    expect(checks.get("background")).toBe(merged.get("background"));
    // A pastel fill with no outline of its own.
    expect(merged.get("border")).toBeUndefined();
    expect(checks.get("border")).toBeUndefined();
    expect(rule(".pr-state.pr-merged::before").get("content")).toBe(
      rule(".pending.good::before").get("content"),
    );
  });

  it("gives merged the weight and shape of 8/8 checks passed: both are the one chip", () => {
    const chip = sharedChip();
    expect(chip.selectors).toContain(".pending");
    expect(chip.selectors).toContain(".stub-status.pr-state");
    // No rule of its own for the pill's selector sets it apart: only the shared list names it.
    expect(CSS.match(/(?:^|\n)\.stub-status\.pr-state \{/g)).toBeNull();
    // Nothing else sets the geometry of either, so they cannot drift apart.
    for (const selector of [".pending", ".pr-state.pr-merged", ".pending.good"])
      for (const property of ["padding", "border-radius", "font", "font-size", "font-weight"])
        expect(ruleOrNull(selector)?.get(property), `${selector} ${property}`).toBeUndefined();
  });

  it("is the design system's chip: its type style, its padding, its corners", () => {
    const { body } = sharedChip();
    const chip = style("chip");
    expect(body.get("font")?.replace(/\s*\/\s*/, "/")).toBe(
      `${chip.fontWeight} ${chip.fontSize}/${chip.lineHeight} var(--font-${chip.family})`,
    );
    // The padding and corners are tokens, and the tokens are the ones the design system gives.
    expect(body.get("padding")).toBe("7px var(--space-3)");
    expect(value("spacing", "space-3")).toBe("8px");
    expect(body.get("border-radius")).toBe("var(--radius-chip)");
    expect(value("radius", "radius-chip")).toBe("7px");
    expect(body.get("border")).toBe("1px solid transparent");
    expect(body.get("gap")).toBe("var(--space-1)");
  });

  it("gives every state pill the chip, and only a not-started one a solid hairline", () => {
    const { selectors } = sharedChip();
    for (const pill of [
      ".pending",
      ".chip",
      ".thread-chip",
      ".where",
      ".context-badge",
      ".agent-badge",
      ".evidence-mark",
      ".map-stale",
      ".stub-status.pr-state",
      ".graph-legend li",
    ])
      expect(selectors, pill).toContain(pill);
    // A hairline in a chip is "not started" (idle-line) or the open loop's dashed one; a failure's
    // dashed hairline is the waiting mark. No other chip has a line.
    const lines = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => ({
        selector: (selector as string).trim().replace(/\s+/g, " "),
        border: declarationsOf(body as string).get("border"),
      }))
      .filter(
        (r) =>
          r.border !== undefined &&
          !r.border.includes("transparent") &&
          /\.(pending|thread-chip|pr-state|evidence-mark|map-cell|graph-legend|chip|map-stale|where|context-badge|agent-badge)/.test(
            r.selector,
          ),
      );
    expect(
      lines
        .map((r) => `${r.selector}: ${(r.border as string).replace(/^var\(--[a-z-]+\) /, "")}`)
        .sort(),
    ).toEqual(
      [
        ".evidence-red .evidence-mark: dashed var(--waiting-mark)",
        ".graph-legend li.idle: solid var(--idle-line)",
        ".graph-legend li.loop: dashed var(--loop-mark)",
        ".map-cell:disabled: solid var(--idle-line)",
        ".pending.bad: dashed var(--waiting-mark)",
        ".pr-state.pr-closed: solid var(--idle-line)",
        ".thread-chip: solid var(--idle-line)",
      ].sort(),
    );
  });

  it("tells open, merged and closed apart by shape as well as colour", () => {
    const looks = ["open", "merged", "closed"].map((state) => {
      const pill = rule(`.pr-state.pr-${state}`);
      return {
        fill: pill.get("background"),
        line: pill.get("border"),
        mark: rule(`.pr-state.pr-${state}::before`).get("content"),
      };
    });
    // Open is blue with a ring, merged green with a check, closed "not started": no fill, a
    // hairline, and a cross.
    expect(looks.map((l) => l.fill)).toEqual([
      "var(--review-fill)",
      "var(--done-fill)",
      "transparent",
    ]);
    expect(looks[0]?.line).toBeUndefined();
    expect(looks[1]?.line).toBeUndefined();
    expect(looks[2]?.line).toBe("var(--hairline) solid var(--idle-line)");
    expect(new Set(looks.map((l) => l.mark)).size).toBe(3);
    expect(new Set(looks.map((l) => JSON.stringify(l))).size).toBe(3);
  });
});
