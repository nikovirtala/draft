import type { ClusterNode, Graph, GraphNode } from "./map-graph.ts";

/**
 * Where the graph's nodes are (docs/model.md, "A layout that stays put"). Positions are plain data
 * computed outside the view, so they can be tested, stored and handed to any renderer.
 *
 * - **Seeded by id.** A node's first position comes from a hash of its id (and, where the graph
 *   says so, its kind's lane or the cluster it stepped out of), so the same node starts in the same
 *   place on every machine and run.
 * - **Placed incrementally.** `layoutGraph(graph, previous)` keeps every node the previous layout
 *   had where it was. A new node goes to its seed, or to the nearest free place around it. Nothing
 *   is recomputed from scratch, which a force simulation would do (it moves every node a little
 *   each time something changes). The one thing that may move an old node is a neighbour that grew
 *   into it; it is pushed away by at most `MAX_SHIFT` per layout.
 * - **A function.** The same graph and previous layout always give the same layout.
 *
 * No library is used: a cluster graph of tens of nodes needs a seed, a collision check and a
 * spiral, and a simulation (d3-force) or a layered layout (elkjs) would re-settle all of it.
 */

export interface Point {
  x: number;
  y: number;
}

/** A position for each node id. */
export type Layout = Readonly<Record<string, Point>>;

/** The space nodes are placed in; the view scales it to the screen. */
export const WORLD = { width: 900, height: 540 } as const;

/** The most an existing node may move in one layout, in world units. */
export const MAX_SHIFT = 12;

const GAP = 8;
const MARGIN = 6;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The radius of a node's circle: a cluster by its count, an item small, the focus larger. */
export function radiusOf(n: GraphNode): number {
  if (n.type === "item") return n.focus ? 24 : 11;
  return n.external
    ? clamp(14 + 4 * Math.sqrt(n.count), 16, 34)
    : clamp(20 + 4.5 * Math.sqrt(n.count), 22, 46);
}

/** The room a node takes when placing: its circle, and for a cluster the name under it. */
const footprint = (n: GraphNode): number => radiusOf(n) + (n.type === "cluster" ? 16 : 0);

