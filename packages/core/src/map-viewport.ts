import type { Graph } from "./map-graph.ts";
import type { Labels } from "./map-labels.ts";
import { type Layout, type Point, radiusOf, WORLD } from "./map-layout.ts";

/**
 * Where the graph is looked at from (docs/model.md, "A layout that stays put"). A viewport is a
 * transform of the world, `screen = k * world + (x, y)`, in the world's own units, and nothing
 * else: no function here takes a layout, so panning and zooming can never move a node, and the
 * positions a person has learned stay put. The semantic zoom (context, kind, item) is a different
 * move, made by the person on purpose; when it changes level the view is fitted to the new one.
 *
 * Every input (a button, a key, a pinch, a scroll, a drag) is data, `ViewportInput`, and
 * `applyInput` is the one place that turns it into a viewport, so each can be tested alone.
 */

export interface Viewport {
  /** The scale: 1 shows the world at its own size. */
  k: number;
  /** Where the world's origin is on the screen, in world units. */
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 8;
/** A fit never magnifies by more than this, so two nodes aren't drawn as the whole screen. */
export const MAX_FIT_SCALE = 2;
/** What one press of a zoom button or key multiplies the scale by. */
export const ZOOM_STEP = 1.25;
/** How far an arrow key moves the view, in world units. */
export const PAN_STEP = 60;
/** At least this much of the graph stays in view, so it can't be lost off the screen. */
export const KEEP_IN_VIEW = 80;
const FIT_PADDING = 28;

/** The whole world in view at its own size. */
export const IDENTITY: Viewport = { k: 1, x: 0, y: 0 };

/** What the viewport is moved by. A point is in world units of the frame, not of the graph. */
export type ViewportInput =
  | { type: "zoom"; factor: number; at?: Point }
  | { type: "pan"; dx: number; dy: number }
  | { type: "fit" };

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export const FRAME: Rect = { left: 0, top: 0, right: WORLD.width, bottom: WORLD.height };

const CENTER: Point = { x: WORLD.width / 2, y: WORLD.height / 2 };

/** Where a point of the world is on the screen. */
export const toScreen = (v: Viewport, p: Point): Point => ({
  x: v.k * p.x + v.x,
  y: v.k * p.y + v.y,
});

/** The point of the world a point of the screen shows. */
export const toWorld = (v: Viewport, p: Point): Point => ({
  x: (p.x - v.x) / v.k,
  y: (p.y - v.y) / v.k,
});

/** The viewport scaled by `factor` with the world point under `at` staying under it. */
export function zoomAbout(v: Viewport, factor: number, at: Point = CENTER): Viewport {
  const k = clamp(v.k * factor, MIN_SCALE, MAX_SCALE);
  const ratio = k / v.k;
  return { k, x: at.x - (at.x - v.x) * ratio, y: at.y - (at.y - v.y) * ratio };
}

/** The viewport moved by `dx`, `dy` of the screen: the graph follows the hand. */
export const panBy = (v: Viewport, dx: number, dy: number): Viewport => ({
  k: v.k,
  x: v.x + dx,
  y: v.y + dy,
});

/** The viewport that shows all of `bounds`, centred, with some room around it. */
export function fitTo(bounds: Rect, frame: Rect = FRAME): Viewport {
  const w = Math.max(1, bounds.right - bounds.left + 2 * FIT_PADDING);
  const h = Math.max(1, bounds.bottom - bounds.top + 2 * FIT_PADDING);
  const k = clamp(
    Math.min((frame.right - frame.left) / w, (frame.bottom - frame.top) / h),
    MIN_SCALE,
    MAX_FIT_SCALE,
  );
  const cx = (bounds.left + bounds.right) / 2;
  const cy = (bounds.top + bounds.bottom) / 2;
  return {
    k,
    x: (frame.left + frame.right) / 2 - k * cx,
    y: (frame.top + frame.bottom) / 2 - k * cy,
  };
}

/** The viewport moved the least that keeps `KEEP_IN_VIEW` of the graph's bounds in the frame. */
export function keepInReach(v: Viewport, bounds: Rect, frame: Rect = FRAME): Viewport {
  const keep = Math.min(
    KEEP_IN_VIEW,
    (frame.right - frame.left) / 2,
    (frame.bottom - frame.top) / 2,
  );
  const shown = (b: Rect): Rect => ({
    left: v.k * b.left + v.x,
    top: v.k * b.top + v.y,
    right: v.k * b.right + v.x,
    bottom: v.k * b.bottom + v.y,
  });
  const s = shown(bounds);
  let { x, y } = v;
  if (s.right < frame.left + keep) x += frame.left + keep - s.right;
  if (s.left > frame.right - keep) x -= s.left - (frame.right - keep);
  if (s.bottom < frame.top + keep) y += frame.top + keep - s.bottom;
  if (s.top > frame.bottom - keep) y -= s.top - (frame.bottom - keep);
  return x === v.x && y === v.y ? v : { k: v.k, x, y };
}

/** The space a graph takes: every node's circle, and a cluster's name under it. */
export function boundsOf(graph: Graph, layout: Layout, labels: Labels = {}): Rect {
  let b: Rect | null = null;
  const take = (left: number, top: number, right: number, bottom: number) => {
    b =
      b === null
        ? { left, top, right, bottom }
        : {
            left: Math.min(b.left, left),
            top: Math.min(b.top, top),
            right: Math.max(b.right, right),
            bottom: Math.max(b.bottom, bottom),
          };
  };
  for (const n of graph.nodes) {
    const p = layout[n.id];
    if (p === undefined) continue;
    const r = radiusOf(n) + (n.type === "cluster" ? 6 : 2);
    take(p.x - r, p.y - r, p.x + r, p.y + r);
  }
  // A name takes room too, wherever it was put.
  for (const l of Object.values(labels))
    take(l.x - l.w / 2, l.y - l.h / 2, l.x + l.w / 2, l.y + l.h / 2);
  // The states of a kind view are named along the top.
  if (graph.zoom.level === "kind" && graph.lanes.length > 0) take(0, 0, WORLD.width, 22);
  return b ?? FRAME;
}

/** The viewport for a graph at its layout, fitted; the whole world when there is nothing to fit. */
export const fitGraph = (graph: Graph, layout: Layout, labels: Labels = {}): Viewport =>
  graph.nodes.length === 0 ? IDENTITY : fitTo(boundsOf(graph, layout, labels));

/** Whether two viewports show the same thing, give or take a rounding. */
export const sameViewport = (a: Viewport, b: Viewport): boolean =>
  Math.abs(a.k - b.k) < 1e-6 && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;

/**
 * One input applied to a viewport. `bounds` is the graph's own space, so a pan or a zoom can't
 * carry it out of reach; `fit` is the viewport a fit input goes to.
 */
export function applyInput(
  v: Viewport,
  input: ViewportInput,
  ctx: { bounds: Rect; fit: Viewport },
): Viewport {
  if (input.type === "fit") return ctx.fit;
  const next =
    input.type === "zoom" ? zoomAbout(v, input.factor, input.at) : panBy(v, input.dx, input.dy);
  return keepInReach(next, ctx.bounds);
}

/* ----------------------------------------------------------------------------------------------- */
/* Inputs                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}

/**
 * What a key does to the view: Cmd (or Ctrl) with plus or minus zooms, with 0 fits; the arrow keys
 * move the view the way scrolling does (Right shows what is to the right). Null for any other key.
 */
export function keyInput(e: KeyLike): ViewportInput | null {
  if (e.altKey === true) return null;
  const chord = e.metaKey || e.ctrlKey;
  if (chord) {
    if (e.key === "+" || e.key === "=") return { type: "zoom", factor: ZOOM_STEP };
    if (e.key === "-" || e.key === "_") return { type: "zoom", factor: 1 / ZOOM_STEP };
    if (e.key === "0") return { type: "fit" };
    return null;
  }
  switch (e.key) {
    case "ArrowLeft":
      return { type: "pan", dx: PAN_STEP, dy: 0 };
    case "ArrowRight":
      return { type: "pan", dx: -PAN_STEP, dy: 0 };
    case "ArrowUp":
      return { type: "pan", dx: 0, dy: PAN_STEP };
    case "ArrowDown":
      return { type: "pan", dx: 0, dy: -PAN_STEP };
    default:
      return null;
  }
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** A pinch on a trackpad arrives as a wheel with the control key down. */
  ctrlKey: boolean;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode?: number;
}

/** How much a pinch's delta zooms by: a delta of -10 is about a tenth more. */
const PINCH_RATE = 0.01;
const LINE_PX = 16;

/**
 * What a wheel event does: a pinch zooms about the pointer, and a two-finger scroll moves the view
 * with the fingers. `pixel` is the size of a screen pixel in world units, so a scroll of 10 pixels
 * moves the graph 10 pixels however large the panel is; `at` is the pointer, in world units.
 */
export function wheelInput(e: WheelLike, at: Point, pixel = 1): ViewportInput {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? 400 : 1;
  if (e.ctrlKey)
    return {
      type: "zoom",
      factor: clamp(Math.exp(-e.deltaY * unit * PINCH_RATE), 0.5, 2),
      at,
    };
  return { type: "pan", dx: -e.deltaX * unit * pixel, dy: -e.deltaY * unit * pixel };
}
