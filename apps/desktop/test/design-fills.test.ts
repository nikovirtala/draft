import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FILL_PLACES, FILL_TOKENS, POINTER_SELECTORS } from "../src/shared/fills.ts";
import { TOKENS } from "../src/shared/palette.ts";
import { declarationsOf, rulesOf } from "./css-rules.ts";

/**
 * Where a fill may appear (spec A1 to A3), as far as the stylesheet can show it. The e2e harness
 * (e2e/design-checks.ts) checks every element that is drawn; it cannot put the pointer over
 * something, so the `:hover` rules are read here.
 */

const SPEC = readFileSync(
  join(fileURLToPath(import.meta.url), "../../../../docs/design/draft-design-spec.md"),
  "utf8",
);
const rules = rulesOf();

describe("the allow-list the harness reads", () => {
  /** The rows of the spec's A1 table: place, then the fill tokens it allows. */
  const table = new Map<string, string[]>();
  for (const m of SPEC.matchAll(/^\|\s*`([a-z]+)`\s*\|([^|]*)\|/gm))
    table.set(
      m[1] as string,
      [...(m[2] as string).matchAll(/`([a-z-]+)`/g)].map((t) => `--${t[1]}`),
    );

  it("is the table in the spec's A1, place for place and token for token", () => {
    expect([...table.keys()].sort()).toEqual(Object.keys(FILL_PLACES).sort());
    for (const [place, { tokens }] of Object.entries(FILL_PLACES))
      expect(table.get(place)?.slice().sort(), place).toEqual(tokens.slice().sort());
  });

  it("names the fills of the spec's meanings, each in a place", () => {
    const placed = new Set(Object.values(FILL_PLACES).flatMap((p) => p.tokens));
    expect([...placed].sort()).toEqual([...FILL_TOKENS].sort());
  });

  it("keeps every fill token to the job of a fill in the palette", () => {
    for (const token of FILL_TOKENS) expect(TOKENS.get(token)?.uses, token).toContain("fill");
  });

  it("lists in the spec each element a fill may sit under the pointer on", () => {
    for (const selector of POINTER_SELECTORS) expect(SPEC, selector).toContain(`\`${selector}`);
  });
});

/** The element a selector styles when the pointer or a state is taken as given. */
const withoutStates = (selector: string): string =>
  selector.replace(/:(?:hover|active|disabled|not\([^)]*\))/g, "").trim();

const FILL_PROPERTIES = new Set(["background", "background-color", "fill"]);
const FILL_VALUE = new RegExp(`var\\((${FILL_TOKENS.join("|")})\\)`);

describe("a fill under the pointer (A3)", () => {
  const hovers = rules.flatMap((r) =>
    r.selectors
      .filter((s) => s.includes(":hover"))
      .map((selector) => ({
        selector,
        fills: declarationsOf(r.body).filter(
          ([property, value]) => FILL_PROPERTIES.has(property) && FILL_VALUE.test(value),
        ),
      })),
  );

  it("is set only on the elements the pointer places name", () => {
    const setting = hovers.filter((h) => h.fills.length > 0);
    expect(setting.length).toBeGreaterThan(3);
    const outside = setting
      .filter((h) => {
        // The hovered element is the one the `:hover` is on: the part of the selector before the
        // last space after it.
        const subject = withoutStates(h.selector.slice(0, h.selector.indexOf(":hover") + 6));
        return !POINTER_SELECTORS.some((p) => subject === p || subject.startsWith(`${p}.`));
      })
      .map((h) => `${h.selector}: ${h.fills.map(([p, v]) => `${p}: ${v}`).join("; ")}`);
    expect(outside).toEqual([]);
  });
});
