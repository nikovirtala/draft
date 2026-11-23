import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tokensJson from "../../../docs/design-system/tokens.json" with { type: "json" };
import {
  ACCEPTED_BELOW_AA,
  between,
  CSS_MARKS,
  contrast,
  DOC_MARKS,
  docTable,
  luminance,
  PAGE_BACKGROUND,
  PALETTE,
  ROLE_NAMES,
  ROWS,
  rootBlock,
  STRONG,
  TEXT_CONTRAST,
  TOKENS,
  type Token,
  type Use,
} from "../src/shared/palette.ts";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(APP, "src");
const STYLES = join(SRC, "renderer/src/styles.css");
const DOC = join(APP, "../../docs/implementation.md");

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.some((e) => name.endsWith(e)) ? [path] : [];
  });
}

const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** styles.css split into the `:root` block and every other rule, as written. */
function stylesheet(): { root: string; rest: string } {
  const css = withoutComments(readFileSync(STYLES, "utf8"));
  const m = /:root\s*\{([^}]*)\}/.exec(css);
  if (m === null) throw new Error("styles.css has no :root");
  return { root: m[1] as string, rest: css.replace(m[0], "") };
}

/** `[property, value]` of every declaration in some CSS. */
function declarations(css: string): [string, string][] {
  return [...css.matchAll(/([a-z0-9-]+)\s*:\s*([^;{}]+);/g)].map((m) => [
    m[1] as string,
    (m[2] as string).trim(),
  ]);
}

