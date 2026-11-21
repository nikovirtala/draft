import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  attentionText,
  availableMoves,
  type BlockInfo,
  type Entry,
  emptyLayout,
  enterFocus,
  type Home,
  type Layout,
  leaveFocus,
  MOVE_TYPES,
  type MoveType,
  move,
  PLACEMENTS,
  type Placement,
  type PlacementChange,
  panelBlock,
  parseLayout,
  register,
  splitAttention,
  stubs,
} from "../src/shared/placement.ts";

const MAIN = "local/main";
const T1 = "local/t1";
const T2 = "local/t2";
const NESTED = "local/nested";
const AT = "2026-11-21T10:00:00.000Z";

const info = (
  address: string,
  kind: string,
  home: string,
  depth: number,
  opens: string | null = null,
): BlockInfo => ({ address, kind, home, depth, opens, title: `title of ${address}` });

/** Blocks of every kind and level: threads of the main conversation, statuses in main and in threads. */
const UNIVERSE: BlockInfo[] = [
  info(T1, "thread", MAIN, 0, T1),
  info(T2, "thread", MAIN, 0, T2),
  info("main/s1", "status", MAIN, 0),
  info("main/s2", "status", MAIN, 0),
  info("main/map", "map", MAIN, 0),
  info("t1/s1", "status", T1, 1),
  info("t1/s2", "status", T1, 1),
  info("t2/s1", "status", T2, 1),
  info(NESTED, "thread", T1, 1, NESTED),
];

const initial = (placement: Placement, returnTo: Home = "inline") => ({
  placement,
  returnTo: placement === "inline" || placement === "minimized" ? placement : returnTo,
});

type Op =
  | { op: "register"; block: number; placement: Placement; returnTo: Home }
  | { op: "move"; block: number; type: MoveType }
  | { op: "agent-move"; block: number; type: MoveType }
  | { op: "focus-block"; block: number }
  | { op: "focus-conversation"; conversation: string }
  | { op: "leave" };

const block = fc.integer({ min: 0, max: UNIVERSE.length - 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant("register" as const),
      block,
      placement: fc.constantFrom(...PLACEMENTS),
      returnTo: fc.constantFrom("inline" as const, "minimized" as const),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      op: fc.constant("move" as const),
      block,
      type: fc.constantFrom(...MOVE_TYPES),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("agent-move" as const),
      block,
      type: fc.constantFrom(...MOVE_TYPES),
    }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("focus-block" as const), block }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("focus-conversation" as const),
      conversation: fc.constantFrom(MAIN, T1, T2),
    }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("leave" as const) }) },
);

function apply(layout: Layout, op: Op): { layout: Layout; changes: PlacementChange[] } {
  switch (op.op) {
    case "register": {
      const r = register(
        layout,
        UNIVERSE[op.block] as BlockInfo,
        initial(op.placement, op.returnTo),
        AT,
      );
      return r;
    }
    case "move": {
      const r = move(
        layout,
        { type: op.type, block: (UNIVERSE[op.block] as BlockInfo).address },
        "user",
        AT,
      );
      return r.ok ? { layout: r.layout, changes: r.changes } : { layout, changes: [] };
    }
    case "agent-move": {
      const r = move(
        layout,
        { type: op.type, block: (UNIVERSE[op.block] as BlockInfo).address },
        "agent",
        AT,
      );
      expect(r.ok).toBe(false);
      expect(r.layout).toBe(layout);
      return { layout, changes: [] };
    }
    case "focus-block":
      return enterFocus(layout, { block: (UNIVERSE[op.block] as BlockInfo).address }, AT);
    case "focus-conversation":
      return enterFocus(layout, { conversation: op.conversation }, AT);
    case "leave":
      return leaveFocus(layout, AT);
  }
}

const entries = (l: Layout): Entry[] => Object.values(l.blocks);

