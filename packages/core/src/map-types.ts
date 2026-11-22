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

export interface MapRow {
  kind: string;
  label: string;
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
  rows: MapRow[];
  transitions: MapTransition[];
  totals: { items: number; open: number; waitingOnPerson: number };
  /** Kinds that failed to list their items; the rest of the map is still drawn. */
  problems: MapProblem[];
}
