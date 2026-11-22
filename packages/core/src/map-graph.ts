import type {
  ItemRef,
  MapEdge,
  MapItem,
  MapSnapshot,
  OpenTarget,
  StateClass,
} from "./map-types.ts";

/**
 * The map as a graph (docs/model.md, "The map"): the one view at every distance. `projectGraph` is
 * a pure function of a map snapshot and a zoom, which is plain data: it returns the nodes to draw,
 * the edges between them bundled with their counts, and the way back out. It folds nothing itself;
 * the snapshot's rows, items, transitions and edges are what `foldMap` made of the log, so the
 * grid and the graph show the same nodes.
 *
 * - **Context.** Each kind with items is a cluster, sized by its count, with the share that has
 *   settled. An item that moved in the window, or waits on the person, steps out of its cluster as
 *   a node of its own, tethered to it. Edges between nodes are bundled and counted.
 * - **Kind.** The kind's items, along its states; the kinds its items refer to or are referred to
 *   by stand at the edge as clusters.
 * - **Item.** One item and what its edges reach.
 *
 * No layout is decided here: positions come from `layoutGraph` (map-layout.ts), outside the view.
 */

/** A cluster with more items than this shows its count by state and the stepped-out items only. */
export const MAX_OPEN_ITEMS = 40;
/** How many items step out of their clusters in one view; waiting ones first, then the latest moves. */
export const MAX_STEPPED_OUT = 24;
/** How many neighbours an item's neighbourhood draws. */
export const MAX_NEIGHBOURS = 30;

/**
 * References that don't say a path is unfinished when one end is settled and the other is not:
 * a closed sub-issue of an open issue, a settled thread that mentions an open pull request.
 */
export const WEAK_RELS: ReadonlySet<string> = new Set([
  "part-of",
  "relates-to",
  "mentions",
  "supersedes",
  "refines",
]);

/** Where the graph is looked at from. Data, so a view, a link or an agent can say it. */
export type GraphZoom =
  | { level: "context" }
  | { level: "kind"; kind: string }
  | { level: "item"; kind: string; id: string };

export interface ClusterNode {
  type: "cluster";
  id: string;
  label: string;
  kind: string;
  /** The state a bucket of a crowded kind stands for; null for a whole kind. */
  state: string | null;
  /** How many items it stands for, stepped-out ones included. */
  count: number;
  /** How many of them are settled (terminal), and that share of the count. */
  settled: number;
  share: number;
  waitingOnPerson: number;
  /** How many of them are drawn as nodes of their own. */
  steppedOut: number;
  /** References between two of its own items. */
  inside: number;
  /** A kind drawn only because the kind in view refers to it. */
  external: boolean;
  /** The state's place along the kind's lane, in a kind view. */
  lane: string | null;
  /** Where clicking goes; null when it goes nowhere further. */
  zoom: GraphZoom | null;
}

export interface ItemNode {
  type: "item";
  id: string;
  label: string;
  kind: string;
  kindLabel: string;
  item: string;
  state: string;
  stateLabel: string;
  class: StateClass;
  since: string;
  note: string | null;
  /** Moved in the window. */
  moved: boolean;
  /** Waits on the person. */
  waiting: boolean;
  /** Something settled leads to it and it hasn't: a path that stops before an answer. */
  openLoop: boolean;
  /** The item an item view is about. */
  focus: boolean;
  /** The cluster node it stepped out of, which a dotted line ties it to. */
  tether: string | null;
  /** The lane of its state in a kind view. */
  lane: string | null;
  open: OpenTarget;
  zoom: GraphZoom;
}

export type GraphNode = ClusterNode | ItemNode;

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** The references it carries. */
  count: number;
  rels: { rel: string; count: number }[];
  /** Whether it carries a reference between two items that moved: a cascade. */
  cascade: boolean;
}

export interface Lane {
  id: string;
  label: string;
  class: StateClass;
}

export interface Crumb {
  label: string;
  zoom: GraphZoom;
}

export interface Graph {
  context: string;
  zoom: GraphZoom;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The states of the kind in view, start to end; empty elsewhere. */
  lanes: Lane[];
  /** The way back out, from the context to where the view is. */
  crumbs: Crumb[];
  /** Items of the kind or neighbourhood that are not drawn as nodes of their own. */
  hidden: number;
  /** What the map's own summary says, for the words under the graph. */
  totals: { items: number; moved: number; waitingOnPerson: number; openLoops: number };
}