function invariants(l: Layout, infos: Map<string, BlockInfo>): void {
  // At most one block in the panel, and never one made inside a thread.
  expect(entries(l).filter((e) => e.placement === "panel").length).toBeLessThanOrEqual(1);
  for (const e of entries(l)) {
    if (e.info.depth > 0) expect(e.placement).not.toBe("panel");
    // Moving never changes content.
    expect(e.info).toEqual(infos.get(e.info.address));
    // A block waiting inline or minimized goes back to exactly there.
    if (e.placement === "inline" || e.placement === "minimized")
      expect(e.returnTo).toBe(e.placement);
    // Exactly one stub for each block that moved to the panel or a window, and none for the rest.
    const s = stubs(l).filter((x) => x.block === e.info.address);
    expect(s.length).toBe(e.placement === "panel" || e.placement === "window" ? 1 : 0);
    if (s[0] !== undefined) {
      expect(s[0].home).toBe(e.info.home);
      expect(s[0].where).toBe(e.placement);
    }
  }
  expect(stubs(l).length).toBe(
    entries(l).filter((e) => e.placement === "panel" || e.placement === "window").length,
  );
  if (l.focus !== null) {
    // Whatever is folded is folded: nothing but the focused block and its thread stays open
    // unless a person moved it.
    expect(l.focus.conversation).toMatch(/^local\//);
  }
}

describe("placement: the model's table", () => {
  const e = (placement: Placement, depth = 0): Entry => ({
    info: info("x", "status", MAIN, depth),
    placement,
    returnTo: "inline",
  });

  it("gives each placement its icons", () => {
    expect(availableMoves(e("inline"))).toEqual(["minimize", "open-in-panel", "pop-out"]);
    expect(availableMoves(e("minimized"))).toEqual(["expand", "open-in-panel", "pop-out"]);
    expect(availableMoves(e("panel"))).toEqual(["pop-out", "close"]);
    expect(availableMoves(e("window"))).toEqual(["close"]);
  });

  it("takes the panel away from a block made inside a thread", () => {
    expect(availableMoves(e("inline", 1))).toEqual(["minimize", "pop-out"]);
    expect(availableMoves(e("minimized", 1))).toEqual(["expand", "pop-out"]);
  });
});

describe("placement: moves", () => {
  const status = info("main/s1", "status", MAIN, 0);
  const inThread = info("t1/s1", "status", T1, 1);
  const layoutOf = (...infos: BlockInfo[]): Layout =>
    infos.reduce((l, i) => register(l, i, initial("inline"), AT).layout, emptyLayout());

  it("pops a block out and closes it back to where it came from", () => {
    let l = layoutOf(status);
    l = move(l, { type: "minimize", block: status.address }, "user", AT).layout;
    const popped = move(l, { type: "pop-out", block: status.address }, "user", AT);
    expect(popped.ok && popped.changes).toEqual([
      {
        block: status.address,
        kind: "status",
        from: "minimized",
        to: "window",
        at: AT,
        cause: "user",
      },
    ]);
    l = popped.layout;
    expect(stubs(l)).toEqual([
      { block: status.address, kind: "status", home: MAIN, title: status.title, where: "window" },
    ]);
    const closed = move(l, { type: "close", block: status.address }, "user", AT);
    expect(closed.layout.blocks[status.address]?.placement).toBe("minimized");
    expect(stubs(closed.layout)).toEqual([]);
  });

  it("returns a block popped out of the panel to the place it came from", () => {
    let l = layoutOf(status);
    l = move(l, { type: "open-in-panel", block: status.address }, "user", AT).layout;
    l = move(l, { type: "pop-out", block: status.address }, "user", AT).layout;
    l = move(l, { type: "close", block: status.address }, "user", AT).layout;
    expect(l.blocks[status.address]?.placement).toBe("inline");
  });

  it("holds one block in the panel: a second takes it and the first returns", () => {
    let l = layoutOf(status, info("main/s2", "status", MAIN, 0));
    l = move(l, { type: "minimize", block: "main/s2" }, "user", AT).layout;
    l = move(l, { type: "open-in-panel", block: status.address }, "user", AT).layout;
    const r = move(l, { type: "open-in-panel", block: "main/s2" }, "user", AT);
    expect(r.ok && r.changes.map((c) => [c.block, c.to, c.cause])).toEqual([
      [status.address, "inline", "displaced"],
      ["main/s2", "panel", "user"],
    ]);
    expect(panelBlock(r.layout)?.info.address).toBe("main/s2");
  });

  it("refuses the panel for a block made inside a thread, and says why", () => {
    const l = layoutOf(inThread);
    const r = move(l, { type: "open-in-panel", block: inThread.address }, "user", AT);
    expect(r).toMatchObject({ ok: false, reason: "no-panel-at-this-depth" });
    const w = move(l, { type: "pop-out", block: inThread.address }, "user", AT);
    expect(w.ok).toBe(true);
  });

  it("registers a block made inside a thread out of the panel even when asked", () => {
    const l = register(
      emptyLayout(),
      inThread,
      { placement: "panel", returnTo: "inline" },
      AT,
    ).layout;
    expect(l.blocks[inThread.address]?.placement).not.toBe("panel");
  });

  it("never lets the agent move a block: it can only suggest", () => {
    const l = layoutOf(status);
    const r = move(l, { type: "pop-out", block: status.address }, "agent", AT);
    expect(r).toMatchObject({ ok: false, reason: "agent-cannot-move" });
    expect(r.layout).toBe(l);
  });

  it("keeps a block registered where it is when it is seen again", () => {
    let l = layoutOf(status);
    l = move(l, { type: "minimize", block: status.address }, "user", AT).layout;
    expect(register(l, status, initial("inline"), AT).layout).toBe(l);
  });

  it("opens a new thread in the panel and records the block it displaced", () => {
    let l = layoutOf(status);
    l = move(l, { type: "open-in-panel", block: status.address }, "user", AT).layout;
    const t = info(T1, "thread", MAIN, 0, T1);
    const r = register(l, t, { placement: "panel", returnTo: "minimized" }, AT);
    expect(panelBlock(r.layout)?.info.address).toBe(T1);
    expect(r.layout.blocks[T1]?.returnTo).toBe("minimized");
    expect(r.changes.map((c) => [c.block, c.from, c.to, c.cause])).toEqual([
      [status.address, "panel", "inline", "displaced"],
    ]);
  });

  it("reads a stored layout, and starts empty from one that is broken", () => {
    const l = layoutOf(status);
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(
      parseLayout({ blocks: { wrong: { ...l.blocks[status.address] } }, focus: null }),
    ).toEqual(emptyLayout());
    expect(parseLayout("nonsense")).toEqual(emptyLayout());
  });
});

describe("focus", () => {
  function scene(): Layout {
    let l = emptyLayout();
    const put = (i: BlockInfo, p: Placement, returnTo: Home = "inline") => {
      l = register(l, i, initial(p, returnTo), AT).layout;
    };
    put(info(T1, "thread", MAIN, 0, T1), "panel", "minimized");
    put(info(T2, "thread", MAIN, 0, T2), "minimized");
    put(info("main/s1", "status", MAIN, 0), "inline");
    put(info("main/s2", "status", MAIN, 0), "window", "minimized");
    put(info("t1/s1", "status", T1, 1), "inline");
    put(info("t1/s2", "status", T1, 1), "window", "inline");
    put(info("t2/s1", "status", T2, 1), "inline");
    return l;
  }
  const where = (l: Layout) =>
    Object.fromEntries(entries(l).map((e) => [e.info.address, [e.placement, e.returnTo]]));

  it("minimizes everything but the focused block and its thread, and leaving restores it exactly", () => {
    const before = scene();
    const entered = enterFocus(before, { block: "t1/s1" }, AT);
    const w = where(entered.layout);
    expect(w["t1/s1"]).toEqual(["inline", "inline"]);
    expect(w[T1]).toEqual(["panel", "minimized"]);
    for (const k of [T2, "main/s1", "main/s2", "t1/s2", "t2/s1"])
      expect(w[k]?.[0]).toBe("minimized");
    expect(entered.changes.every((c) => c.cause === "focus")).toBe(true);
    const left = leaveFocus(entered.layout, AT);
    expect(left.layout).toEqual(before);
    expect(left.changes.every((c) => c.cause === "focus-restore")).toBe(true);
  });

  it("refuses moves of blocks that focus folded, and allows the focused one", () => {
    const entered = enterFocus(scene(), { block: "t1/s1" }, AT).layout;
    expect(move(entered, { type: "expand", block: "main/s1" }, "user", AT)).toMatchObject({
      ok: false,
      reason: "folded-by-focus",
    });
    const popped = move(entered, { type: "pop-out", block: "t1/s1" }, "user", AT);
    expect(popped.ok).toBe(true);
  });

  it("restores a window and the panel to where they were, even when the focused block took the panel", () => {
    const before = scene();
    let l = enterFocus(before, { block: "main/s1" }, AT).layout;
    const r = move(l, { type: "open-in-panel", block: "main/s1" }, "user", AT);
    expect(r.ok).toBe(true);
    l = r.layout;
    l = leaveFocus(l, AT).layout;
    for (const [k, v] of Object.entries(where(before))) {
      if (k !== "main/s1") expect(where(l)[k]).toEqual(v);
    }
    expect(entries(l).filter((e) => e.placement === "panel")).toHaveLength(1);
  });

  it("starts a block that appears during focus folded, and puts it where it belongs afterwards", () => {
    let l = enterFocus(scene(), { block: "t1/s1" }, AT).layout;
    const fresh = info("main/new", "status", MAIN, 0);
    l = register(l, fresh, initial("inline"), AT).layout;
    expect(l.blocks["main/new"]?.placement).toBe("minimized");
    l = leaveFocus(l, AT).layout;
    expect(l.blocks["main/new"]?.placement).toBe("inline");
  });

  it("focuses a conversation: every block folds except its own thread", () => {
    const l = enterFocus(scene(), { conversation: T2 }, AT).layout;
    expect(l.focus).toMatchObject({ conversation: T2, block: null });
    expect(where(l)[T2]?.[0]).toBe("minimized");
    expect(where(l)[T1]?.[0]).toBe("minimized");
    expect(where(l)["main/s1"]?.[0]).toBe("minimized");
  });

  it("moves focus without losing the layout from before it", () => {
    const before = scene();
    let l = enterFocus(before, { block: "t1/s1" }, AT).layout;
    l = enterFocus(l, { block: "main/s1" }, AT).layout;
    expect(l.focus?.conversation).toBe(MAIN);
    expect(leaveFocus(l, AT).layout).toEqual(before);
  });

  it("leaves a block where its owner put it when it was moved during focus", () => {
    let l = enterFocus(scene(), { block: "t1/s1" }, AT).layout;
    l = move(l, { type: "pop-out", block: "t1/s1" }, "user", AT).layout;
    l = leaveFocus(l, AT).layout;
    expect(l.blocks["t1/s1"]?.placement).toBe("window");
  });

  it("does nothing when leaving without focus, or focusing a block that doesn't exist", () => {
    const l = scene();
    expect(leaveFocus(l, AT)).toEqual({ layout: l, changes: [] });
    expect(enterFocus(l, { block: "nope" }, AT)).toEqual({ layout: l, changes: [] });
  });
});

describe("attention", () => {
  const items = [
    { conversation: MAIN },
    { conversation: T1 },
    { conversation: T1 },
    { conversation: T2 },
  ];
  it("counts everything as in focus when nothing is focused", () => {
    expect(splitAttention(items, null)).toEqual({ inFocus: 4, elsewhere: 0 });
    expect(attentionText({ inFocus: 4, elsewhere: 0 }, false)).toBe("4 need you");
    expect(attentionText({ inFocus: 1, elsewhere: 0 }, false)).toBe("1 needs you");
    expect(attentionText({ inFocus: 0, elsewhere: 0 }, false)).toBe("");
  });
  it("filters by the focused conversation", () => {
    expect(splitAttention(items, { conversation: T1 })).toEqual({ inFocus: 2, elsewhere: 2 });
    expect(attentionText({ inFocus: 2, elsewhere: 2 }, true)).toBe("2 in focus, 2 elsewhere");
  });
});

describe("placement: properties", () => {
  const infos = new Map(UNIVERSE.map((i) => [i.address, i]));

  it("any sequence of moves keeps the rules, records every change and never lets the agent move a block", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        let layout = emptyLayout();
        // What the recorded changes alone say each block's placement is.
        const shadow = new Map<string, Placement>();
        for (const op of ops) {
          const before = layout;
          const r = apply(layout, op);
          layout = r.layout;
          if (op.op === "agent-move") expect(layout).toBe(before);
          for (const e of entries(layout))
            if (!shadow.has(e.info.address) && !before.blocks[e.info.address])
              shadow.set(e.info.address, e.placement);
          for (const c of r.changes) {
            expect(shadow.get(c.block)).toBe(c.from);
            shadow.set(c.block, c.to);
          }
          invariants(layout, infos);
          for (const e of entries(layout)) expect(shadow.get(e.info.address)).toBe(e.placement);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("leaving focus after entering it and moving the focused block restores every other block exactly", () => {
    const setup = fc.array(
      fc.oneof(
        fc.record({
          op: fc.constant("register" as const),
          block,
          placement: fc.constantFrom(...PLACEMENTS),
          returnTo: fc.constantFrom("inline" as const, "minimized" as const),
        }),
        fc.record({
          op: fc.constant("move" as const),
          block,
          type: fc.constantFrom(...MOVE_TYPES),
        }),
      ),
      { maxLength: 40 },
    );
    const during = fc.array(fc.constantFrom(...MOVE_TYPES), { maxLength: 12 });
    fc.assert(
      fc.property(
        setup,
        block,
        during,
        fc.array(block, { maxLength: 4 }),
        (ops, focused, moves, arrivals) => {
          let l0 = emptyLayout();
          for (const op of ops) l0 = apply(l0, op).layout;
          // Focus needs a block that exists.
          const x = UNIVERSE[focused] as BlockInfo;
          l0 = register(l0, x, initial("inline"), AT).layout;
          let l = enterFocus(l0, { block: x.address }, AT).layout;
          // Blocks that appear while focused.
          const late = new Map<string, Placement>();
          for (const a of arrivals) {
            const i = UNIVERSE[a] as BlockInfo;
            if (l0.blocks[i.address] !== undefined || late.has(i.address)) continue;
            const wanted = initial("inline");
            late.set(i.address, wanted.placement);
            l = register(l, i, wanted, AT).layout;
          }
          for (const type of moves) {
            const r = move(l, { type, block: x.address }, "user", AT);
            if (r.ok) l = r.layout;
            invariants(l, infos);
          }
          l = leaveFocus(l, AT).layout;
          expect(l.focus).toBeNull();
          for (const e of entries(l0)) {
            if (e.info.address === x.address) continue;
            expect([
              e.info.address,
              l.blocks[e.info.address]?.placement,
              l.blocks[e.info.address]?.returnTo,
            ]).toEqual([e.info.address, e.placement, e.returnTo]);
          }
          for (const [address, placement] of late) {
            if (address !== x.address) expect(l.blocks[address]?.placement).toBe(placement);
          }
          invariants(l, infos);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("entering focus again and leaving restores the layout from before the first focus", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), block, block, (ops, a, b) => {
        let l0 = emptyLayout();
        for (const op of ops)
          if (op.op === "register" || op.op === "move") l0 = apply(l0, op).layout;
        for (const i of [a, b])
          l0 = register(l0, UNIVERSE[i] as BlockInfo, initial("inline"), AT).layout;
        let l = enterFocus(l0, { block: (UNIVERSE[a] as BlockInfo).address }, AT).layout;
        l = enterFocus(l, { block: (UNIVERSE[b] as BlockInfo).address }, AT).layout;
        l = leaveFocus(l, AT).layout;
        expect(l).toEqual({ ...l0, focus: null });
      }),
      { numRuns: 300 },
    );
  });
});
