import { ARK_ID } from "./ark-issue.ts";

/**
 * What a merged pull request still leaves for a person: the items of its "After deploy" section,
 * read as checks. AGENTS.md says how to write the section; this is the one parse of it, and it
 * reads what agents wrote before the shape was settled too (docs/model.md, "Checks").
 *
 * - `Nothing` or `None` (with a reason after it, if the writer gave one) means no check.
 * - Each top-level bullet is one check. Its first lines are its reason (a bold lead is its title),
 *   a numbered list inside it holds its steps, and a bullet with no list is one step.
 * - A numbered list at the top of the section, with the text before it as its reason, is one check.
 * - Anything else is one check that shows the Markdown as written. Nothing is ever dropped: text
 *   after a list is kept as the check's `tail`, and every check keeps its `raw` Markdown.
 */

/** One step of a check: what to do, and what the person should then see. */
export interface CheckStep {
  /** The step as written, Markdown. */
  text: string;
  /** The part before "You should see", Markdown. */
  do: string;
  /** From "You should see" to the end, or null when the step doesn't say. */
  see: string | null;
  /** What can be copied: fenced blocks and multi-word code spans of `do`, as typed, in order. */
  commands: string[];
}

export interface AfterDeployItem {
  /** Its place among the section's items, from 0. */
  index: number;
  title: string;
  /** Why only a person can check it, Markdown; empty when the item gave none apart from its step. */
  reason: string;
  steps: CheckStep[];
  /** What follows the steps, Markdown; null when nothing does. */
  tail: string | null;
  /** The item's Markdown as written. */
  raw: string;
  /** False when it had no steps to read: the view then shows `raw`. */
  parsed: boolean;
  /** Words of the item that look like an ADR id, for the reader to check against the repositories. */
  adrCandidates: string[];
}

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})/;

/** The text under the "After deploy" heading, up to the next heading of the same or a higher level. */
export function afterDeploySection(body: string): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let level = 0;
  let start = -1;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = FENCE.exec(line);
    if (f !== null) {
      const mark = (f[2] as string)[0] as string;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = HEADING.exec(line);
    if (h === null) continue;
    const depth = (h[1] as string).length;
    if (start === -1) {
      if (/^after deploy\b/i.test(h[2] as string)) {
        start = i + 1;
        level = depth;
      }
    } else if (depth <= level) {
      return lines.slice(start, i).join("\n");
    }
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}

/** HTML comments, which the pull request template leaves its guidance in. Fenced code is kept. */
function withoutComments(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let chunk: string[] = [];
  const flush = () => {
    out.push(chunk.join("\n").replace(/<!--[\s\S]*?(?:-->|$)/g, ""));
    chunk = [];
  };
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (f !== null) {
      const mark = (f[2] as string)[0] as string;
      if (fence === null) {
        flush();
        fence = mark;
      } else if (fence === mark) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) out.push(line);
    else chunk.push(line);
  }
  flush();
  return out.join("\n");
}

/* ----------------------------------------------------------------------------------------------- */
/* Blocks                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

interface ListItem {
  /** `-` for a bullet, `1` for a numbered item. */
  kind: "bullet" | "number";
  /** The item's lines with the marker taken off and its continuation lines dedented. */
  lines: string[];
}

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "fence"; lines: string[] }
  | { type: "list"; kind: "bullet" | "number"; items: ListItem[] };

const MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;

const isBlank = (l: string): boolean => l.trim() === "";

const kindOf = (marker: string): "bullet" | "number" => (/^\d/.test(marker) ? "number" : "bullet");

/** The width of leading spaces, a tab counting as four. */
const indentOf = (l: string): number => {
  let n = 0;
  for (const c of l) {
    if (c === " ") n++;
    else if (c === "\t") n += 4;
    else break;
  }
  return n;
};

function dedent(line: string, by: number): string {
  let n = 0;
  let i = 0;
  while (i < line.length && n < by) {
    const c = line[i];
    if (c === " ") n++;
    else if (c === "\t") n += 4;
    else break;
    i++;
  }
  return line.slice(i);
}

