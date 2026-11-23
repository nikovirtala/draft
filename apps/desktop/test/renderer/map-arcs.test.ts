import { describe, expect, it } from "vitest";
import {
  type Arc,
  centre,
  HEAD,
  layoutArcs,
  type Move,
  sampleArc,
} from "../../src/renderer/src/components/map-arcs.ts";

type P = [number, number];

const side = (a: P, b: P, c: P): number =>
  Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const crosses = (a: P, b: P, c: P, d: P): boolean =>
  side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;

/** Whether two arcs' paths cross, measured on points along them. */
function intersect(p: Arc, q: Arc, height: number): boolean {
  const a = sampleArc(p, height);
  const b = sampleArc(q, height);
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++)
      if (crosses(a[i - 1] as P, a[i] as P, b[j - 1] as P, b[j] as P)) return true;
  return false;
}

const interleaved = (p: Move, q: Move): boolean => {
  const [a, b] = [Math.min(p.from, p.to), Math.max(p.from, p.to)];
  const [c, d] = [Math.min(q.from, q.to), Math.max(q.from, q.to)];
  return (a < c && c < b && b < d) || (c < a && a < d && d < b);
};

const every = (columns: number): Move[] =>
  Array.from({ length: columns }, (_, from) =>
    Array.from({ length: columns }, (_, to) => ({ from, to, n: 1 })).filter((m) => m.to !== m.from),
  ).flat();

const crossings = (moves: Move[], columns: number): [Arc, Arc][] => {
  const { arcs, height } = layoutArcs(columns, moves);
  return arcs.flatMap((p, i) =>
    arcs.slice(i + 1).flatMap((q): [Arc, Arc][] => (intersect(p, q, height) ? [[p, q]] : [])),
  );
};

describe("the arcs between a row's state cells", () => {
  it("do not cross for a kind of three states (Issues), every move in both directions", () => {
    expect(crossings(every(3), 3)).toEqual([]);
    // As the log has them: open, in progress, closed, and a reopened issue.
    const moves = [
      { from: 0, to: 1, n: 3 },
      { from: 1, to: 2, n: 2 },
      { from: 0, to: 2, n: 1 },
      { from: 2, to: 0, n: 1 },
    ];
    expect(crossings(moves, 3)).toEqual([]);
  });

  it("do not cross for a kind of six states (Decisions) unless their ends interleave", () => {
    const moves = every(6);
    const { arcs, height } = layoutArcs(6, moves);
    const wrong: string[] = [];
    for (const [i, p] of arcs.entries())
      for (const q of arcs.slice(i + 1))
        if (intersect(p, q, height) !== interleaved(p, q))
          wrong.push(`${p.from}>${p.to} and ${q.from}>${q.to}`);
    expect(wrong).toEqual([]);
    // Nothing interleaves in a chain, in a fan from one state, or in nested moves.
    for (const set of [
      [0, 1, 2, 3, 4, 5].slice(1).map((to, i) => ({ from: i, to, n: 1 })),
      [1, 2, 3, 4, 5].map((to) => ({ from: 0, to, n: 1 })),
      [
        { from: 0, to: 5, n: 1 },
        { from: 1, to: 4, n: 2 },
        { from: 2, to: 3, n: 1 },
        { from: 5, to: 0, n: 1 },
      ],
    ])
      expect(crossings(set, 6)).toEqual([]);
  });

  it("start and end on the cells' top edge, inside the strip, and a shorter arc is lower", () => {
    const { arcs, height } = layoutArcs(6, [
      { from: 0, to: 1, n: 1 },
      { from: 1, to: 2, n: 1 },
      { from: 0, to: 2, n: 1 },
      { from: 0, to: 5, n: 1 },
    ]);
    for (const a of arcs) {
      const pts = sampleArc(a, height);
      expect(pts[0]?.[1]).toBe(height);
      expect(pts.at(-1)?.[1]).toBe(height);
      expect(Math.min(...pts.map((p) => p[1]))).toBeGreaterThanOrEqual(0);
      // Each end is inside the cell it belongs to.
      expect(Math.abs(a.x1 - centre(a.from))).toBeLessThan(40);
      expect(Math.abs(a.x2 - centre(a.to))).toBeLessThan(40);
    }
    const apex = (from: number, to: number) =>
      arcs.find((a) => a.from === from && a.to === to)?.apex ?? 0;
    expect(apex(0, 1)).toBeLessThan(apex(0, 2));
    expect(apex(1, 2)).toBeLessThan(apex(0, 2));
    expect(apex(0, 2)).toBeLessThan(apex(0, 5));
  });

  it("keep the ends that meet in one cell apart", () => {
    const { arcs } = layoutArcs(3, every(3));
    const ends = arcs.flatMap((a) => [
      [a.from, a.x1],
      [a.to, a.x2],
    ]);
    const seen = new Set(ends.map(([c, x]) => `${c}@${x}`));
    expect(seen.size).toBe(ends.length);
  });

  it("have one arrowhead size, whatever the arc's length or the width of its stroke", () => {
    const short = layoutArcs(3, [{ from: 0, to: 1, n: 1 }]);
    const long = layoutArcs(6, [
      { from: 0, to: 5, n: 9 },
      { from: 1, to: 2, n: 1 },
    ]);
    expect(short.head).toBe(HEAD);
    expect(long.head).toBe(HEAD);
    expect(layoutArcs(6, every(6)).head).toBe(HEAD);
    // The stroke differs between arcs; the head is not a function of it.
    expect(new Set(long.arcs.map((a) => a.stroke)).size).toBe(2);
  });
});
