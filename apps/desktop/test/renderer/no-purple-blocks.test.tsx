// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { MapBlockFull, MapStub } from "../../src/renderer/src/components/MapBlock.tsx";
import { StatusBlock, StatusStub } from "../../src/renderer/src/components/StatusStub.tsx";
import { ThreadStub } from "../../src/renderer/src/components/ThreadStub.tsx";
import type { Thread } from "../../src/shared/ipc.ts";
import type { Entry } from "../../src/shared/placement.ts";
import {
  bridge,
  emptyMap,
  inWorkspace,
  type Mounted,
  mount,
  pullRequestStub,
  workspace,
} from "./harness.tsx";

/**
 * No block is filled with purple. moved-selected is the chosen option of a list or a control, and
 * moved-fill is a chip or a hover; a stub, a thread stub, a block in the panel or a window, and
 * their headers stay on their own ground when they are selected, expanded, open in the panel or
 * have focus inside them. Keyboard focus on a block is a ring, through :focus-visible only.
 */

const styles = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/renderer/src/styles.css"),
  "utf8",
);

const PURPLE = new Set(["--moved-selected", "--moved-fill"]);

interface Rule {
  selectors: string[];
  body: string;
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

const rules: Rule[] = [
  ...styles
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/:root\s*\{[^}]*\}/, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({ selectors: topLevel((m[1] as string).trim()), body: m[2] as string }));

/** The rules that put moved-selected or moved-fill behind what they select. */
const fills = rules.filter((r) =>
  [...r.body.matchAll(/background(?:-color)?\s*:\s*var\((--[a-z-]+)\)/g)].some((m) =>
    PURPLE.has(m[1] as string),
  ),
);

/** A selector with the states a block can be in taken as given: hover, focus and the like. */
const asIfActive = (selector: string): string =>
  selector.replace(/:(?:hover|focus-within|focus-visible|focus|active)\b/g, "");

const BLOCKS = ".stub, .thread-stub, .block-full, .block-header, .stub-line, .map-stub, .panel";