const COLOUR_PROPERTIES = /color|background|border|outline|fill|stroke|shadow|decoration/;
const LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(|\b(?:red|green|blue|white|black|gray|grey|orange|yellow|pink|purple|crimson|tomato|teal|navy|lime|maroon|olive|silver|aqua|fuchsia|brown|gold|violet|indigo|cyan|magenta)\b/i;

/** A value with the tokens it names taken out: what is left is written in the component. */
const outsideTokens = (value: string): string => value.replace(/var\(--[a-z0-9-]+\)/g, "");

describe("the palette is docs/design-system/tokens.json, written once", () => {
  it("has a job for every colour token of tokens.json, and no other", () => {
    expect([...ROLE_NAMES].sort()).toEqual(tokensJson.color.tokens.map((t) => t.name).sort());
    for (const t of tokensJson.color.tokens) {
      const entry = TOKENS.get(`--${t.name}`);
      expect(entry?.value, t.name).toBe(t.value);
      expect(entry?.uses.length, `${t.name} has a job`).toBeGreaterThan(0);
    }
  });

  it("holds exactly tokens.json in the :root of styles.css, and nothing else is a colour there", () => {
    const { root } = stylesheet();
    const written = declarations(root)
      .filter(([p]) => p !== "color-scheme")
      .map(([p, v]) => `${p}: ${v};`);
    expect(written).toEqual(
      rootBlock()
        .split("\n")
        .map((l) => l.trim()),
    );
    // Every colour of the :root is a token of tokens.json.
    const colours = declarations(root).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v));
    expect(colours.map(([p, v]) => [p, v])).toEqual(
      tokensJson.color.tokens.map((t) => [`--${t.name}`, t.value]),
    );
  });

  it("no literal colour is written outside the tokens, in styles.css or a component", () => {
    const found: string[] = [];
    for (const [property, value] of declarations(stylesheet().rest)) {
      if (COLOUR_PROPERTIES.test(property) && LITERAL.test(outsideTokens(value)))
        found.push(`styles.css: ${property}: ${value}`);
    }
    const sources = filesUnder(SRC, [".ts", ".tsx", ".html"]).filter(
      (f) => !f.endsWith("shared/palette.ts"),
    );
    for (const file of sources) {
      const text = withoutComments(readFileSync(file, "utf8"));
      // A colour in a string: "#rrggbb", rgb(...), or a name given to a colour property.
      for (const m of text.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
        const string = m[1] as string;
        if (/^#[0-9a-f]{3,8}$/i.test(string) || /^(?:rgb|rgba|hsl|hsla)\(/i.test(string))
          found.push(`${relative(SRC, file)}: ${string}`);
      }
      for (const m of text.matchAll(
        /\b(?:color|background|backgroundColor|fill|stroke)\s*[:=]\s*["'{]+\s*["'`]?([a-z]+)/gi,
      )) {
        const name = m[1] as string;
        if (LITERAL.test(name)) found.push(`${relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("uses no custom property that the :root doesn't define", () => {
    const { root, rest } = stylesheet();
    const defined = new Set(declarations(root).map(([p]) => p));
    const used = new Set([...rest.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1] as string));
    expect([...used].filter((u) => !defined.has(u))).toEqual([]);
    // What a component reads from the :root by name (mermaid's theme) is defined there too.
    const read: string[] = [];
    for (const file of filesUnder(join(SRC, "renderer"), [".ts", ".tsx"]))
      for (const m of readFileSync(file, "utf8").matchAll(/["'`](--[a-z0-9-]+)["'`]/g))
        if (!defined.has(m[1] as string)) read.push(`${relative(SRC, file)}: ${m[1]}`);
    expect(read).toEqual([]);
  });

  it("a window is drawn on the palette's page colour before the page is", () => {
    expect(PAGE_BACKGROUND).toBe(TOKENS.get("--page")?.value);
  });

  it("has no red: its hues are purple, green, blue, amber and the sands and slates of the page", () => {
    const hueOf = (value: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const chroma = max - Math.min(r, g, b);
      if (chroma < 0.1) return -1;
      let hue = 0;
      if (max === r) hue = ((g - b) / chroma + 6) % 6;
      else if (max === g) hue = (b - r) / chroma + 2;
      else hue = (r - g) / chroma + 4;
      return hue * 60;
    };
    for (const { token, value } of PALETTE) {
      const hue = hueOf(value);
      expect({ token, red: hue >= 0 && (hue <= 12 || hue >= 348) }).toEqual({ token, red: false });
    }
  });

  it("puts every colour token in exactly one row of the table of colour to meaning", () => {
    const seen = new Map<string, number>();
    for (const row of ROWS)
      for (const name of [...row.fill, ...row.mark, ...row.words])
        seen.set(name, (seen.get(name) ?? 0) + 1);
    expect([...seen.keys()].sort()).toEqual(tokensJson.color.tokens.map((t) => t.name).sort());
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });
});

describe("contrast: every text colour on the surface it is drawn on", () => {
  const text = PALETTE.filter((e) => e.uses.includes("text"));
  const pairs = text.flatMap((e) => e.on.map((on) => [e.token, on] as const));
  const accepted = (fg: Token, bg: Token) =>
    ACCEPTED_BELOW_AA.some(([f, b]) => f === fg && b === bg);

  it("names the surfaces of every text token", () => {
    for (const e of text) expect(e.on.length, e.token).toBeGreaterThan(0);
  });

  it.each(pairs.filter(([fg, bg]) => !accepted(fg, bg)))("%s on %s reaches 4.5:1", (fg, bg) => {
    expect(
      contrast(TOKENS.get(fg)?.value as string, TOKENS.get(bg)?.value as string),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it("allows exactly two pairs under 4.5:1, by name, as the README accepts them", () => {
    expect(ACCEPTED_BELOW_AA.map(([f, b]) => `${f} on ${b}`)).toEqual([
      "--moved-word on --page",
      "--moved-strong on --moved-fill",
    ]);
    for (const [fg, bg] of ACCEPTED_BELOW_AA) {
      expect(
        pairs.some(([f, b]) => f === fg && b === bg),
        `${fg} on ${bg} is listed`,
      ).toBe(true);
      expect(
        contrast(TOKENS.get(fg)?.value as string, TOKENS.get(bg)?.value as string),
        `${fg} on ${bg}`,
      ).toBeLessThan(TEXT_CONTRAST);
    }
    // Any other listed pair under 4.5:1 would fail the cases above; none is hidden here.
    const under = pairs.filter(
      ([fg, bg]) =>
        contrast(TOKENS.get(fg)?.value as string, TOKENS.get(bg)?.value as string) < TEXT_CONTRAST,
    );
    expect(under.map(([f, b]) => `${f} on ${b}`).sort()).toEqual(
      ACCEPTED_BELOW_AA.map(([f, b]) => `${f} on ${b}`).sort(),
    );
  });

  it("every rule that sets a text colour on a background names a pairing the palette lists", () => {
    const rules = [...stylesheet().rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const checked: string[] = [];
    for (const [, selector, body] of rules) {
      const props = new Map(declarations(body as string));
      const fg = /^var\((--[a-z0-9-]+)\)$/.exec(props.get("color") ?? "")?.[1];
      if (fg === undefined) continue;
      const entry = TOKENS.get(fg as Token);
      expect(entry?.uses, `${(selector as string).trim()}: color ${fg}`).toContain("text");
      const bg = /^var\((--[a-z0-9-]+)\)$/.exec(
        props.get("background") ?? props.get("background-color") ?? "",
      )?.[1];
      if (bg === undefined) continue;
      expect(
        entry?.on,
        `${(selector as string).trim()}: ${fg} on ${bg} is not a pairing the palette lists`,
      ).toContain(bg);
      checked.push(`${fg} on ${bg}`);
    }
    expect(checked.length).toBeGreaterThan(5);
  });
});

/** What a property may be given: words get text tokens, strokes line tokens, fills fill tokens. */
function jobOf(property: string): Use | null {
  if (property === "color" || property === "caret-color") return "text";
  if (/^(border|outline)(-|$)/.test(property) || property === "stroke") return "line";
  if (property === "text-decoration-color" || property === "box-shadow") return "line";
  if (property === "background" || property === "background-color" || property === "fill")
    return "fill";
  return null;
}

describe("each token keeps to its job", () => {
  it("text tokens appear only in color, line tokens only in border, outline and stroke, fills only in background and fill", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [property, value] of declarations(stylesheet().rest)) {
      const want = jobOf(property);
      for (const m of value.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        const entry = TOKENS.get(m[1] as Token);
        if (entry === undefined) continue;
        if (want === null) {
          wrong.push(`${property}: ${value} (a colour token in a property with no job for it)`);
        } else {
          checked++;
          if (!entry.uses.includes(want))
            wrong.push(`${property}: ${value} (${entry.token} is for ${entry.uses.join(", ")})`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("gives each coloured meaning a fill, a mark and words", () => {
    for (const row of ROWS.filter(
      (r) => r.fill.length > 0 && r.meaning !== "The ground and its hairlines",
    )) {
      expect(row.mark.length, row.meaning).toBeGreaterThan(0);
      expect(row.words.length, row.meaning).toBeGreaterThan(0);
    }
  });
});

describe("a strong colour stays small and thin", () => {
  const strong = new Set<string>(STRONG);

  it("draws no strong mark thicker than the board's 2.5px, and uses the hairlines for every box", () => {
    const rules = [...stylesheet().rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const thick: string[] = [];
    let marks = 0;
    for (const [, selector, body] of rules) {
      const props = new Map(declarations(body as string));
      const name = (selector as string).trim();
      for (const [property, value] of props) {
        const token = /var\((--[a-z0-9-]+)\)/.exec(value)?.[1];
        if (token === undefined || !strong.has(token)) continue;
        marks++;
        const width =
          property === "stroke" ? props.get("stroke-width") : /^(\d+(?:\.\d+)?)px/.exec(value)?.[1];
        if (width !== undefined && Number.parseFloat(width) > 2.5)
          thick.push(`${name}: ${property} ${width}`);
      }
    }
    expect(thick).toEqual([]);
    expect(marks).toBeGreaterThan(10);
  });

  it("draws every line around a box as a hairline, and every dashed one as the dashed hairline", () => {
    const wrong: string[] = [];
    const rules = [...stylesheet().rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [, selector, body] of rules) {
      for (const [property, value] of declarations(body as string)) {
        if (!/^border(-(top|right|bottom|left))?$/.test(property)) continue;
        if (/\bsolid\b|\bdashed\b|\bdotted\b/.test(value) === false) continue;
        // A chip's transparent border keeps its size; the working ring is a mark, not a box.
        if (/transparent/.test(value) || (selector as string).trim() === ".working-ring") continue;
        const dashed = /\bdashed\b/.test(value);
        const want = dashed ? "var(--hairline-dashed)" : "var(--hairline)";
        if (!value.startsWith(want))
          wrong.push(`${(selector as string).trim()}: ${property}: ${value}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the table is written once and read where it is used", () => {
  const read = (path: string): string => readFileSync(path, "utf8");

  it("styles.css and docs/implementation.md are what `pnpm palette:sync` writes", () => {
    const css = read(STYLES);
    const doc = read(DOC);
    expect(between(css, CSS_MARKS, rootBlock())).toBe(css);
    expect(between(doc, DOC_MARKS, docTable())).toBe(doc);
  });

  it("names every token with its value in the docs", () => {
    const doc = read(DOC);
    for (const e of PALETTE) expect(doc, e.token).toContain(`\`${e.token.slice(2)}\` ${e.value}`);
  });

  it("orders the ground: a raised card, then the page, then a surface, then the title bar", () => {
    const lum = (t: Token) => luminance(TOKENS.get(t)?.value as string);
    expect(lum("--raised")).toBeGreaterThan(lum("--page"));
    expect(lum("--page")).toBeGreaterThan(lum("--surface"));
    expect(lum("--surface")).toBeGreaterThan(lum("--titlebar"));
  });
});
