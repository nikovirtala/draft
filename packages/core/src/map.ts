import { tryParseAddress } from "./address.ts";
import { type DraftEvent, isUnknown, type LogRecord } from "./events.ts";
import type { MachineSpec } from "./machine.ts";
import type {
  Column,
  ItemRef,
  MapCell,
  MapEdge,
  MapItem,
  MapProblem,
  MapRow,
  MapSnapshot,
  MapTransition,
  MapWindow,
  OpenTarget,
  PathEntry,
  StateClass,
  StateDecl,
} from "./map-types.ts";

export type * from "./map-types.ts";

/**
 * The map's projection (docs/model.md, "The map"): every kind a context has, its items by state,
 * and what moved. It is one pure fold over the log, so "now" is the latest position and a past
 * moment is the same fold stopped earlier.
 *
 * - A **kind** declares its states (each active, waiting on someone, or terminal) and how to list
 *   its items from the log. A kind with a state machine takes its states from the machine; a kind
 *   without one derives them from its resolved state and says so (`source: "derived"`).
 * - The **registry** is the one place kinds declare themselves. A new kind becomes a row by
 *   registering; nothing in this module knows any kind.
 * - A **grouping** says which column each state belongs to. The default is one column per state; a
 *   later delivery lens groups states into phases without changing the fold.
 * - The **window** bounds the transitions returned, with their times; the counts are always the
 *   state at the position.
 * - Every item carries its context, so projections of several contexts can be combined later.
 */

/** A reference as a kind declares it; the fold adds the context and keeps it if both ends exist. */
export interface EdgeDraft {
  from: ItemRef;
  to: ItemRef;
  rel: string;
  at?: string | null;
}

/** An item as a kind lists it: where it is now and how it got there. */
export interface ItemDraft {
  /** Stable among the items of its kind. */
  id: string;
  label: string;
  open: OpenTarget;
  /** What the cell counts it under besides its state; an issue closed as done says "done". */
  note?: string | null;
  /** The states it was in, oldest first; at least one. */
  path: readonly PathEntry[];
}

/** What a kind can read besides the log: facts about this process that the log doesn't hold. */
export interface LiveInfo {
  /** Steps (by their `step.started` address) that are running in this process now. */
  runningSteps: ReadonlySet<string>;
}

export interface KindInput {
  /** The events up to the position, with unknown records left out, in log order. */
  events: readonly { event: DraftEvent; seq: number }[];
  context: string;
  /** Null when folding the past: nothing is known of any process then. */
  live: LiveInfo | null;
  /**
   * What lives outside the log, by name, as plain data the host read: the records of the
   * repositories a context covers. A kind that lists outside things reads its source here, so
   * the fold stays a pure function of its inputs.
   */
  sources: Readonly<Record<string, unknown>>;
  /** The kind whose items a reference target of this resolver type is, or null when none is. */
  kindOfTarget(type: string): string | null;
}

export interface KindDecl {
  /** Names the row: "thread", "interrupt:permission". */
  id: string;
  label: string;
  /** "machine": the states are a state machine's. "derived": there is none yet; see `derivation`. */
  source: "machine" | "derived";
  /** Which machine the states come from, or how they are derived from the resolved state. */
  derivation: string;
  /** Start to end: the order of the columns. */
  states: readonly StateDecl[];
  /** Shown even with no items, so the map says what it will show. */
  alwaysShown?: boolean;
  items(input: KindInput): readonly ItemDraft[];
  /** The reference target type (a resolver's type) whose items are this kind's: "pull-request". */
  targetType?: string;
  /**
   * The references this kind owns, from its items to items of any kind, declared like states and
   * never inferred: only what the log or the source says. An end that is not an item of the map is
   * dropped, so a kind may name what may not be on the map. A kind whose `edges` throws is reported
   * in `problems` and its items and everyone else's edges are still drawn.
   */
  edges?(input: KindInput): readonly EdgeDraft[];
  /**
   * Why the counts may not be current, when the kind could not read its source the last time;
   * null when they are. The row says so and the map's problems list it, so a stale count is never
   * drawn as a current one.
   */
  freshness?(input: KindInput): string | null;
}

