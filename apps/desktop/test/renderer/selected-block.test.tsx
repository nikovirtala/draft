// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { StatusStub } from "../../src/renderer/src/components/StatusStub.tsx";
import { ThreadStub } from "../../src/renderer/src/components/ThreadStub.tsx";
import type { Thread } from "../../src/shared/ipc.ts";
import {
  ACCEPTED_BELOW_AA,
  contrast,
  TEXT_CONTRAST,
  TOKENS,
  type Token,
} from "../../src/shared/palette.ts";
import type { Entry } from "../../src/shared/placement.ts";
import {
  bridge,
  inWorkspace,
  type Mounted,
  mount,
  pullRequestStub,
  workspace,
} from "./harness.tsx";

/** One rule of styles.css: its selectors, and the colour tokens it names in `color` and `background`. */
interface Rule {
  selectors: string[];
  color: Token | null;
  background: Token | null;
  borderColor: Token | null;
}

/** Splits at the commas that are not inside parentheses. */
function topLevel(list: string): string[] {
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

function token(body: string, property: string): Token | null {
  const m = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*var\\((--[a-z0-9-]+)\\)\\s*;`).exec(body);
  return (m?.[1] as Token | undefined) ?? null;
}

function rules(): Rule[] {
  const css = styles.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:root\s*\{[^}]*\}/, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: topLevel((m[1] as string).trim()),
    color: token(m[2] as string, "color"),
    background: token(m[2] as string, "background"),
    borderColor: token(m[2] as string, "border-color"),
  }));
}

/** The last compound of a selector: the element it styles. */
function subject(selector: string): string {
  let depth = 0;
  for (let i = selector.length - 1; i >= 0; i--) {
    const c = selector[i];
    if (c === ")") depth++;
    else if (c === "(") depth--;
    else if ((c === " " || c === ">") && depth === 0) return selector.slice(i + 1);
  }
  return selector;
}

const classesOf = (selector: string): string[] =>
  [
    ...subject(selector)
      .replace(/:[a-z-]+\([^)]*\)/g, "")
      .matchAll(/\.([a-z][a-z0-9_-]*)/gi),
  ].map((m) => m[1] as string);

/** A rule that draws a block as the one in focus. */
const isSelectedRule = (r: Rule): boolean =>
  r.selectors.some((s) => /data-selected="true"|thread-view:focus-within/.test(s));

const thread = (over: Partial<Thread> = {}): Thread => ({
  conversation: "local/main/t1",
  parent: "local@2",
  parentConversation: "local/main",
  title: "The map as a graph",
  state: "wrapped-up",
  depth: 0,
  agent: "kiro",
  messages: 5,
  artifacts: 2,
  waiting: 1,
  conclusion: null,
  endedReason: null,
  busy: false,
  last: null,
  ...over,
});

const styles = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/renderer/src/styles.css"),
  "utf8",
);

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

/** Every class that appears inside the blocks that can be selected: stubs, in full and minimized. */
async function classesInBlocks(): Promise<Set<string>> {
  bridge({});
  const seen = new Set<string>();
  const entry = (placement: Entry["placement"], address: string, kind: Entry["info"]["kind"]) =>
    ({
      placement,
      returnTo: "minimized",
      info: { address, kind, home: "local/main", depth: 0, opens: null, title: "x" },
    }) as unknown as Entry;
  for (const placement of ["inline", "minimized", "panel"] as const) {
    for (const state of ["open", "merged", "closed"]) {
      const stub = pullRequestStub(state);
      mounted = await mount(
        inWorkspace(
          workspace({ entry: (a) => entry(placement, a, "status") }),
          <StatusStub
            from="local@4"
            conversation="local/main"
            target={{ type: stub.type, id: stub.id }}
            stub={stub}
            snapshot={undefined}
          />,
        ),
      );
      for (const el of mounted.host.querySelectorAll("section, section *"))
        for (const c of el.classList) seen.add(c);
      await mounted.unmount();
      mounted = null;
    }
  }
  for (const t of [thread(), thread({ state: "open", waiting: 0, busy: true, artifacts: 0 })]) {
    mounted = await mount(
      inWorkspace(
        workspace({ entry: (a) => entry("minimized", a, "thread"), threads: [t] }),
        <ThreadStub thread={t} />,
      ),
    );
    for (const el of mounted.host.querySelectorAll("section, section *"))
      for (const c of el.classList) seen.add(c);
    await mounted.unmount();
    mounted = null;
  }
  return seen;
}

const SELECTED: Token = "--moved-selected";
const ratio = (fg: Token, bg: Token): number =>
  contrast(TOKENS.get(fg)?.value as string, TOKENS.get(bg)?.value as string);

describe("a selected or focused block is drawn on moved-selected", () => {
  it("fills the stub, the thread stub and a block's header, and keeps no moved-mark hairline", () => {
    const selected = rules().filter(isSelectedRule);
    const fills = selected.filter((r) => r.background === SELECTED);
    const text = fills.flatMap((r) => r.selectors).join("\n");
    expect(text).toContain('.stub, .thread-stub)[data-selected="true"]');
    expect(text).toContain('.block-full[data-selected="true"] > .block-header');
    expect(text).toContain(".block-full.thread-view:focus-within > .block-header");
    expect(selected.filter((r) => r.borderColor === "--moved-mark")).toEqual([]);
  });

  it("reads every word inside it in ink or text: the pairs that are drawn all reach 4.5:1", async () => {
    const present = await classesInBlocks();
    // What a stub shows, so the test is about what is drawn and not about a list kept by hand.
    for (const c of ["stub-ref", "stub-status", "stub-title", "thread-agent", "thread-chip"])
      expect(present.has(c), `a ${c} is rendered`).toBe(true);

    const all = rules();
    const selected = all.filter(isSelectedRule);
    // Words that sit on the selected fill itself, and what each rule says to put there.
    const onSelected: { what: string; fg: Token }[] = [
      { what: "the block's own words", fg: "--ink" },
      { what: "the block's body words", fg: "--text" },
    ];
    // Chips carry their own fill: the pair is the chip's, and is not drawn on moved-selected.
    const onOwnFill: { what: string; fg: Token; bg: Token }[] = [];
    for (const r of all.filter((x) => !isSelectedRule(x))) {
      if (r.color === null) continue;
      for (const s of r.selectors) {
        const hit = classesOf(s).filter((c) => present.has(c));
        if (hit.length === 0) continue;
        if (r.background !== null) {
          onOwnFill.push({ what: s, fg: r.color, bg: r.background });
        } else if (r.color !== "--ink" && r.color !== "--text") {
          // A bare word that is not ink or text must be re-coloured inside a selected block.
          const overridden = selected.some(
            (o) =>
              (o.color === "--ink" || o.color === "--text") &&
              o.selectors.some((os) => hit.every((c) => os.includes(`.${c}`))),
          );
          expect(overridden, `${s}: ${r.color} on ${SELECTED} needs a selected-block rule`).toBe(
            true,
          );
          onSelected.push({
            what: s,
            fg: selected.find((o) =>
              o.selectors.some((os) => hit.every((c) => os.includes(`.${c}`))),
            )?.color as Token,
          });
        } else onSelected.push({ what: s, fg: r.color });
      }
    }
    expect(onSelected.length).toBeGreaterThan(4);
    // The pairs on moved-selected, once each: ink and text, and nothing else.
    expect([...new Set(onSelected.map((p) => `${p.fg} on ${SELECTED}`))].sort()).toEqual([
      `--ink on ${SELECTED}`,
      `--text on ${SELECTED}`,
    ]);
    const accepted = (fg: Token, bg: Token) =>
      ACCEPTED_BELOW_AA.some(([f, b]) => f === fg && b === bg);

    const under: string[] = [];
    for (const p of onSelected)
      if (ratio(p.fg, SELECTED) < TEXT_CONTRAST)
        under.push(`${p.what}: ${p.fg} on ${SELECTED} ${ratio(p.fg, SELECTED).toFixed(2)}`);
    for (const p of onOwnFill)
      if (!accepted(p.fg, p.bg) && ratio(p.fg, p.bg) < TEXT_CONTRAST)
        under.push(`${p.what}: ${p.fg} on ${p.bg} ${ratio(p.fg, p.bg).toFixed(2)}`);
    expect(under).toEqual([]);

    // The pairs the design system quotes for moved-selected.
    expect(ratio("--ink", SELECTED)).toBeGreaterThan(5.2);
    expect(ratio("--text", SELECTED)).toBeGreaterThan(4.7);
    // And the ones that fail there, which is why they are re-coloured.
    expect(ratio("--muted", SELECTED)).toBeLessThan(TEXT_CONTRAST);
    expect(ratio("--moved-strong", SELECTED)).toBeLessThan(TEXT_CONTRAST);
    expect(ratio("--done-word", SELECTED)).toBeLessThan(TEXT_CONTRAST);
    expect(ratio("--review-word", SELECTED)).toBeLessThan(TEXT_CONTRAST);
    expect(ratio("--waiting-word", SELECTED)).toBeLessThan(TEXT_CONTRAST);
  });
});
