import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** styles.css read as a list of rules, for the tests that check a design rule on the stylesheet. */

export const STYLES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/renderer/src/styles.css",
);

export interface Rule {
  selectors: string[];
  /** The declarations as written, between the braces. */
  body: string;
  /** The condition of the `@media` the rule is in, or null. */
  media: string | null;
}

/** Splits a selector list at the commas that are not inside parentheses. */
export function selectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(at, i).trim());
      at = i + 1;
    }
  }
  out.push(list.slice(at).trim());
  return out.filter((s) => s !== "");
}

/** The index of the brace that closes the one opened just before `from`. */
function closing(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  throw new Error("styles.css: a brace is never closed");
}

function parse(text: string, media: string | null, into: Rule[]): void {
  let at = 0;
  for (;;) {
    const open = text.indexOf("{", at);
    if (open === -1) return;
    const prelude = text.slice(at, open).trim();
    const close = closing(text, open + 1);
    const inside = text.slice(open + 1, close);
    if (prelude.startsWith("@media")) parse(inside, prelude.slice(6).trim(), into);
    else if (!prelude.startsWith("@"))
      into.push({ selectors: selectorList(prelude), body: inside, media });
    at = close + 1;
  }
}

/** Every style rule of styles.css, in order, without comments, `:root`, `@keyframes` and the like. */
export function rulesOf(css: string = readFileSync(STYLES, "utf8")): Rule[] {
  const rules: Rule[] = [];
  parse(css.replace(/\/\*[\s\S]*?\*\//g, ""), null, rules);
  return rules.filter((r) => !r.selectors.includes(":root"));
}

/** `[property, value]` of every declaration of a rule body. */
export function declarationsOf(body: string): [string, string][] {
  return [...body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);?/g)].map((m) => [
    m[1] as string,
    (m[2] as string).trim(),
  ]);
}
