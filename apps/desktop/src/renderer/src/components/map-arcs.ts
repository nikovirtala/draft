/**
 * The arcs between the state cells of one row of the map, as plain data.
 *
 * Every arc starts and ends on the top edge of a cell (the bottom edge of the strip the arcs are
 * drawn in), so none covers a cell's label. Arcs on one side of a line cross only when their ends
 * interleave (a to c and b to d with a < b < c < d); every other set can be stacked, and is: an arc
 * that holds another is drawn higher than it, and the ends that meet in a cell are spread along
 * its edge in the order that keeps them apart. The arrowhead is one size for every arc, in
 * pixels, whatever the arc's length or the width of its stroke.
 */

/** A cell's pitch along the row, and the gap between two cells inside it. */
export const CELL = 92;
export const GAP = 2;
/** The distance between two arc ends that meet in the same cell. */
export const SLOT = 8;
/** The arrowhead: the same for every arc, drawn in the strip's own pixels. */
export const HEAD = 8;
/** The lowest arc's height above the cells, and each level's step above the one below. */
export const BASE = HEAD + 6;
export const STEP = 8;

/** A move between two cells of a row: indexes into the row's columns, and how many items made it. */
export interface Move {
  from: number;
  to: number;
  n: number;
}

export interface Arc extends Move {
  /** 1 for an arc that holds no other, one more than the highest it holds otherwise. */
  level: number;
  /** Where the arc starts and ends along the row, on the cells' top edge. */
  x1: number;
  x2: number;
  /** How high the arc's highest point is above the cells. */
  apex: number;
  /** The width of the stroke, from how many items made the move. */
  stroke: number;
  /** The SVG path, in a strip `height` tall whose bottom edge is the cells' top edge. */
  d: string;
}

export interface Arcs {
  /** The strip's height. */
  height: number;
  width: number;
  head: number;
  arcs: Arc[];
}

export const strokeOf = (n: number): number => Math.min(3, 1.2 + n * 0.4);

/** The middle of the cell at `index`. */
export const centre = (index: number): number => index * CELL + (CELL - GAP) / 2;

const span = (m: Move): [number, number] => [Math.min(m.from, m.to), Math.max(m.from, m.to)];

/** An arc holds another when the other's cells lie within its own. */
function holds(outer: Move, inner: Move): boolean {
  const [a, b] = span(outer);
  const [c, d] = span(inner);
  return a <= c && d <= b;
}

export function layoutArcs(columns: number, moves: readonly Move[]): Arcs {
  // Shorter first, so that what an arc holds has its level before the arc does. Of two moves
  // between the same cells, the one that goes forward is the lower.
  const ordered = [...moves].sort(
    (p, q) =>
      Math.abs(p.to - p.from) - Math.abs(q.to - q.from) ||
      Number(q.to > q.from) - Number(p.to > p.from) ||
      Math.min(p.from, p.to) - Math.min(q.from, q.to),
  );
  const levels = new Map<Move, number>();
  for (const [i, m] of ordered.entries()) {
    let level = 1;
    for (const inner of ordered.slice(0, i))
      if (holds(m, inner)) level = Math.max(level, (levels.get(inner) ?? 1) + 1);
    levels.set(m, level);
  }

  // The ends in each cell, left to right: what comes from the left, the shortest first, then what
  // goes to the right, the longest first, so that an arc's ends enclose those of the arcs it holds. Each end is put at its place among its cell's.
  const ends = new Map<number, { move: Move; start: boolean }[]>();
  for (const m of ordered)
    for (const [cell, start] of [
      [m.from, true],
      [m.to, false],
    ] as const) {
      const list = ends.get(cell) ?? [];
      list.push({ move: m, start });
      ends.set(cell, list);
    }
  const x = new Map<string, number>();
  const key = (m: Move, start: boolean) => `${m.from}>${m.to}:${start ? "from" : "to"}`;
  for (const [cell, list] of ends) {
    const other = (e: { move: Move; start: boolean }) => (e.start ? e.move.to : e.move.from);
    const level = (e: { move: Move }) => levels.get(e.move) ?? 1;
    const left = list.filter((e) => other(e) < cell).sort((p, q) => level(p) - level(q));
    const right = list.filter((e) => other(e) > cell).sort((p, q) => level(q) - level(p));
    const row = [...left, ...right];
    for (const [i, e] of row.entries())
      x.set(key(e.move, e.start), centre(cell) + (i - (row.length - 1) / 2) * SLOT);
  }

  const top = Math.max(0, ...[...levels.values()]);
  const height = top === 0 ? 0 : BASE + (top - 1) * STEP + 4;
  const arcs = ordered.map((m): Arc => {
    const level = levels.get(m) ?? 1;
    const x1 = x.get(key(m, true)) ?? centre(m.from);
    const x2 = x.get(key(m, false)) ?? centre(m.to);
    const apex = BASE + (level - 1) * STEP;
    // A cubic with both control points at `lift` has its highest point at three quarters of it.
    const lift = apex / 0.75;
    return {
      ...m,
      level,
      x1,
      x2,
      apex,
      stroke: strokeOf(m.n),
      d: `M${x1} ${height} C${x1} ${height - lift} ${x2} ${height - lift} ${x2} ${height}`,
    };
  });
  return { height, width: columns * CELL, head: HEAD, arcs };
}

/** Points along an arc, in the strip's own coordinates, for measuring and testing. */
export function sampleArc(a: Arc, height: number, steps = 64): [number, number][] {
  const lift = a.apex / 0.75;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k = 3 * t * t - 2 * t * t * t;
    out.push([a.x1 + (a.x2 - a.x1) * k, height - lift * 3 * t * (1 - t)]);
  }
  return out;
}
