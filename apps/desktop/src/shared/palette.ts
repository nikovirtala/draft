/**
 * draft's palette: docs/design-system/tokens.json is the source of truth for
 * every colour, type family, spacing, radius and line width, and this module reads it. A value is
 * never typed twice: the `:root` of styles.css and the table in docs/implementation.md are written
 * from it by `pnpm palette:sync`, and a test fails when they differ.
 *
 * What this module adds is the job of each token. A meaning has up to three steps, and a token is
 * used for its job only (a test fails on a token in another property):
 *
 * - `fill`: a pastel, for what people see of a state: pills, discs, the ground under a block
 *   (`background`, `fill`). No strong colour fills an area;
 * - `line`: hairlines and the small marks that carry a state (`border`, `outline`, `stroke`). A mark
 *   may also be a small dot, so it may fill a few pixels;
 * - `text`: words (`color`), at 4.5:1 on every surface they are drawn on, except the two pairs
 *   below that the design system accepts on purpose.
 *
 * There is no red. A failure is the waiting fill with a dashed hairline, a cross and its words, and
 * an open loop a dashed ring: shape and words carry the meaning, never colour alone.
 */
import tokens from "../../../../docs/design-system/tokens.json" with { type: "json" };

export type Use = "text" | "line" | "fill";

/** A token's name in the CSS: `moved-fill` is `--moved-fill`. */
export type Token = `--${string}`;

export interface PaletteEntry {
  token: Token;
  /** `#rrggbb`, from tokens.json. */
  value: string;
  /** What tokens.json says it is for. */
  meaning: string;
  /** The jobs it may be used for. */
  uses: readonly Use[];
  /** For text: the surface tokens it is drawn on. */
  on: readonly Token[];
}

/** The jobs and the surfaces of each colour token. tokens.json has the values and the usage. */
const ROLES: Record<string, { uses: readonly Use[]; on?: readonly string[] }> = {
  page: { uses: ["fill", "text"], on: ["moved-strong"] },
  surface: { uses: ["fill"] },
  raised: { uses: ["fill"] },
  titlebar: { uses: ["fill"] },
  line: { uses: ["line"] },
  "line-strong": { uses: ["line"] },
  edge: { uses: ["line"] },
  ink: {
    uses: ["text"],
    on: [
      "page",
      "surface",
      "raised",
      "titlebar",
      "moved-fill",
      "moved-selected",
      "done-fill",
      "review-fill",
      "waiting-fill",
    ],
  },
  text: {
    uses: ["text"],
    on: [
      "page",
      "surface",
      "raised",
      "titlebar",
      "moved-fill",
      "moved-selected",
      "done-fill",
      "review-fill",
      "waiting-fill",
    ],
  },
  muted: {
    uses: ["text"],
    on: ["page", "surface", "raised", "titlebar", "done-fill", "review-fill", "waiting-fill"],
  },
  "moved-fill": { uses: ["fill"] },
  "moved-selected": { uses: ["fill"] },
  "moved-mark": { uses: ["line", "fill"] },
  "moved-word": { uses: ["text"], on: ["page"] },
  "moved-strong": { uses: ["text", "fill"], on: ["page", "raised", "moved-fill"] },
  "done-fill": { uses: ["fill"] },
  "done-mark": { uses: ["line", "fill"] },
  "done-word": {
    uses: ["text"],
    on: ["page", "surface", "raised", "done-fill", "review-fill", "waiting-fill"],
  },
  "review-fill": { uses: ["fill"] },
  "review-mark": { uses: ["line", "fill"] },
  "review-word": {
    uses: ["text"],
    on: [
      "page",
      "surface",
      "raised",
      "titlebar",
      "moved-fill",
      "done-fill",
      "review-fill",
      "waiting-fill",
    ],
  },
  "waiting-fill": { uses: ["fill"] },
  "waiting-mark": { uses: ["line", "fill"] },
  "waiting-word": {
    uses: ["text"],
    on: [
      "page",
      "surface",
      "raised",
      "titlebar",
      "moved-fill",
      "done-fill",
      "review-fill",
      "waiting-fill",
    ],
  },
  "idle-line": { uses: ["line", "fill"] },
  "loop-mark": { uses: ["line"] },
};

/** The names the roles cover: a test checks them against tokens.json. */
export const ROLE_NAMES: readonly string[] = Object.keys(ROLES);

export const PALETTE: readonly PaletteEntry[] = tokens.color.tokens.map((t) => ({
  token: `--${t.name}` as Token,
  value: t.value,
  meaning: t.usage,
  uses: ROLES[t.name]?.uses ?? [],
  on: (ROLES[t.name]?.on ?? []).map((n) => `--${n}` as Token),
}));

export const TOKENS: ReadonlyMap<Token, PaletteEntry> = new Map(PALETTE.map((e) => [e.token, e]));

/** A token's value; throws for a name the palette doesn't have. */
export function colour(token: Token): string {
  const e = TOKENS.get(token);
  if (e === undefined) throw new Error(`no palette token ${token}`);
  return e.value;
}