export const keyOf = (ref: ItemRef): string => `${ref.kind}\u0000${ref.id}`;
export const itemNodeId = (kind: string, id: string): string => `item:${kind}:${id}`;
export const clusterNodeId = (kind: string): string => `cluster:${kind}`;
const bucketNodeId = (kind: string, state: string): string => `bucket:${kind}:${state}`;

/** A string for a zoom, to key layouts and views by. */
export function zoomKey(zoom: GraphZoom): string {
  return zoom.level === "context"
    ? "context"
    : zoom.level === "kind"
      ? `kind:${zoom.kind}`
      : `item:${zoom.kind}:${zoom.id}`;
}

/* ----------------------------------------------------------------------------------------------- */
/* What the snapshot says about each item                                                           */
/* ----------------------------------------------------------------------------------------------- */

interface Facts {
  items: Map<string, MapItem>;
  /** The time of the last move of each item that moved in the window. */
  moved: Map<string, string>;
  openLoops: Set<string>;
  rowLabel: Map<string, string>;
}

const isWaiting = (i: MapItem): boolean => i.class === "waiting" && i.waitsOn === "user";

function factsOf(map: MapSnapshot): Facts {
  const items = new Map<string, MapItem>();
  const rowLabel = new Map<string, string>();
  for (const row of map.rows) {
    rowLabel.set(row.kind, row.label);
    for (const cell of row.cells) for (const i of cell.items) items.set(keyOf(i), i);
  }
  const moved = new Map<string, string>();
  // A first appearance is not a move; a change of state is.
  for (const t of map.transitions) {
    if (t.from === null) continue;
    const key = keyOf({ kind: t.kind, id: t.item });
    const last = moved.get(key);
    if (last === undefined || t.at > last) moved.set(key, t.at);
  }
  const openLoops = new Set<string>();
  for (const e of map.edges) {
    if (WEAK_RELS.has(e.rel)) continue;
    const from = items.get(keyOf(e.from));
    const to = items.get(keyOf(e.to));
    if (from?.class === "terminal" && to !== undefined && to.class !== "terminal")
      openLoops.add(keyOf(e.to));
  }
  return { items, moved, openLoops, rowLabel };
}

function itemNode(
  i: MapItem,
  facts: Facts,
  o: { tether?: string | null; focus?: boolean; lane?: string | null } = {},
): ItemNode {
  const key = keyOf(i);
  return {
    type: "item",
    id: itemNodeId(i.kind, i.id),
    label: i.label,
    kind: i.kind,
    kindLabel: facts.rowLabel.get(i.kind) ?? i.kind,
    item: i.id,
    state: i.state,
    stateLabel: i.stateLabel,
    class: i.class,
    since: i.since,
    note: i.note,
    moved: facts.moved.has(key),
    waiting: isWaiting(i),
    openLoop: facts.openLoops.has(key),
    focus: o.focus ?? false,
    tether: o.tether ?? null,
    lane: o.lane ?? null,
    open: i.open,
    zoom: { level: "item", kind: i.kind, id: i.id },
  };
}

/** The items that step out: the ones waiting on the person, then the latest moves, up to the cap. */
function steppedOut(items: readonly MapItem[], facts: Facts): MapItem[] {
  return items
    .filter((i) => isWaiting(i) || facts.moved.has(keyOf(i)))
    .sort((a, b) => {
      const w = Number(isWaiting(b)) - Number(isWaiting(a));
      if (w !== 0) return w;
      const am = facts.moved.get(keyOf(a)) ?? "";
      const bm = facts.moved.get(keyOf(b)) ?? "";
      if (am !== bm) return am < bm ? 1 : -1;
      return keyOf(a) < keyOf(b) ? -1 : 1;
    })
    .slice(0, MAX_STEPPED_OUT);
}

function clusterNode(
  kind: string,
  label: string,
  items: readonly MapItem[],
  o: {
    state?: string | null;
    out?: number;
    inside?: number;
    external?: boolean;
    lane?: string | null;
    zoom?: GraphZoom | null;
  } = {},
): ClusterNode {
  const settled = items.filter((i) => i.class === "terminal").length;
  const state = o.state ?? null;
  return {
    type: "cluster",
    id: state === null ? clusterNodeId(kind) : bucketNodeId(kind, state),
    label,
    kind,
    state,
    count: items.length,
    settled,
    share: items.length === 0 ? 0 : settled / items.length,
    waitingOnPerson: items.filter(isWaiting).length,
    steppedOut: o.out ?? 0,
    inside: o.inside ?? 0,
    external: o.external ?? false,
    lane: o.lane ?? null,
    zoom: o.zoom === undefined ? (state === null ? { level: "kind", kind } : null) : o.zoom,
  };
}

