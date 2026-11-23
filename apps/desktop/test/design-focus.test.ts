import { describe, expect, it } from "vitest";
import { declarationsOf, type Rule, rulesOf } from "./css-rules.ts";

/** Keyboard focus (spec A5, C3): one ring for the whole stylesheet, never a fill. */

const rules = rulesOf();

describe("keyboard focus", () => {
  const outlines = rules.filter((r) => declarationsOf(r.body).some(([p]) => /^outline/.test(p)));

  it("has one outline rule in the stylesheet: 1.5px, solid, moved-mark, through :focus-visible", () => {
    expect(outlines.map((r) => r.selectors)).toEqual([
      [":focus-visible", ".map-range label:has(input:focus-visible)"],
    ]);
    const [rule] = outlines as [Rule];
    expect(declarationsOf(rule.body)).toEqual([
      ["outline", "1.5px solid var(--moved-mark)"],
      ["outline-offset", "1px"],
    ]);
    expect(rule.media).toBeNull();
  });

  it("shows nothing for :focus or :focus-within that is a ring or a fill", () => {
    const wrong = rules
      .filter((r) => r.selectors.some((s) => /:focus(?!-visible)/.test(s)))
      .flatMap((r) =>
        declarationsOf(r.body)
          .filter(([p]) => /^(outline|background|fill|box-shadow|border)/.test(p))
          .map(([p, v]) => `${r.selectors.join(", ")}: ${p}: ${v}`),
      );
    expect(wrong).toEqual([]);
  });
});