const thread = (): Thread => ({
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
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("no block is filled with purple", () => {
  it("has no rule that puts moved-selected or moved-fill behind a block, a header or a selection", () => {
    expect(fills.length).toBeGreaterThan(5);
    const offending: string[] = [];
    for (const r of fills)
      for (const s of r.selectors) {
        const last = subject(s);
        if (
          /data-selected|focus-within/.test(s) ||
          /\.(?:stub|thread-stub|block-full|block-header|stub-line|map-stub|panel|thread-view)(?![\w-])/.test(
            last,
          )
        )
          offending.push(s);
      }
    expect(offending).toEqual([]);
  });

  it("keeps moved-selected for the chosen option: a list row, a segmented control, a map cell", () => {
    const selected = rules
      .filter((r) => /background(?:-color)?\s*:\s*var\(--moved-selected\)/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(selected.some((s) => s.includes(".context-item-button"))).toBe(true);
    expect(selected.some((s) => s.includes(".map-range label.on"))).toBe(true);
    expect(selected.some((s) => s.includes(".map-cell.selected"))).toBe(true);
    // Nothing else of the blocks' own: no stub, header or block selector among them.
    expect(
      selected.filter((s) => /\.(stub|thread-stub|block-full|block-header|panel)\b/.test(s)),
    ).toEqual([]);
  });

  it("draws no mounted block, selected or not, expanded or open in the panel, on a purple rule", async () => {
    bridge({ map: async () => emptyMap({ totals: { items: 1, open: 1, waitingOnPerson: 0 } }) });
    const entry =
      (placement: Entry["placement"], kind: Entry["info"]["kind"], opens: string | null = null) =>
      (address: string) =>
        ({
          placement,
          returnTo: "minimized",
          info: { address, kind, home: "local/main", depth: 0, opens, title: "x" },
        }) as unknown as Entry;
    const seen = new Set<Element>();
    const stub = pullRequestStub("open");
    const t = thread();
    for (const selected of [false, true])
      for (const placement of ["inline", "minimized", "panel"] as const) {
        const ui = (address: string, el: React.ReactElement, kind: Entry["info"]["kind"]) =>
          inWorkspace(
            workspace({
              selection: { block: selected ? address : null, conversation: "local/main" },
              entry: entry(placement, kind, kind === "thread" ? t.conversation : null),
              threads: [t],
            }),
            el,
          );
        const target = { type: stub.type, id: stub.id };
        const address = `local@4#${target.type}:${target.id}`;
        const trees: [string, React.ReactElement, Entry["info"]["kind"]][] = [
          [
            address,
            <StatusStub
              key="s"
              from="local@4"
              conversation="local/main"
              target={target}
              stub={stub}
              snapshot={undefined}
            />,
            "status",
          ],
          [t.conversation, <ThreadStub key="t" thread={t} />, "thread"],
          [
            "local/main@1#map",
            <MapStub key="m" message="local/main@1" conversation="local/main" />,
            "map",
          ],
        ];
        for (const [a, el, kind] of trees) {
          mounted = await mount(ui(a, el, kind));
          for (const e of mounted.host.querySelectorAll("*")) seen.add(e);
          const blocks = [...mounted.host.querySelectorAll(BLOCKS)];
          expect(blocks.length, `${kind} draws a block`).toBeGreaterThan(0);
          if (selected && placement === "inline")
            expect(mounted.host.querySelector('[data-selected="true"]')).not.toBeNull();
          for (const r of fills)
            for (const s of r.selectors)
              for (const b of blocks)
                expect(
                  matches(b, asIfActive(s)),
                  `${s} fills a ${kind} block (${placement}, selected ${selected})`,
                ).toBe(false);
          await mounted.unmount();
          mounted = null;
        }
      }
    // And the blocks in full: a status block and the map, with their headers.
    for (const selected of [false, true]) {
      const full = (kind: "status" | "map") => {
        const address = kind === "map" ? "local/main@1#map" : `local@4#pull-request:${stub.id}`;
        const info = { address, kind, home: "local/main", depth: 0, opens: null, title: "x" };
        const e = { placement: "panel", returnTo: "minimized", info } as unknown as Entry;
        return inWorkspace(
          workspace({
            selection: { block: selected ? address : null, conversation: "local/main" },
            entry: () => e,
          }),
          kind === "map" ? (
            <MapBlockFull entry={e} />
          ) : (
            <StatusBlock
              entry={e}
              p={{
                from: "local@4",
                conversation: "local/main",
                target: { type: stub.type, id: stub.id },
                stub,
                snapshot: undefined,
              }}
            />
          ),
        );
      };
      for (const kind of ["status", "map"] as const) {
        mounted = await mount(full(kind));
        const blocks = [...mounted.host.querySelectorAll(BLOCKS)];
        expect(blocks.some((b) => b.classList.contains("block-header"))).toBe(true);
        for (const r of fills)
          for (const s of r.selectors)
            for (const b of blocks)
              expect(matches(b, asIfActive(s)), `${s} fills a ${kind} block's ${b.className}`).toBe(
                false,
              );
        await mounted.unmount();
        mounted = null;
      }
    }
    expect(seen.size).toBeGreaterThan(50);
  });

  it("draws the panel's and a window's header on the page colour, with or without focus inside", () => {
    const header = rules.filter(
      (r) => r.selectors.includes(".block-header") && /background/.test(r.body),
    );
    expect(header.length).toBe(1);
    expect(header[0]?.body).toMatch(/background:\s*var\(--page\)/);
    // No other rule changes it.
    const others = rules.filter((r) =>
      r.selectors.some(
        (s) => /\.block-header/.test(s) && s !== ".block-header" && /background/.test(r.body),
      ),
    );
    expect(others.map((r) => r.selectors)).toEqual([]);
  });

  it("shows keyboard focus on a block as a 1.5px moved-mark ring through :focus-visible only", () => {
    const ring = rules.find((r) =>
      r.selectors.some((s) => s.includes(".stub") && s.includes(":focus-visible")),
    );
    expect(ring?.selectors.join(" ")).toMatch(/\.thread-stub/);
    expect(ring?.selectors.join(" ")).toMatch(/\.block-full/);
    expect(ring?.body).toMatch(/outline:\s*1\.5px solid var\(--moved-mark\)/);
    expect(ring?.body).not.toMatch(/background/);
    // Nothing draws an outline on a block by its selection or by a plain :focus.
    const loose = rules.filter(
      (r) =>
        /outline/.test(r.body) &&
        r.selectors.some(
          (s) => /\.(?:stub|thread-stub|block-full)\b/.test(s) && !s.includes(":focus-visible"),
        ),
    );
    expect(loose.map((r) => r.selectors)).toEqual([]);
  });
});

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

/** Whether the selector selects the element; one this DOM can't read selects nothing. */
function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}