/** Which column each state of each kind belongs to. */
export interface MapGrouping {
  id: string;
  label: string;
  columnOf(kind: KindDecl, state: StateDecl): Column;
}

export const BY_STATE: MapGrouping = {
  id: "state",
  label: "By state",
  columnOf: (_kind, state) => ({ id: state.id, label: state.label }),
};

const CLASS_LABELS: Record<StateClass, string> = {
  active: "Moving",
  waiting: "Waiting",
  terminal: "Done",
};

export const BY_CLASS: MapGrouping = {
  id: "class",
  label: "By class",
  columnOf: (_kind, state) => ({ id: state.class, label: CLASS_LABELS[state.class] }),
};

export const GROUPINGS: Record<string, MapGrouping> = {
  [BY_STATE.id]: BY_STATE,
  [BY_CLASS.id]: BY_CLASS,
};

/** A state's label from its id: "wrapped-up" is "Wrapped up". */
export function labelOf(id: string): string {
  const s = id.replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The states of a state machine, start to end: by distance from the initial state, then the ones
 * that end. Waiting states keep whom they wait on.
 */
export function statesOfMachine<S extends string>(
  spec: MachineSpec<S>,
  labels: Partial<Record<S, string>> = {},
): StateDecl[] {
  const ids = Object.keys(spec.states) as S[];
  const depth = new Map<string, number>([[spec.initial, 0]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of spec.transitions)
      for (const f of typeof t.from === "string" ? [t.from] : (t.from as readonly S[])) {
        const d = depth.get(f);
        if (d !== undefined && !depth.has(t.to)) {
          depth.set(t.to, d + 1);
          grew = true;
        }
      }
  }
  // Live states by distance from the start; the states that end keep the order they were declared in.
  const rank = (s: S) =>
    spec.states[s].terminal === true
      ? 1000 + ids.indexOf(s)
      : (depth.get(s) ?? 99) * 10 + ids.indexOf(s) / 1000;
  return [...ids]
    .sort((a, b) => rank(a) - rank(b))
    .map((id): StateDecl => {
      const s = spec.states[id];
      const label = labels[id] ?? labelOf(id);
      if (s.terminal === true) return { id, label, class: "terminal" };
      if (s.wait !== undefined) return { id, label, class: "waiting", waitsOn: s.wait.on };
      return { id, label, class: "active" };
    });
}

/** The one place kinds declare themselves. */
export class KindRegistry {
  private readonly kinds = new Map<string, KindDecl>();

  /** Adds a kind; refuses one that can't be drawn. Returns a function that takes it out again. */
  register(kind: KindDecl): () => void {
    const problem = checkKind(kind);
    if (problem !== null) throw new Error(`the kind ${kind.id} is refused: ${problem}`);
    if (this.kinds.has(kind.id)) throw new Error(`the kind ${kind.id} is already registered`);
    this.kinds.set(kind.id, kind);
    return () => void this.kinds.delete(kind.id);
  }

  /** A registry with the same kinds, to which others can be added without changing this one. */
  fork(): KindRegistry {
    const copy = new KindRegistry();
    for (const k of this.kinds.values()) copy.register(k);
    return copy;
  }

  /** The kind whose items are the reference targets of a resolver type, or null. */
  kindOfTarget(type: string): string | null {
    for (const k of this.kinds.values()) if (k.targetType === type) return k.id;
    return null;
  }

  get(id: string): KindDecl | null {
    return this.kinds.get(id) ?? null;
  }

  /** The kinds in the order they were registered: the order of the rows. */
  list(): KindDecl[] {
    return [...this.kinds.values()];
  }
}

function checkKind(kind: KindDecl): string | null {
  if (kind.id.trim() === "") return "it has no id";
  if (kind.states.length === 0) return "it declares no states";
  const seen = new Set<string>();
  for (const s of kind.states) {
    if (seen.has(s.id)) return `the state ${s.id} is declared twice`;
    seen.add(s.id);
    if (s.class === "waiting" && s.waitsOn === undefined) return `${s.id} waits on no one`;
  }
  if (!kind.states.some((s) => s.class === "terminal")) return "it has no terminal state";
  return null;
}

/* ----------------------------------------------------------------------------------------------- */
/* The fold                                                                                          */
/* ----------------------------------------------------------------------------------------------- */

export interface MapQuery {
  /** How many records of the log to fold: the map as it was after them. Default: all. */
  position?: number;
  window?: MapWindow;
  grouping?: MapGrouping;
  /** The context's id, on every item. Default: the context the first event's address names. */
  context?: string;
  live?: LiveInfo | null;
  /** What lives outside the log; see `KindInput.sources`. */
  sources?: Readonly<Record<string, unknown>>;
}

function contextOf(events: readonly DraftEvent[]): string {
  for (const e of events) {
    const a = tryParseAddress(e.address);
    if (a !== null) return a.context;
  }
  return "";
}

/**
 * Folds a log, up to a position, through the registry's kinds. A pure function: the same records
 * and query give the same map, whenever and wherever it runs.
 */
export function foldMap(
  records: readonly LogRecord[],
  registry: KindRegistry,
  query: MapQuery = {},
): MapSnapshot {
  const position = Math.max(0, Math.min(query.position ?? records.length, records.length));
  const events: { event: DraftEvent; seq: number }[] = [];
  for (let seq = 0; seq < position; seq++) {
    const r = records[seq] as LogRecord;
    if (!isUnknown(r)) events.push({ event: r, seq });
  }
  const context = query.context ?? contextOf(events.map((e) => e.event));
  const grouping = query.grouping ?? BY_STATE;
  const window = query.window ?? {};
  const input: KindInput = {
    events,
    context,
    live: query.live ?? null,
    sources: query.sources ?? {},
    kindOfTarget: (type) => registry.kindOfTarget(type),
  };
  const rows: MapRow[] = [];
  const transitions: MapTransition[] = [];
  const problems: MapProblem[] = [];
  const totals = { items: 0, open: 0, waitingOnPerson: 0 };
  const present = new Set<string>();
  const listed: KindDecl[] = [];

  for (const kind of registry.list()) {
    let drafts: readonly ItemDraft[];
    try {
      drafts = kind.items(input);
    } catch (err) {
      problems.push({ kind: kind.id, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    listed.push(kind);
    const byId = new Map(kind.states.map((s) => [s.id, s]));
    const columns: (Column & { class: StateClass })[] = [];
    const columnOf = new Map<string, Column>();
    for (const s of kind.states) {
      const c = grouping.columnOf(kind, s);
      columnOf.set(s.id, c);
      if (!columns.some((x) => x.id === c.id)) columns.push({ ...c, class: s.class });
    }
    const cells = new Map<string, MapCell>(
      columns.map((c) => [
        c.id,
        { column: c.id, count: 0, waitingOnPerson: 0, notes: [], items: [] },
      ]),
    );
    let total = 0;
    let waiting = 0;
    for (const d of drafts) {
      const undeclared = d.path.find((p) => !byId.has(p.state));
      if (d.path.length === 0 || undeclared !== undefined) {
        problems.push({
          kind: kind.id,
          message:
            d.path.length === 0
              ? `${d.id} has no state`
              : `${d.id} is in ${undeclared?.state}, which ${kind.id} doesn't declare`,
        });
        continue;
      }
      const last = d.path[d.path.length - 1] as PathEntry;
      const state = byId.get(last.state) as StateDecl;
      const column = (columnOf.get(state.id) as Column).id;
      const onPerson = state.class === "waiting" && state.waitsOn === "user";
      const item: MapItem = {
        context,
        kind: kind.id,
        id: d.id,
        label: d.label,
        state: state.id,
        stateLabel: state.label,
        class: state.class,
        waitsOn: state.class === "waiting" ? (state.waitsOn ?? null) : null,
        column,
        since: last.at,
        note: d.note ?? null,
        open: d.open,
      };
      const cell = cells.get(column) as MapCell;
      present.add(itemKey(kind.id, d.id));
      cell.items.push(item);
      cell.count++;
      if (onPerson) cell.waitingOnPerson++;
      total++;
      if (onPerson) waiting++;
      totals.items++;
      if (state.class !== "terminal") totals.open++;
      if (onPerson) totals.waitingOnPerson++;
      d.path.forEach((p, i) => {
        if (window.since !== undefined && p.at < window.since) return;
        if (window.until !== undefined && p.at > window.until) return;
        const prev = i === 0 ? null : (d.path[i - 1] as PathEntry);
        transitions.push({
          context,
          kind: kind.id,
          item: d.id,
          label: d.label,
          from: prev?.state ?? null,
          to: p.state,
          fromColumn: prev === null ? null : (columnOf.get(prev.state) as Column).id,
          toColumn: (columnOf.get(p.state) as Column).id,
          at: p.at,
          seq: p.seq,
        });
      });
    }
    const stale = kind.freshness?.(input) ?? null;
    if (stale !== null) problems.push({ kind: kind.id, message: stale });
    if (kind.alwaysShown !== true && total === 0) continue;
    for (const c of cells.values()) {
      c.items.sort((a, b) =>
        a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : 1,
      );
      const noted = new Map<string, number>();
      for (const i of c.items) if (i.note !== null) noted.set(i.note, (noted.get(i.note) ?? 0) + 1);
      c.notes = [...noted]
        .map(([note, count]) => ({ note, count }))
        .sort((a, b) => b.count - a.count || (a.note < b.note ? -1 : 1));
    }
    rows.push({
      kind: kind.id,
      label: kind.label,
      source: kind.source,
      derivation: kind.derivation,
      columns,
      cells: columns.map((c) => cells.get(c.id) as MapCell),
      total,
      waitingOnPerson: waiting,
      stale,
    });
  }
  const edges = foldEdges(listed, input, present, problems);
  // By time, then by place in the log: things that live outside the log have no place in it.
  transitions.sort(
    (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq) || (a.item < b.item ? -1 : 1),
  );
  const lastEvent = events.at(-1)?.event;
  return {
    context,
    position,
    at: lastEvent?.at ?? null,
    grouping: { id: grouping.id, label: grouping.label },
    window,
    rows,
    transitions,
    edges,
    totals,
    problems,
  };
}

const itemKey = (kind: string, id: string): string => `${kind}\u0000${id}`;

/**
 * The edges of the kinds that listed their items, those with both ends on the map, once each, in
 * a fixed order. What a kind's `edges` throws is a problem of that kind; the rest stays.
 */
function foldEdges(
  kinds: readonly KindDecl[],
  input: KindInput,
  present: ReadonlySet<string>,
  problems: MapProblem[],
): MapEdge[] {
  const seen = new Map<string, MapEdge>();
  for (const kind of kinds) {
    if (kind.edges === undefined) continue;
    let drafts: readonly EdgeDraft[];
    try {
      drafts = kind.edges(input);
    } catch (err) {
      problems.push({
        kind: kind.id,
        message: `${kind.id}'s references: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const d of drafts) {
      const from = itemKey(d.from.kind, d.from.id);
      const to = itemKey(d.to.kind, d.to.id);
      if (from === to || !present.has(from) || !present.has(to)) continue;
      const key = `${from}\u0001${to}\u0001${d.rel}`;
      const known = seen.get(key);
      // The same reference said twice is one; the earlier time is when it was first made.
      if (known === undefined)
        seen.set(key, {
          context: input.context,
          from: d.from,
          to: d.to,
          rel: d.rel,
          at: d.at ?? null,
        });
      else if (d.at != null && (known.at === null || d.at < known.at)) known.at = d.at;
    }
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
}

/** Whether two maps say the same thing. */
export function sameMap(a: MapSnapshot, b: MapSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A sentence that asks for the map: "show the map", "open the map", "show me everything that's
 * moving". draft recognizes it itself, as it does a sentence that opens a context, so the agent
 * is never asked to draw it (docs/model.md, "The map").
 */
const MAP_REQUEST =
  /^(?:please\s+)?(?:(?:show|open|bring\s+up|pull\s+up)(?:\s+me)?\s+(?:the|this\s+context['’]s)\s+map|show(?:\s+me)?\s+everything\s+(?:that['’]?s|that\s+is)\s+moving)(?:\s+please)?\s*[.!?]?$/i;

export function isMapRequest(text: string): boolean {
  return MAP_REQUEST.test(text.trim());
}