/** A box by its middle and its size, in world units. */
export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A name broken onto two lines at the space nearest its middle; null when it has no space. */
export function wrapName(text: string): string[] | null {
  const mid = text.length / 2;
  let at = -1;
  for (let i = 0; i < text.length; i++)
    if (text[i] === " " && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i;
  return at < 0 ? null : [text.slice(0, at), text.slice(at + 1)];
}

/**
 * The room kept for a cluster's name under it when clusters are placed, so the names (map-labels.ts)
 * have a place that no node of the layout takes. It is the name on two lines where it has a space,
 * as a panel a little narrower than the world would draw it.
 */
export function nameRoom(n: GraphNode, p: Point): Room | null {
  if (n.type !== "cluster") return null;
  const lines = wrapName(n.label) ?? [n.label];
  const chars = Math.max(...lines.map((l) => l.length));
  const w = (chars * 6.4) / 0.8 + 4;
  const h = (lines.length * 14) / 0.8 + 4;
  return { x: p.x, y: p.y + radiusOf(n) + 7 + 4 + h / 2, w, h };
}

const roomInWorld = (r: Room): boolean =>
  r.x - r.w / 2 >= MARGIN &&
  r.x + r.w / 2 <= WORLD.width - MARGIN &&
  r.y + r.h / 2 <= WORLD.height - MARGIN;

const roomsApart = (a: Room, b: Room): boolean =>
  Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + GAP || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + GAP;

function discClearOfRoom(p: Point, r: number, room: Room): boolean {
  const nx = Math.max(room.x - room.w / 2, Math.min(p.x, room.x + room.w / 2));
  const ny = Math.max(room.y - room.h / 2, Math.min(p.y, room.y + room.h / 2));
  return Math.hypot(nx - p.x, ny - p.y) >= r + GAP;
}

/** FNV-1a of a string, as a number in [0, 1). A second `salt` gives a second, independent number. */
export function seedOf(id: string, salt = 0): number {
  let h = 0x811c9dc5;
  for (const c of `${salt}\u0000${id}`) {
    h ^= c.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}

const CENTER: Point = { x: WORLD.width / 2, y: WORLD.height / 2 };

/** The width of one lane of a kind view: the states side by side, with the kinds it reaches at the edge. */
export function laneWidth(graph: Graph): number {
  return (WORLD.width * 0.76) / Math.max(1, graph.lanes.length);
}

/** The middle of a state's lane in a kind view. */
export function laneCenter(graph: Graph, lane: string | null): number {
  const index = Math.max(
    0,
    graph.lanes.findIndex((l) => l.id === lane),
  );
  return (index + 0.5) * laneWidth(graph) + 30;
}

/** Where a node would like to be, given what is already placed. */
function seedFor(n: GraphNode, graph: Graph, placed: ReadonlyMap<string, Point>): Point {
  const a = seedOf(n.id, 1) * 2 * Math.PI;
  const u = seedOf(n.id, 2);
  const around = (center: Point, radius: number): Point => ({
    x: center.x + Math.cos(a) * radius,
    y: center.y + Math.sin(a) * radius,
  });
  // Stepped out of a cluster: just outside it, in a direction of its own.
  if (n.type === "item" && n.tether !== null) {
    const home = placed.get(n.tether);
    const cluster = graph.nodes.find((x) => x.id === n.tether);
    if (home !== undefined && cluster !== undefined)
      return around(home, radiusOf(cluster) + radiusOf(n) + 16 + u * 16);
  }
  if (graph.zoom.level === "item") {
    if (n.type === "item" && n.focus) return CENTER;
    return {
      x: CENTER.x + Math.cos(a) * WORLD.width * 0.3 * (0.8 + 0.2 * u),
      y: CENTER.y + Math.sin(a) * WORLD.height * 0.32 * (0.8 + 0.2 * u),
    };
  }
  if (graph.zoom.level === "kind") {
    if (n.type === "cluster" && n.external)
      return {
        x: WORLD.width - 70,
        y: MARGIN + 40 + seedOf(n.id, 3) * (WORLD.height - 80 - 2 * MARGIN),
      };
    const width = laneWidth(graph);
    const x = laneCenter(graph, n.lane) + (u - 0.5) * width * 0.5;
    const y =
      n.type === "cluster"
        ? WORLD.height / 2 + (seedOf(n.id, 3) - 0.5) * WORLD.height * 0.4
        : MARGIN + 30 + seedOf(n.id, 3) * (WORLD.height - 60 - 2 * MARGIN);
    return { x, y };
  }
  // The context. Kinds that come in a sequence (a repository's environments) lie along a line in
  // that order, a line for each group, left to right.
  if (n.type === "cluster" && n.order !== null) {
    const groups = [
      ...new Set(
        graph.nodes.flatMap((x) =>
          x.type === "cluster" && x.order !== null ? [x.order.group] : [],
        ),
      ),
    ].sort();
    const row = Math.max(0, groups.indexOf(n.order.group));
    return {
      x: WORLD.width * (0.15 + (0.7 * (n.order.index + 0.5)) / n.order.of),
      y: Math.max(WORLD.height * 0.2, WORLD.height * (0.8 - 0.16 * row)),
    };
  }
  // Clusters scattered over an ellipse, from a ring to the middle.
  const spread = 0.35 + 0.65 * Math.sqrt(seedOf(n.id, 3));
  return {
    x: CENTER.x + Math.cos(a) * WORLD.width * 0.36 * spread,
    y: CENTER.y + Math.sin(a) * WORLD.height * 0.34 * spread,
  };
}

const inside = (p: Point, r: number): Point => ({
  x: clamp(p.x, r + MARGIN, WORLD.width - r - MARGIN),
  y: clamp(p.y, r + MARGIN, WORLD.height - r - MARGIN),
});

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

interface Disc {
  p: Point;
  r: number;
}

const free = (p: Point, r: number, discs: readonly Disc[]): boolean =>
  discs.every((d) => distance(p, d.p) >= r + d.r + GAP);

/**
 * The first free place around a seed, along a spiral. A cluster also keeps the room for its name:
 * the place must leave that room clear of every disc and room placed, and its own circle clear
 * of their rooms.
 */
function nearestFree(
  seed: Point,
  r: number,
  discs: readonly Disc[],
  rooms: readonly Room[],
  n: GraphNode,
): Point {
  const golden = 2.399963229728653;
  const nodeR = radiusOf(n);
  for (let k = 0; k < 4000; k++) {
    const radius = k === 0 ? 0 : 5 * Math.sqrt(k);
    const p = inside(
      { x: seed.x + Math.cos(k * golden) * radius, y: seed.y + Math.sin(k * golden) * radius },
      r,
    );
    if (!free(p, r, discs)) continue;
    if (!rooms.every((room) => discClearOfRoom(p, nodeR, room))) continue;
    const mine = nameRoom(n, p);
    if (mine !== null) {
      if (!roomInWorld(mine)) continue;
      if (!rooms.every((room) => roomsApart(mine, room))) continue;
      if (!discs.every((d) => discClearOfRoom(d.p, d.r - GAP, mine))) continue;
    }
    return p;
  }
  return inside(seed, r);
}

/** The order nodes are placed in: the focus, then clusters, then items, each by id. */
function placementOrder(nodes: readonly GraphNode[]): GraphNode[] {
  const rank = (n: GraphNode) => (n.type === "item" && n.focus ? 0 : n.type === "cluster" ? 1 : 2);
  return [...nodes].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The layout of a graph, given the one before it (of the same zoom) or null for the first. Nodes
 * the previous layout has stay where they were, pushed at most `MAX_SHIFT` if a neighbour has grown
 * into them; the others are placed at their seeds or the nearest free place.
 */
export function layoutGraph(graph: Graph, previous: Layout | null = null): Layout {
  const order = placementOrder(graph.nodes);
  const placed = new Map<string, Point>();
  const discs: Disc[] = [];
  const rooms: Room[] = [];
  const kept = order.filter((n) => previous?.[n.id] !== undefined);

  // The old ones first, largest first, each pushed off those before it by at most MAX_SHIFT.
  const bySize = [...kept].sort((a, b) => footprint(b) - footprint(a) || (a.id < b.id ? -1 : 1));
  for (const n of bySize) {
    const was = previous?.[n.id] as Point;
    const r = footprint(n);
    let p = { ...was };
    const fixed = graph.zoom.level === "item" && n.type === "item" && n.focus;
    if (!fixed)
      for (const d of discs) {
        const gap = distance(p, d.p);
        const need = r + d.r + GAP;
        if (gap >= need) continue;
        // On top of each other: away along a direction of the node's own.
        const angle =
          gap === 0 ? seedOf(n.id, 4) * 2 * Math.PI : Math.atan2(p.y - d.p.y, p.x - d.p.x);
        p = { x: p.x + Math.cos(angle) * (need - gap), y: p.y + Math.sin(angle) * (need - gap) };
      }
    const dx = p.x - was.x;
    const dy = p.y - was.y;
    const moved = Math.hypot(dx, dy);
    if (moved > MAX_SHIFT)
      p = { x: was.x + (dx / moved) * MAX_SHIFT, y: was.y + (dy / moved) * MAX_SHIFT };
    placed.set(n.id, p);
    discs.push({ p, r });
    const room = nameRoom(n, p);
    if (room !== null) rooms.push(room);
  }

  // The new ones, in order, at their seeds or the nearest free place around them.
  for (const n of order) {
    if (placed.has(n.id)) continue;
    const r = footprint(n);
    const p = nearestFree(inside(seedFor(n, graph, placed), r), r, discs, rooms, n);
    placed.set(n.id, p);
    discs.push({ p, r });
    const room = nameRoom(n, p);
    if (room !== null) rooms.push(room);
  }
  return Object.fromEntries(order.map((n) => [n.id, placed.get(n.id) as Point]));
}

/** How far each node of `after` that `before` also has has moved. */
export function shifts(before: Layout, after: Layout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, p] of Object.entries(after)) {
    const q = before[id];
    if (q !== undefined) out[id] = distance(p, q);
  }
  return out;
}

/** The cluster a node is tied to, for drawing its tether. */
export function tetherOf(graph: Graph, n: GraphNode): ClusterNode | null {
  if (n.type !== "item" || n.tether === null) return null;
  const c = graph.nodes.find((x) => x.id === n.tether);
  return c?.type === "cluster" ? c : null;
}