/** The page's colour, for a window that is drawn before the page is. */
export const PAGE_BACKGROUND = colour("--page");

/** The strong marks: they stay thin and small, and never fill an area. */
export const STRONG: readonly Token[] = [
  "--moved-mark",
  "--done-mark",
  "--review-mark",
  "--waiting-mark",
  "--moved-strong",
];

/**
 * The two text pairs under 4.5:1 that docs/design-system/README.md accepts on purpose:
 * pastel words on the page, and a chip's word on the soft purple. They are used at 12.5px and up,
 * weight 500, and never as the only sign. A test allows these two, by name, and no other.
 */
export const ACCEPTED_BELOW_AA: readonly (readonly [Token, Token])[] = [
  ["--moved-word", "--page"],
  ["--moved-strong", "--moved-fill"],
];

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => channel(Number.parseInt(h as string, 16)));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The ratio text has to reach (WCAG AA, normal text). */
export const TEXT_CONTRAST = 4.5;

/** One row of the table of colour to meaning: the tokens of one meaning, by job. */
export interface Row {
  meaning: string;
  fill: readonly string[];
  mark: readonly string[];
  words: readonly string[];
}

/** The table of colour to meaning, by token name. Every colour token is in exactly one row. */
export const ROWS: readonly Row[] = [
  {
    meaning: "Moved, the agent's activity",
    fill: ["moved-fill", "moved-selected"],
    mark: ["moved-mark"],
    words: ["moved-word", "moved-strong"],
  },
  { meaning: "Done, settled", fill: ["done-fill"], mark: ["done-mark"], words: ["done-word"] },
  {
    meaning: "Under way elsewhere",
    fill: ["review-fill"],
    mark: ["review-mark"],
    words: ["review-word"],
  },
  {
    meaning: "Waits on you, and a failure",
    fill: ["waiting-fill"],
    mark: ["waiting-mark"],
    words: ["waiting-word"],
  },
  {
    meaning: "Not started, an open loop",
    fill: [],
    mark: ["idle-line", "loop-mark"],
    words: ["muted"],
  },
  {
    meaning: "The ground and its hairlines",
    fill: ["page", "surface", "raised", "titlebar"],
    mark: ["line", "line-strong", "edge"],
    words: ["ink", "text"],
  },
];

/** The markers that fence what `pnpm palette:sync` writes in styles.css and in the docs. */
export const CSS_MARKS = ["  /* palette:start */", "  /* palette:end */"] as const;
export const DOC_MARKS = ["<!-- palette:start -->", "<!-- palette:end -->"] as const;

/** The `:root` lines of styles.css: colours, line widths, radii, spacing and type families. */
export function rootBlock(): string {
  const lines: string[] = [];
  for (const t of tokens.color.tokens) lines.push(`--${t.name}: ${t.value};`);
  for (const t of tokens.border.tokens) lines.push(`--${t.name}: ${t.value};`);
  for (const t of tokens.radius.tokens) lines.push(`--${t.name}: ${t.value};`);
  for (const t of tokens.spacing.tokens) lines.push(`--${t.name}: ${t.value};`);
  for (const [name, value] of Object.entries(tokens.type.families))
    lines.push(`--font-${name}: ${value};`);
  return lines.map((l) => `  ${l}`).join("\n");
}

/** The value of a non-colour token, by group and name: `value("border", "hairline")`. */
export function value(group: "border" | "radius" | "spacing", name: string): string {
  const t = tokens[group].tokens.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no ${group} token ${name}`);
  return t.value;
}

/** A type style of tokens.json, by name: `style("chip")`. */
export function style(name: string): {
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  family: string;
} {
  for (const g of tokens.type.groups) {
    const s = g.styles.find((x) => x.name === name);
    if (s !== undefined)
      return {
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        fontWeight: s.fontWeight,
        family: g.family,
      };
  }
  throw new Error(`no type style ${name}`);
}

/** The table of colour to meaning, as the docs print it. */
export function docTable(): string {
  const value_ = (name: string): string => colour(`--${name}` as Token);
  const cell = (names: readonly string[]): string =>
    names.map((n) => `\`${n}\` ${value_(n)}`).join(", ");
  const line = (cells: readonly string[]): string =>
    `|${cells.map((c) => (c === "" ? " " : ` ${c} `)).join("|")}|`;
  return [
    line(["Meaning", "Fill", "Mark", "Words"]),
    line(["---", "---", "---", "---"]),
    ...ROWS.map((r) => line([r.meaning, cell(r.fill), cell(r.mark), cell(r.words)])),
  ].join("\n");
}

/** `text` with what lies between the two marks replaced by `body`; throws when a mark is missing. */
export function between(text: string, marks: readonly [string, string], body: string): string {
  const start = text.indexOf(marks[0]);
  const end = text.indexOf(marks[1]);
  if (start < 0 || end < start) throw new Error(`missing ${marks[0]} … ${marks[1]}`);
  return `${text.slice(0, start + marks[0].length)}\n${body}\n${text.slice(end)}`;
}
