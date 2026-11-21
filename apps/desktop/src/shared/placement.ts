/**
 * Placement as a state machine: where every block lives, the moves between places, and focus.
 *
 * Everything here is pure: a layout goes in and a layout comes out, with the changes it made.
 * That keeps the rules testable on their own and keeps them out of the UI and out of the log.
 * Placement is view state, per device: nothing here is ever written to the log, and nothing here
 * assumes one screen layout across devices.
 *
 * The rules (model.md, "Core model: blocks and placements", "Focus"):
 * - Moving a block never changes its content. A block's `info` is fixed when it is registered; a
 *   move changes `placement` and `returnTo` only.
 * - A moved block leaves a stub where it was created, showing where it went.
 * - Only one level uses the panel: a block made inside a thread (`depth` above 0) is inline,
 *   minimized or in a window, never in the panel, and the panel holds one block at a time.
 * - The agent may suggest a move but never makes one: a move by the agent changes nothing.
 * - Focus minimizes every open block except the focused one and its thread. Leaving focus
 *   restores every block it changed, exactly.
 */

import { z } from "zod";

export const PLACEMENTS = ["inline", "minimized", "panel", "window"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** Where a block goes when its panel or window closes: the place it came from. */
export type Home = "inline" | "minimized";

/**
 * What a block is. A block is defined by its address and its kind, so the four placements work
 * for any kind: a thread, a live status, an artifact, later the map and the graph.
 */
export const BlockInfoSchema = z.object({
  address: z.string().min(1),
  kind: z.string().min(1),
  /** The conversation it was made in. Its stub stays there. */
  home: z.string().min(1),
  /** How many threads deep its home conversation is: 0 for the main conversation. */
  depth: z.number().int().min(0),
  /** For a block whose content is a conversation (a thread): that conversation. */
  opens: z.string().min(1).nullable(),
  /** What it is, for stubs and window titles. */
  title: z.string(),
});
export type BlockInfo = z.infer<typeof BlockInfoSchema>;

const PlacementSchema = z.enum(PLACEMENTS);
const HomeSchema = z.enum(["inline", "minimized"]);

export const EntrySchema = z.object({
  info: BlockInfoSchema,
  placement: PlacementSchema,
  returnTo: HomeSchema,
});
export type Entry = z.infer<typeof EntrySchema>;

/** What focus changed on its own, so that leaving it can put it back. */
const RestoreSchema = z.object({
  placement: PlacementSchema,
  returnTo: HomeSchema,
  /** Where focus put the block. Leaving restores it only if it is still there. */
  expect: PlacementSchema,
});
export type Restore = z.infer<typeof RestoreSchema>;

export const FocusSchema = z.object({
  /** The conversation in focus: attention is filtered by it. */
  conversation: z.string().min(1),
  /** The focused block, or null when a conversation itself is in focus. */
  block: z.string().min(1).nullable(),
  restore: z.record(z.string(), RestoreSchema),
});
export type Focus = z.infer<typeof FocusSchema>;

export const LayoutSchema = z.object({
  blocks: z.record(z.string(), EntrySchema),
  focus: FocusSchema.nullable(),
});
export type Layout = z.infer<typeof LayoutSchema>;

export const emptyLayout = (): Layout => ({ blocks: {}, focus: null });

/** Reads a stored layout; anything that doesn't check out starts from an empty one. */
export function parseLayout(raw: unknown): Layout {
  const r = LayoutSchema.safeParse(raw);
  if (!r.success) return emptyLayout();
  // A key that doesn't match its block's address is corrupt, so none of it is trusted.
  for (const [k, e] of Object.entries(r.data.blocks))
    if (k !== e.info.address) return emptyLayout();
  return r.data;
}

/* ----------------------------------------------------------------------------------------------- */
/* Moves                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

/** The icons a block can have: the only buttons. */
export const MOVE_TYPES = ["minimize", "expand", "open-in-panel", "pop-out", "close"] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export interface Move {
  type: MoveType;
  block: string;
}

/** Who asks for a move. Only a person moves blocks: the agent may suggest and nothing more. */
export type Mover = "user" | "agent";

/** One placement change, recorded on this device and never in the log. */
export interface PlacementChange {
  block: string;
  kind: string;
  from: Placement;
  to: Placement;
  at: string;
  /** Why it changed: the person's move, a block displaced from the panel, or focus. */
  cause: "user" | "displaced" | "focus" | "focus-restore";
}

export type Refusal =
  | "no-such-block"
  | "not-available"
  | "no-panel-at-this-depth"
  | "folded-by-focus"
  | "agent-cannot-move";

export type MoveResult =
  | { ok: true; layout: Layout; changes: PlacementChange[] }
  | { ok: false; reason: Refusal; layout: Layout };

/**
 * The model's table: the icons of each placement. A block made inside a thread has no "open in
 * panel", because the thread holds the panel.
 */
export function availableMoves(e: Entry): MoveType[] {
  const panel = e.info.depth === 0;
  switch (e.placement) {
    case "inline":
      return panel ? ["minimize", "open-in-panel", "pop-out"] : ["minimize", "pop-out"];
    case "minimized":
      return panel ? ["expand", "open-in-panel", "pop-out"] : ["expand", "pop-out"];
    case "panel":
      return ["pop-out", "close"];
    case "window":
      return ["close"];
  }
}

export function canUsePanel(info: BlockInfo): boolean {
  return info.depth === 0;
}

function target(e: Entry, type: MoveType): { placement: Placement; returnTo: Home } | null {
  switch (type) {
    case "minimize":
      return e.placement === "inline" ? { placement: "minimized", returnTo: "minimized" } : null;
    case "expand":
      return e.placement === "minimized" ? { placement: "inline", returnTo: "inline" } : null;
    case "open-in-panel":
      return e.placement === "inline" || e.placement === "minimized"
        ? { placement: "panel", returnTo: e.placement }
        : null;
    case "pop-out":
      // From the panel the block keeps the place it came from, so closing the window returns it.
      return e.placement === "inline" || e.placement === "minimized"
        ? { placement: "window", returnTo: e.placement }
        : e.placement === "panel"
          ? { placement: "window", returnTo: e.returnTo }
          : null;
    case "close":
      return e.placement === "panel" || e.placement === "window"
        ? { placement: e.returnTo, returnTo: e.returnTo }
        : null;
  }
}

/** The blocks focus keeps open: the focused block and its thread. */
export function keptByFocus(
  layout: Layout,
  focus: Pick<Focus, "block" | "conversation">,
): Set<string> {
  const kept = new Set<string>();
  if (focus.block !== null) kept.add(focus.block);
  for (const e of Object.values(layout.blocks)) {
    if (e.info.opens === focus.conversation) kept.add(e.info.address);
  }
  return kept;
}

function setEntry(layout: Layout, address: string, patch: Partial<Entry>): Layout {
  const e = layout.blocks[address] as Entry;
  return { ...layout, blocks: { ...layout.blocks, [address]: { ...e, ...patch } } };
}

/**
 * Puts `address` into `placement`, taking the panel from whoever holds it. The one place a
 * placement changes, so every change is recorded and focus can remember what it changed.
 */
function place(
  layout: Layout,
  address: string,
  to: { placement: Placement; returnTo: Home },
  cause: PlacementChange["cause"],
  at: string,
  changes: PlacementChange[],
): Layout {
  let next = layout;
  if (to.placement === "panel") {
    const holder = Object.values(next.blocks).find(
      (b) => b.placement === "panel" && b.info.address !== address,
    );
    if (holder !== undefined) {
      next = place(
        next,
        holder.info.address,
        { placement: holder.returnTo, returnTo: holder.returnTo },
        "displaced",
        at,
        changes,
      );
    }
  }
  const e = next.blocks[address] as Entry;
  if (e.placement === to.placement && e.returnTo === to.returnTo) return next;
  if (e.placement !== to.placement) {
    changes.push({
      block: address,
      kind: e.info.kind,
      from: e.placement,
      to: to.placement,
      at,
      cause,
    });
  }
  // Focus remembers what it, or a move made during it, changed to a block it hadn't asked about.
  const f = next.focus;
  if (
    f !== null &&
    (cause === "focus" || cause === "displaced") &&
    f.restore[address] === undefined &&
    f.block !== address
  ) {
    next = {
      ...next,
      focus: {
        ...f,
        restore: {
          ...f.restore,
          [address]: { placement: e.placement, returnTo: e.returnTo, expect: to.placement },
        },
      },
    };
  }
  return setEntry(next, address, { placement: to.placement, returnTo: to.returnTo });
}

/** Applies one move. A move the rules don't allow changes nothing and says why. */
export function move(
  layout: Layout,
  m: Move,
  mover: Mover = "user",
  at: string = new Date().toISOString(),
): MoveResult {
  const refuse = (reason: Refusal): MoveResult => ({ ok: false, reason, layout });
  if (mover !== "user") return refuse("agent-cannot-move");
  const e = layout.blocks[m.block];
  if (e === undefined) return refuse("no-such-block");
  if (layout.focus !== null && !keptByFocus(layout, layout.focus).has(m.block))
    return refuse("folded-by-focus");
  const to = target(e, m.type);
  if (to === null || !availableMoves(e).includes(m.type)) {
    return refuse(
      m.type === "open-in-panel" && !canUsePanel(e.info)
        ? "no-panel-at-this-depth"
        : "not-available",
    );
  }
  const changes: PlacementChange[] = [];
  const next = place(layout, m.block, to, "user", at, changes);
  return { ok: true, layout: next, changes };
}

/**
 * Registers a block the first time it is seen. A block that is already registered is left as it
 * is: seeing it again never moves it. While focus is on, a new block outside focus starts
 * minimized and goes to its own place when focus ends.
 */
export function register(
  layout: Layout,
  info: BlockInfo,
  initial: { placement: Placement; returnTo: Home } = { placement: "inline", returnTo: "inline" },
  at: string = new Date().toISOString(),
): { layout: Layout; changes: PlacementChange[] } {
  if (layout.blocks[info.address] !== undefined) return { layout, changes: [] };
  let placement = initial.placement;
  let returnTo = initial.returnTo;
  // The rules hold from the first moment, whatever was asked for.
  if (placement === "panel" && !canUsePanel(info)) placement = returnTo;
  if (placement === "inline" || placement === "minimized") returnTo = placement;
  const entry: Entry = { info, placement: "minimized", returnTo: "minimized" };
  let next: Layout = { ...layout, blocks: { ...layout.blocks, [info.address]: entry } };
  const f = next.focus;
  if (f !== null && !keptByFocus(next, f).has(info.address)) {
    // Outside focus: it starts folded and goes to its own place when focus ends.
    if (placement !== "minimized") {
      next = {
        ...next,
        focus: {
          ...f,
          restore: { ...f.restore, [info.address]: { placement, returnTo, expect: "minimized" } },
        },
      };
    }
    return { layout: next, changes: [] };
  }
  const all: PlacementChange[] = [];
  next = place(next, info.address, { placement, returnTo }, "user", at, all);
  // Showing up is not a move; a block it displaced from the panel is.
  return { layout: next, changes: all.filter((c) => c.block !== info.address) };
}

/* ----------------------------------------------------------------------------------------------- */
/* Focus                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

export type FocusTarget = { block: string } | { conversation: string };

/** What is in focus: its conversation, and its block if it has one. */
function resolveTarget(
  layout: Layout,
  t: FocusTarget,
): Pick<Focus, "block" | "conversation"> | null {
  if ("conversation" in t) return { block: null, conversation: t.conversation };
  const e = layout.blocks[t.block];
  if (e === undefined) return null;
  return { block: t.block, conversation: e.info.opens ?? e.info.home };
}

/**
 * Enters focus: every open block minimizes except the focused one and its thread. Entering focus
 * while in focus moves it: the layout from before is restored first.
 */
export function enterFocus(
  layout: Layout,
  t: FocusTarget,
  at: string = new Date().toISOString(),
): { layout: Layout; changes: PlacementChange[] } {
  const base = layout.focus === null ? { layout, changes: [] } : leaveFocus(layout, at);
  const target = resolveTarget(base.layout, t);
  if (target === null) return { layout, changes: [] };
  const changes = [...base.changes];
  let next: Layout = { ...base.layout, focus: { ...target, restore: {} } };
  const kept = keptByFocus(next, target);
  for (const e of Object.values(next.blocks)) {
    if (kept.has(e.info.address) || e.placement === "minimized") continue;
    next = place(
      next,
      e.info.address,
      { placement: "minimized", returnTo: "minimized" },
      "focus",
      at,
      changes,
    );
  }
  return { layout: next, changes };
}

/**
 * Leaves focus: every block focus changed goes back to where it was, if nothing has moved it
 * since. A block someone moved during focus stays where they put it.
 */
export function leaveFocus(
  layout: Layout,
  at: string = new Date().toISOString(),
): { layout: Layout; changes: PlacementChange[] } {
  const f = layout.focus;
  if (f === null) return { layout, changes: [] };
  const changes: PlacementChange[] = [];
  let next: Layout = { ...layout, focus: null };
  const due = Object.entries(f.restore).filter(([id, r]) => {
    const e = next.blocks[id];
    return e !== undefined && e.placement === r.expect;
  });
  // The panel goes last: restoring its block takes the panel from whoever holds it.
  due.sort(([, a], [, b]) => Number(a.placement === "panel") - Number(b.placement === "panel"));
  for (const [id, r] of due) {
    next = place(
      next,
      id,
      { placement: r.placement, returnTo: r.returnTo },
      "focus-restore",
      at,
      changes,
    );
  }
  return { layout: next, changes };
}

/* ----------------------------------------------------------------------------------------------- */
/* Stubs and attention                                                                              */
/* ----------------------------------------------------------------------------------------------- */

/** What a block leaves where it was created once it moved: one line saying where it went. */
export interface PlacementStub {
  block: string;
  kind: string;
  home: string;
  title: string;
  where: "panel" | "window";
}

/** Exactly one stub for every block that is in the panel or in a window. */
export function stubs(layout: Layout): PlacementStub[] {
  return Object.values(layout.blocks)
    .filter((e) => e.placement === "panel" || e.placement === "window")
    .map((e) => ({
      block: e.info.address,
      kind: e.info.kind,
      home: e.info.home,
      title: e.info.title,
      where: e.placement as "panel" | "window",
    }));
}

/** The block in the panel, if any. */
export function panelBlock(layout: Layout): Entry | null {
  return Object.values(layout.blocks).find((e) => e.placement === "panel") ?? null;
}

/** Something that needs a person, in one conversation. */
export interface Attending {
  conversation: string;
}

/**
 * Splits the attention count by focus: those in the focused conversation, and the rest. Not in
 * focus, everything counts as in focus. Filtering is by conversation, not by component, so an
 * interrupt arriving later in a thread needs no change here.
 */
export function splitAttention(
  items: readonly Attending[],
  focus: Pick<Focus, "conversation"> | null,
): { inFocus: number; elsewhere: number } {
  if (focus === null) return { inFocus: items.length, elsewhere: 0 };
  const inFocus = items.filter((i) => i.conversation === focus.conversation).length;
  return { inFocus, elsewhere: items.length - inFocus };
}

/** The text of the count: "2 need you", or "1 in focus, 3 elsewhere". */
export function attentionText(
  count: { inFocus: number; elsewhere: number },
  focused: boolean,
): string {
  if (!focused)
    return count.inFocus === 0 ? "" : `${count.inFocus} need${count.inFocus === 1 ? "s" : ""} you`;
  return `${count.inFocus} in focus, ${count.elsewhere} elsewhere`;
}

/**
 * The title of a block's window: what it is and where it came from. A block made in a thread
 * names that thread; one made in the main conversation says so.
 */
export function windowTitle(info: Pick<BlockInfo, "title">, originThread: string | null): string {
  const from = originThread === null ? "the main conversation" : `thread “${originThread}”`;
  return `${info.title} · from ${from}`;
}