/** Splits Markdown into its top-level blocks: paragraphs, fenced code and lists. */
export function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const f = FENCE.exec(line);
    if (f !== null) {
      const mark = (f[2] as string)[0] as string;
      const size = (f[2] as string).length;
      const body: string[] = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i] as string;
        body.push(l);
        i++;
        const close = FENCE.exec(l);
        if (
          close !== null &&
          (close[2] as string)[0] === mark &&
          (close[2] as string).length >= size
        )
          break;
      }
      blocks.push({ type: "fence", lines: body });
      continue;
    }
    const m = MARKER.exec(line);
    if (m !== null) {
      const kind = kindOf(m[2] as string);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const head = lines[i] as string;
        const hm = MARKER.exec(head);
        if (hm === null || kindOf(hm[2] as string) !== kind) break;
        const width = (hm[1] as string).length + (hm[2] as string).length + 1;
        const body: string[] = [head.slice(hm[0].length)];
        i++;
        const opening = FENCE.exec(body[0] as string);
        let fence: string | null = opening === null ? null : ((opening[2] as string)[0] as string);
        while (i < lines.length) {
          const l = lines[i] as string;
          if (fence !== null) {
            if (!isBlank(l) && indentOf(l) < width) break;
            const d = dedent(l, width);
            body.push(d);
            i++;
            const close = FENCE.exec(d);
            if (close !== null && (close[2] as string)[0] === fence) fence = null;
            continue;
          }
          if (isBlank(l)) {
            // A blank line stays in the item when what follows is still indented under it.
            let j = i;
            while (j < lines.length && isBlank(lines[j] as string)) j++;
            const next = lines[j];
            if (next !== undefined && indentOf(next) >= width) {
              for (; i < j; i++) body.push("");
              continue;
            }
            break;
          }
          if (indentOf(l) >= width) {
            const d = dedent(l, width);
            body.push(d);
            const open = FENCE.exec(d);
            if (open !== null) fence = (open[2] as string)[0] as string;
            i++;
            continue;
          }
          // A line that isn't indented continues the item's paragraph only when the line before
          // it is text, and it is not the start of another item or a fence.
          const prev = body[body.length - 1] as string;
          if (!isBlank(prev) && MARKER.exec(l) === null && FENCE.exec(l) === null) {
            body.push(l.trimStart());
            i++;
            continue;
          }
          break;
        }
        while (body.length > 0 && isBlank(body[body.length - 1] as string)) body.pop();
        items.push({ kind, lines: body });
        // Blank lines between two items of one list.
        let j = i;
        while (j < lines.length && isBlank(lines[j] as string)) j++;
        const next = lines[j];
        const nm = next === undefined ? null : MARKER.exec(next);
        if (nm !== null && kindOf(nm[2] as string) === kind) i = j;
        else break;
      }
      blocks.push({ type: "list", kind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (isBlank(l) || FENCE.test(l) || (para.length > 0 && MARKER.test(l))) break;
      para.push(l);
      i++;
    }
    blocks.push({ type: "paragraph", lines: para });
  }
  return blocks;
}

function textOf(blocks: readonly Block[]): string {
  return blocks
    .map((b) =>
      b.type === "list"
        ? b.items
            .map((it, n) => {
              const marker = it.kind === "bullet" ? "-" : `${n + 1}.`;
              const pad = " ".repeat(marker.length + 1);
              return it.lines
                .map((l, k) => (k === 0 ? `${marker} ${l}` : l === "" ? "" : `${pad}${l}`))
                .join("\n");
            })
            .join("\n")
        : b.lines.join("\n"),
    )
    .join("\n\n");
}

