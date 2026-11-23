/**
 * What the map's projection returns, and what its kinds declare about their states. Plain data and
 * no imports, so the renderer can share the types without reaching into the log.
 */

/** Whom a wait is on, as the actor kinds of an event are named. */
export type MapActor = "user" | "agent" | "resolver" | "system";

export type StateClass = "active" | "waiting" | "terminal";

/** One state of a kind, as a column of its row. */
export interface StateDecl {
  id: string;
  label: string;
  class: StateClass;
  /** For a waiting state: whom it waits on. A wait on `user` is what the map highlights. */
  waitsOn?: MapActor;
}

/** Where an item lives, so a person can go there. */
export type OpenTarget =
  /** A conversation (the main one or a thread), optionally at one of its blocks. */
  | { kind: "conversation"; conversation: string; anchor: string | null }
  /** A live status stub: the message that first mentioned it, and the conversation that is in. */
  | { kind: "stub"; target: string; from: string; conversation: string }
  /** Something that lives outside draft: its pages, such as a decision's files or a deployment's run. */
  | { kind: "links"; links: { label: string; url: string }[] };

/** The state an item entered, and when. The last entry of a path is the item's state. */
export interface PathEntry {
  state: string;
  at: string;
  /** The position in the log of the event that moved it. */
  seq: number;
}

/** One state's place in a grouping. */
export interface Column {
  id: string;
  label: string;
}

export interface MapWindow {
  /** Transitions at or after this time (ISO). */
  since?: string;
  /** Transitions at or before this time. */
  until?: string;
}

export interface MapItem {
  context: string;
  kind: string;
  id: string;
  label: string;
  state: string;
  stateLabel: string;
  class: StateClass;
  waitsOn: MapActor | null;
  column: string;
  /** When it entered this state. */
  since: string;
  /** What the cell counts it under besides its state, such as how an issue was closed. */
  note: string | null;
  open: OpenTarget;
}

export interface MapCell {
  column: string;
  count: number;
  /** How many of its items wait on the person. */
  waitingOnPerson: number;
  /** The notes of its items, counted, most common first. */
  notes: { note: string; count: number }[];
  items: MapItem[];
}

/**
 * Where a kind comes in a sequence of kinds that belong together, such as the environments of one
 * repository: `index` of `of`, from 0, in the order they are deployed to. Rows and clusters of one
 * group are drawn in that order.
 */
export interface KindOrder {
  group: string;
  index: number;
  of: number;
}

export interface MapRow {
  kind: string;
  label: string;
  /** Its place among the kinds of its group, when it is one of a sequence. */
  order: KindOrder | null;
  source: "machine" | "derived";
  derivation: string;
  columns: (Column & { class: StateClass })[];
  cells: MapCell[];
  total: number;
  waitingOnPerson: number;
  /** Why these counts may not be current: what could not be read last time. Null when they are. */
  stale: string | null;
}

export interface MapTransition {
  context: string;
  kind: string;
  item: string;
  label: string;
  /** Null when the item appeared. */
  from: string | null;
  to: string;
  fromColumn: string | null;
  toColumn: string;
  at: string;
  seq: number;
}

/** An item of a kind: the pair every edge names its ends by. */
export interface ItemRef {
  kind: string;
  id: string;
}

/**
 * A reference between two items of a context, declared by the kind that owns it (docs/model.md,
 * "References and the graph"). It reads `from` `rel` `to`: an issue implements a decision, a
 * deployment deploys a pull request, a decision supersedes another.
 */
export interface MapEdge {
  context: string;
  from: ItemRef;
  to: ItemRef;
  /** What the reference says: "implements", "supersedes", "part-of", "mentions", "deploys". */
  rel: string;
  /** When the log or the source says it was made; null when it doesn't say. */
  at: string | null;
}

export interface MapProblem {
  kind: string;
  message: string;
}

export interface MapSnapshot {
  context: string;
  /** How many records were folded. */
  position: number;
  /** The time of the last one; null for an empty log. */
  at: string | null;
  grouping: { id: string; label: string };
  window: MapWindow;
  /** Every kind the registry has, drawn or not: what the empty state names. */
  kinds: { id: string; label: string }[];
  rows: MapRow[];
  transitions: MapTransition[];
  /** The references between the items above, both ends present; see `KindDecl.edges`. */
  edges: MapEdge[];
  totals: { items: number; open: number; waitingOnPerson: number };
  /** A source is being read now (GitHub, for the repositories the context covers). */
  reading: boolean;
  /** Kinds that failed to list their items; the rest of the map is still drawn. */
  problems: MapProblem[];
}

/**
 * What the problems say, each once. Every kind that reads a source reports the same words when the
 * source is slow or gone, so a map would print "still reading … from GitHub" once for decisions
 * and once for issues; the person needs it once. Each row still carries its own `stale`.
 */
export function problemLines(problems: readonly MapProblem[]): string[] {
  return [...new Set(problems.map((p) => p.message))];
}

/** The names the empty state gives the kinds: "Interrupts: permission request" is "Interrupts". */
function kindNames(kinds: readonly { label: string }[]): string[] {
  return [...new Set(kinds.map((k) => k.label.split(":")[0]?.trim() ?? k.label))];
}

/**
 * What an empty map says it will show, from the kinds the registry has, so a kind that registers
 * later is named without anyone editing this sentence.
 */
export function emptyMapText(kinds: readonly { label: string }[]): string {
  const names = kindNames(kinds);
  const list =
    names.length <= 1
      ? (names[0] ?? "Items")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Nothing to show yet. ${list} appear here as they come up: a row for each kind, a column for each state, with what waits on you lit and the latest moves drawn as arrows.`;
}
