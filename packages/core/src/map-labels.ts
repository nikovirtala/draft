import type { Graph, GraphNode } from "./map-graph.ts";
import { type Layout, type Point, radiusOf, WORLD, wrapName } from "./map-layout.ts";

/**
 * Where the graph's names are (docs/model.md, "A layout that stays put"). A label is part of the
 * layout: it has a box in world units, and the box is kept clear of every node and every other
 * label. Like positions, labels are plain data computed outside the view, and they stay put.
 *
 * - **A box for each label.** The size comes from the text and the size of a screen pixel in world
 *   units (`scale`), since a window that is narrower draws the same name larger.
 * - **Clear of everything.** Each label tries the places around its node, nearest first: under it,
 *   as it was drawn before, then over it, beside it and at its corners, each on one line and then
 *   wrapped onto two, and last shortened (the full name is in the node's accessible label and
 *   tooltip). The first place that touches no node and no other label wins.
 * - **Stable.** `layoutLabels(graph, layout, previous)` keeps the place a label had while it is
 *   still clear, so a name doesn't jump when the log moves; only a label that something grew into
 *   moves, and only that one.
 * - **A function.** The same graph, layout, previous labels and options give the same labels.
 */

export type LabelSide = "below" | "above" | "right" | "left" | "ne" | "se" | "sw" | "nw";

/** How a label is set: on one line or wrapped onto two, in full or shortened. */
export type LabelSetting = "full" | "wrapped" | "short";

export interface LabelBox {
  /** The node it names. */
  id: string;
  side: LabelSide;
  setting: LabelSetting;
  /** The text as drawn, a line each. */
  lines: string[];
  /** The middle of the box, in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Labels = Readonly<Record<string, LabelBox>>;

export interface LabelOptions {
  /** Whether items carry names; clusters always do. */
  named: boolean;
  /** How many screen pixels a world unit is: 1 when the panel is as wide as the world. */
  scale?: number;
}

const GAP = 4;
const PAD = 2;
const LINE = 14;
const MARGIN = 2;
const SHORT = 17;

/** The name a node is called, as drawn when there is room. */
export function nameOf(n: GraphNode): string {
  if (n.type === "cluster") return n.label;
  return n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
}

/** Pixels one character takes: 11.5px text for a cluster, 11px for an item. */
const charPx = (n: GraphNode): number => (n.type === "cluster" ? 6.4 : 6.1);

const SIDES: readonly LabelSide[] = ["below", "above", "right", "left", "se", "ne", "sw", "nw"];

/** The place a label is tried in, in order of preference. */
const SETTINGS: readonly LabelSetting[] = ["full", "wrapped", "short"];

const shorten = (text: string): string =>
  text.length <= SHORT ? text : `${text.slice(0, SHORT - 1).trimEnd()}…`;

function linesOf(n: GraphNode, setting: LabelSetting): string[] | null {
  const text = nameOf(n);
  if (setting === "full") return [text];
  if (setting === "wrapped") return wrapName(text);
  const short = shorten(text);
  return short === text ? null : [short];
}

/** The room a node's own drawing takes: its circle, the ring or loop around it, and a gap. */
const clearance = (n: GraphNode): number => radiusOf(n) + (n.type === "cluster" ? 7 : 6);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxAt(p: Point, n: GraphNode, side: LabelSide, w: number, h: number): Box {
  const r = clearance(n) + GAP;
  const d = r * Math.SQRT1_2;
  switch (side) {
    case "below":
      return { x: p.x, y: p.y + r + h / 2, w, h };
    case "above":
      return { x: p.x, y: p.y - r - h / 2, w, h };
    case "right":
      return { x: p.x + r + w / 2, y: p.y, w, h };
    case "left":
      return { x: p.x - r - w / 2, y: p.y, w, h };
    case "se":
      return { x: p.x + d + w / 2, y: p.y + d + h / 2, w, h };
    case "ne":
      return { x: p.x + d + w / 2, y: p.y - d - h / 2, w, h };
    case "sw":
      return { x: p.x - d - w / 2, y: p.y + d + h / 2, w, h };
    case "nw":
      return { x: p.x - d - w / 2, y: p.y - d - h / 2, w, h };
  }
}

const apart = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + MARGIN ||
  Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + MARGIN;

