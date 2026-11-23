import { describe, expect, it } from "vitest";
import { declarationsOf, type Rule, rulesOf } from "./css-rules.ts";

/** Motion (spec M2, C6): everything that moves stops in the one reduced-motion block. */

const rules = rulesOf();

describe("motion (M2, C6)", () => {
  const REDUCED = "(prefers-reduced-motion: reduce)";
  const MOTION = /^(animation|animation-name|transition|transition-property)$/;
  const moving = (r: Rule) =>
    declarationsOf(r.body).filter(([p, v]) => MOTION.test(p) && v !== "none");
  const reduced = rules.filter((r) => r.media === REDUCED);

  it("stops every animation and transition in the one reduced-motion block", () => {
    const stopped = (selector: string, property: "animation" | "transition") =>
      reduced.some(
        (r) =>
          r.selectors.includes(selector) &&
          declarationsOf(r.body).some(([p, v]) => p === property && v === "none"),
      );
    const moves = rules.filter((r) => r.media === null && moving(r).length > 0);
    expect(moves.length, "the stylesheet animates something").toBeGreaterThan(1);
    const unstopped = moves.flatMap((r) =>
      r.selectors.flatMap((selector) =>
        moving(r)
          .map(([p]): "animation" | "transition" =>
            p.startsWith("animation") ? "animation" : "transition",
          )
          .filter((property) => !stopped(selector, property))
          .map(
            (property) =>
              `${selector} has ${property === "animation" ? "an animation" : "a transition"} the reduced-motion block does not stop`,
          ),
      ),
    );
    expect(unstopped).toEqual([]);
  });

  it("starts no motion inside a media block, and keeps one reduced-motion block", () => {
    expect(rules.filter((r) => r.media !== null && r.media !== REDUCED)).toEqual([]);
    expect(reduced.flatMap(moving)).toEqual([]);
    expect(reduced.length).toBeGreaterThan(1);
  });
});