/* ----------------------------------------------------------------------------------------------- */
/* Steps                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

/** Where a step says what the person should see: the first of these outside a code span. */
const SEE =
  /\b(?:you\s+(?:should|will|'ll)\s+(?:see|get|find|read)|you\s+see|expect(?:ed)?\s*:?)\b/i;

/** The spans of a text that are inline code, as [start, end) ranges. */
function codeSpans(text: string): { start: number; end: number; code: string }[] {
  const out: { start: number; end: number; code: string }[] = [];
  const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
  for (const m of text.matchAll(re)) {
    const code = (m[2] as string).replace(/^ (.*) $/s, "$1");
    out.push({ start: m.index, end: m.index + m[0].length, code });
  }
  return out;
}

/** The commands in some Markdown: fenced blocks, and inline code of more than one word. */
function commandsIn(markdown: string): string[] {
  const out: string[] = [];
  const blocks = blocksOf(markdown);
  const prose: string[] = [];
  for (const b of blocks) {
    if (b.type === "fence") {
      const inner = b.lines.slice(1);
      const last = inner[inner.length - 1];
      if (last !== undefined && FENCE.test(last)) inner.pop();
      const code = inner.join("\n").trim();
      if (code !== "") out.push(code);
    } else prose.push(textOf([b]));
  }
  // Fences nested in a list inside the step are found by looking at the whole text again.
  for (const b of blocks)
    if (b.type === "list")
      for (const it of b.items)
        for (const c of commandsIn(it.lines.join("\n"))) if (!out.includes(c)) out.push(c);
  for (const p of prose)
    for (const s of codeSpans(p)) {
      const code = s.code.trim();
      if (code !== "" && /\s/.test(code) && !out.includes(code)) out.push(code);
    }
  return out;
}

function stepOf(text: string): CheckStep {
  const trimmed = text.trim();
  // Look for "You should see" outside code spans and fenced blocks.
  const masked = trimmed.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
  const m = SEE.exec(masked);
  const at = m === null ? -1 : m.index;
  const doText = (at === -1 ? trimmed : trimmed.slice(0, at)).trim();
  const see = at === -1 ? null : trimmed.slice(at).trim();
  return { text: trimmed, do: doText, see, commands: commandsIn(doText) };
}

/* ----------------------------------------------------------------------------------------------- */
/* Items                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

const strip = (s: string): string =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]+/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** A short name for a check: the first sentence of the text, without Markdown. */
function titleOf(text: string): string {
  const flat = strip(text);
  const sentence = /^(.+?[.!?:])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  const t = sentence.replace(/[.:]$/, "");
  return t.length > 90 ? `${t.slice(0, 89).trimEnd()}…` : t;
}

/** The ids in some text that look like ADR ids: 8 characters of adr's alphabet, as a word. */
export function adrCandidatesIn(text: string): string[] {
  const re = new RegExp(`(?<![0-9A-Za-z_-])(${ARK_ID})(?![0-9A-Za-z_-])`, "g");
  return [...new Set([...text.matchAll(re)].map((m) => m[1] as string))];
}

/** A bold lead (`**Title.**`) at the start of an item, and the text after it. */
function boldLead(text: string): { title: string; rest: string } | null {
  const m = /^\*\*(.+?)\*\*[ \t]*[:.\u2014-]?[ \t]*/s.exec(text);
  return m === null
    ? null
    : { title: strip(m[1] as string).replace(/[.:]$/, ""), rest: text.slice(m[0].length) };
}

function itemFromBlocks(
  index: number,
  lead: string,
  blocks: readonly Block[],
  raw: string,
  fallbackTitle: string,
): AfterDeployItem {
  const firstList = blocks.findIndex((b) => b.type === "list" && b.kind === "number");
  const stepBlock =
    firstList === -1 ? null : (blocks[firstList] as Extract<Block, { type: "list" }>);
  const before = firstList === -1 ? blocks : blocks.slice(0, firstList);
  const after = firstList === -1 ? [] : blocks.slice(firstList + 1);
  const bold = boldLead(lead);
  const reasonText = [bold === null ? lead : bold.rest, textOf(before)]
    .filter((t) => t.trim() !== "")
    .join("\n\n")
    .trim();
  const steps = stepBlock === null ? [] : stepBlock.items.map((it) => stepOf(it.lines.join("\n")));
  const tail = textOf(after).trim();
  const title =
    bold?.title ??
    (reasonText !== "" ? titleOf(reasonText) : steps[0] ? titleOf(steps[0].do) : fallbackTitle);
  return {
    index,
    title: title === "" ? fallbackTitle : title,
    reason: reasonText,
    steps,
    tail: tail === "" ? null : tail,
    raw,
    parsed: steps.length > 0,
    adrCandidates: adrCandidatesIn(raw),
  };
}

/** One bullet: its first paragraph is the reason, a numbered list inside it the steps. */
function bulletItem(index: number, it: ListItem): AfterDeployItem {
  const raw = it.lines.join("\n").trim();
  const blocks = blocksOf(raw);
  const first = blocks[0];
  const lead = first !== undefined && first.type === "paragraph" ? first.lines.join("\n") : "";
  const rest = first !== undefined && first.type === "paragraph" ? blocks.slice(1) : blocks;
  const item = itemFromBlocks(index, lead, rest, raw, `Check ${index + 1}`);
  if (item.parsed) return item;
  // A bullet with no steps of its own is one step: what it says to do, and what to see.
  const bold = boldLead(raw);
  const step = stepOf(bold === null ? raw : bold.rest === "" ? raw : bold.rest);
  return {
    ...item,
    reason: "",
    steps: [step],
    tail: null,
    parsed: true,
    title: bold?.title ?? titleOf(raw),
  };
}

/** The items of an "After deploy" section; empty when there is nothing to check. */
export function parseSection(section: string): AfterDeployItem[] {
  const text = withoutComments(section).trim();
  if (text === "") return [];
  if (
    /^[\s>*_`~]*(?:nothing|none)\s*(?:[.:;,!\u2014\u2013-]|$)/im.test(text.split("\n")[0] as string)
  )
    return [];
  const blocks = blocksOf(text);
  const firstList = blocks.findIndex((b) => b.type === "list");
  const list = firstList === -1 ? null : (blocks[firstList] as Extract<Block, { type: "list" }>);
  if (list !== null && list.kind === "bullet") {
    const items = list.items.map((it, i) => bulletItem(i, it));
    const rest = textOf(blocks.slice(firstList + 1)).trim();
    const intro = textOf(blocks.slice(0, firstList)).trim();
    const last = items[items.length - 1] as AfterDeployItem;
    if (rest !== "")
      items[items.length - 1] = {
        ...last,
        tail: [last.tail, rest].filter((t) => t !== null).join("\n\n"),
        raw: `${last.raw}\n\n${rest}`,
      };
    // Text before the list is what all of them share: it is each item's reason when it has none.
    return intro === ""
      ? items
      : items.map((it) => (it.reason === "" ? { ...it, reason: intro } : it));
  }
  // No bullets: one check. A numbered list is its steps and the text before it its reason.
  return [itemFromBlocks(0, "", blocks, text, "After deploy")];
}

/** The checks a pull request's body asks for: none when it says Nothing or has no such section. */
export function parseAfterDeploy(body: string): AfterDeployItem[] {
  const section = afterDeploySection(body);
  return section === null ? [] : parseSection(section);
}