/** Whether a box clears a circle. */
function clearOfDisc(b: Box, c: Point, r: number): boolean {
  const nx = Math.max(b.x - b.w / 2, Math.min(c.x, b.x + b.w / 2));
  const ny = Math.max(b.y - b.h / 2, Math.min(c.y, b.y + b.h / 2));
  return Math.hypot(nx - c.x, ny - c.y) >= r;
}

const inWorld = (b: Box): boolean =>
  b.x - b.w / 2 >= MARGIN &&
  b.x + b.w / 2 <= WORLD.width - MARGIN &&
  b.y - b.h / 2 >= MARGIN &&
  b.y + b.h / 2 <= WORLD.height - MARGIN;

/** Whether a box overlaps a node's drawing or a label: what a label must not do. */
export function overlaps(
  box: Box,
  discs: readonly { p: Point; r: number; id: string }[],
  labels: readonly Box[],
  own?: string,
): boolean {
  return (
    discs.some((d) => d.id !== own && !clearOfDisc(box, d.p, d.r)) ||
    labels.some((l) => !apart(box, l))
  );
}

function candidate(
  n: GraphNode,
  p: Point,
  side: LabelSide,
  setting: LabelSetting,
  scale: number,
): LabelBox | null {
  const lines = linesOf(n, setting);
  if (lines === null) return null;
  const chars = Math.max(...lines.map((l) => l.length));
  const w = (chars * charPx(n)) / scale + 2 * PAD;
  const h = (lines.length * LINE) / scale + 2 * PAD;
  const b = boxAt(p, n, side, w, h);
  return { id: n.id, side, setting, lines, ...b };
}

const byId = (a: GraphNode, b: GraphNode): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The labels of a graph at its layout, given those before it (of the same zoom) or null for the
 * first. A label keeps its place while it is clear; the others take the first clear place around
 * their node, and when no place is clear the one that overlaps least.
 */
export function layoutLabels(
  graph: Graph,
  layout: Layout,
  previous: Labels | null = null,
  o: LabelOptions = { named: true },
): Labels {
  const scale = o.scale !== undefined && o.scale > 0 ? o.scale : 1;
  const nodes = graph.nodes.filter(
    (n) => layout[n.id] !== undefined && (o.named || n.type === "cluster"),
  );
  const discs = graph.nodes.flatMap((n) => {
    const p = layout[n.id];
    return p === undefined ? [] : [{ p, r: clearance(n), id: n.id }];
  });
  const placed: LabelBox[] = [];
  const out = new Map<string, LabelBox>();
  const take = (l: LabelBox) => {
    placed.push(l);
    out.set(l.id, l);
  };
  const free = (l: LabelBox) => inWorld(l) && !overlaps(l, discs, placed);

  // The ones that were somewhere keep their place if it is still clear, in a fixed order.
  const rest: GraphNode[] = [];
  for (const n of [...nodes].sort(byId)) {
    const was = previous?.[n.id];
    const p = layout[n.id] as Point;
    const same = was === undefined ? null : candidate(n, p, was.side, was.setting, scale);
    if (same !== null && free(same)) take(same);
    else rest.push(n);
  }
  // The others: clusters first, then items, each by id.
  rest.sort((a, b) => Number(b.type === "cluster") - Number(a.type === "cluster") || byId(a, b));
  for (const n of rest) {
    const p = layout[n.id] as Point;
    let best: { l: LabelBox; cost: number } | null = null;
    let chosen: LabelBox | null = null;
    search: for (const setting of SETTINGS)
      for (const side of SIDES) {
        const l = candidate(n, p, side, setting, scale);
        if (l === null) continue;
        if (free(l)) {
          chosen = l;
          break search;
        }
        // Nothing is clear yet: remember the least bad, for when nothing is.
        const cost =
          discs.filter((d) => d.id !== n.id && !clearOfDisc(l, d.p, d.r)).length +
          placed.filter((x) => !apart(l, x)).length +
          (inWorld(l) ? 0 : 5);
        if (best === null || cost < best.cost) best = { l, cost };
      }
    const l = chosen ?? best?.l ?? candidate(n, p, "below", "full", scale);
    if (l !== null) take(l);
  }
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The labels, in the order they should be read: by node id. */
export const labelList = (labels: Labels): LabelBox[] => Object.values(labels);