/* ----------------------------------------------------------------------------------------------- */
/* Bundling                                                                                         */
/* ----------------------------------------------------------------------------------------------- */

/**
 * Edges between nodes, bundled by direction: `nodeOf` says which node an end of an edge is drawn
 * as (null: it isn't on screen). Edges inside one node are not drawn; `inside` counts them.
 */
function bundle(
  edges: readonly MapEdge[],
  nodeOf: (ref: ItemRef) => string | null,
  facts: Facts,
  inside: Map<string, number> = new Map(),
): GraphEdge[] {
  const out = new Map<string, GraphEdge>();
  for (const e of edges) {
    const from = nodeOf(e.from);
    const to = nodeOf(e.to);
    if (from === null || to === null) continue;
    if (from === to) {
      inside.set(from, (inside.get(from) ?? 0) + 1);
      continue;
    }
    const id = `${from}>${to}`;
    let b = out.get(id);
    if (b === undefined) {
      b = { id, from, to, count: 0, rels: [], cascade: false };
      out.set(id, b);
    }
    b.count++;
    const r = b.rels.find((x) => x.rel === e.rel);
    if (r === undefined) b.rels.push({ rel: e.rel, count: 1 });
    else r.count++;
    if (facts.moved.has(keyOf(e.from)) && facts.moved.has(keyOf(e.to))) b.cascade = true;
  }
  for (const b of out.values())
    b.rels.sort((a, c) => c.count - a.count || (a.rel < c.rel ? -1 : 1));
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ----------------------------------------------------------------------------------------------- */
/* The projection                                                                                   */
/* ----------------------------------------------------------------------------------------------- */

/** The graph of a snapshot as seen from `zoom`. A zoom that names nothing there is the context. */
export function projectGraph(map: MapSnapshot, zoom: GraphZoom = { level: "context" }): Graph {
  const facts = factsOf(map);
  if (zoom.level === "kind") return kindGraph(map, facts, zoom.kind);
  if (zoom.level === "item") {
    const focus = facts.items.get(keyOf({ kind: zoom.kind, id: zoom.id }));
    if (focus !== undefined) return itemGraph(map, facts, focus);
  }
  return contextGraph(map, facts);
}

function summary(map: MapSnapshot, facts: Facts) {
  return {
    items: map.totals.items,
    moved: facts.moved.size,
    waitingOnPerson: map.totals.waitingOnPerson,
    openLoops: facts.openLoops.size,
  };
}

const contextCrumb: Crumb = { label: "Context", zoom: { level: "context" } };

function contextGraph(map: MapSnapshot, facts: Facts): Graph {
  const nodes: GraphNode[] = [];
  const clusterOf = new Map<string, string>();
  const nodeOfItem = new Map<string, string>();
  const stepped = steppedOut([...facts.items.values()], facts);
  const out = new Map<string, number>();
  for (const i of stepped) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
  const inside = new Map<string, number>();
  const clusters: ClusterNode[] = [];
  for (const row of map.rows) {
    const items = row.cells.flatMap((c) => c.items);
    if (items.length === 0) continue;
    const c = clusterNode(row.kind, row.label, items, { out: out.get(row.kind) ?? 0 });
    clusters.push(c);
    clusterOf.set(row.kind, c.id);
  }
  for (const i of stepped) {
    const tether = clusterOf.get(i.kind) ?? null;
    nodeOfItem.set(keyOf(i), itemNodeId(i.kind, i.id));
    nodes.push(itemNode(i, facts, { tether }));
  }
  const edges = bundle(
    map.edges,
    (ref) => nodeOfItem.get(keyOf(ref)) ?? clusterOf.get(ref.kind) ?? null,
    facts,
    inside,
  );
  for (const c of clusters) c.inside = inside.get(c.id) ?? 0;
  return {
    context: map.context,
    zoom: { level: "context" },
    nodes: [...clusters, ...nodes],
    edges,
    lanes: [],
    crumbs: [contextCrumb],
    hidden: 0,
    totals: summary(map, facts),
  };
}

function kindGraph(map: MapSnapshot, facts: Facts, kind: string): Graph {
  const row = map.rows.find((r) => r.kind === kind);
  if (row === undefined) return contextGraph(map, facts);
  const items = row.cells.flatMap((c) => c.items);
  const allLanes: Lane[] = row.columns.map((c) => ({ id: c.id, label: c.label, class: c.class }));
  const nodes: GraphNode[] = [];
  const nodeOfItem = new Map<string, string>();
  let hidden = 0;
  if (items.length <= MAX_OPEN_ITEMS) {
    for (const i of items) {
      nodeOfItem.set(keyOf(i), itemNodeId(i.kind, i.id));
      nodes.push(itemNode(i, facts, { lane: i.column }));
    }
  } else {
    // More than fit: the count of each state, and the items that moved or wait on the person.
    const out = steppedOut(items, facts);
    hidden = items.length - out.length;
    for (const cell of row.cells) {
      if (cell.count === 0) continue;
      const column = row.columns.find((c) => c.id === cell.column);
      const outHere = out.filter((i) => i.column === cell.column);
      const b = clusterNode(kind, column?.label ?? cell.column, cell.items, {
        state: cell.column,
        out: outHere.length,
        lane: cell.column,
      });
      nodes.push(b);
      for (const i of outHere) {
        nodeOfItem.set(keyOf(i), itemNodeId(i.kind, i.id));
        nodes.push(itemNode(i, facts, { tether: b.id, lane: i.column }));
      }
      for (const i of cell.items) {
        if (!nodeOfItem.has(keyOf(i))) nodeOfItem.set(keyOf(i), b.id);
      }
    }
  }
  // Only the states something is in take room, in the kind's own order.
  const lanes = allLanes.filter((l) => nodes.some((n) => n.lane === l.id));
  // The kinds this one's items refer to, or are referred to by, stand at the edge.
  const external = new Map<string, MapItem[]>();
  const edgesHere: MapEdge[] = [];
  for (const e of map.edges) {
    const a = e.from.kind === kind;
    const b = e.to.kind === kind;
    if (!a && !b) continue;
    edgesHere.push(e);
    const other = a ? e.to : e.from;
    if (other.kind !== kind) {
      const o = facts.items.get(keyOf(other));
      if (o !== undefined) external.set(other.kind, [...(external.get(other.kind) ?? []), o]);
    }
  }
  const outside = new Map<string, string>();
  for (const [k, list] of [...external].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const all = map.rows.find((r) => r.kind === k)?.cells.flatMap((c) => c.items) ?? list;
    const c = clusterNode(k, facts.rowLabel.get(k) ?? k, all, { external: true });
    nodes.push(c);
    outside.set(k, c.id);
  }
  const inside = new Map<string, number>();
  const edges = bundle(
    edgesHere,
    (ref) =>
      ref.kind === kind ? (nodeOfItem.get(keyOf(ref)) ?? null) : (outside.get(ref.kind) ?? null),
    facts,
    inside,
  );
  for (const n of nodes) if (n.type === "cluster") n.inside = inside.get(n.id) ?? 0;
  return {
    context: map.context,
    zoom: { level: "kind", kind },
    nodes,
    edges,
    lanes,
    crumbs: [contextCrumb, { label: row.label, zoom: { level: "kind", kind } }],
    hidden,
    totals: summary(map, facts),
  };
}

function itemGraph(map: MapSnapshot, facts: Facts, focus: MapItem): Graph {
  const key = keyOf(focus);
  const near = new Set<string>();
  for (const e of map.edges) {
    if (keyOf(e.from) === key) near.add(keyOf(e.to));
    else if (keyOf(e.to) === key) near.add(keyOf(e.from));
  }
  const neighbours = [...near].sort().slice(0, MAX_NEIGHBOURS);
  const shown = new Set([key, ...neighbours]);
  const nodes: GraphNode[] = [itemNode(focus, facts, { focus: true })];
  for (const k of neighbours) {
    const i = facts.items.get(k);
    if (i !== undefined) nodes.push(itemNode(i, facts));
  }
  const edges = bundle(
    map.edges.filter((e) => shown.has(keyOf(e.from)) && shown.has(keyOf(e.to))),
    (ref) => (shown.has(keyOf(ref)) ? itemNodeId(ref.kind, ref.id) : null),
    facts,
  );
  return {
    context: map.context,
    zoom: { level: "item", kind: focus.kind, id: focus.id },
    nodes,
    edges,
    lanes: [],
    crumbs: [
      contextCrumb,
      {
        label: facts.rowLabel.get(focus.kind) ?? focus.kind,
        zoom: { level: "kind", kind: focus.kind },
      },
      { label: focus.label, zoom: { level: "item", kind: focus.kind, id: focus.id } },
    ],
    hidden: near.size - neighbours.length,
    totals: summary(map, facts),
  };
}

/** The zoom one step out: from an item to its kind, from a kind to the context. */
export function zoomOut(zoom: GraphZoom): GraphZoom {
  return zoom.level === "item" ? { level: "kind", kind: zoom.kind } : { level: "context" };
}

/** Words for a rel: "part-of" is "part of". */
export function relLabel(rel: string): string {
  return rel.replace(/-/g, " ");
}
