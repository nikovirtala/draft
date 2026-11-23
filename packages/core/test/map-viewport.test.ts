import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryLogStore } from "../src/log.ts";
import { foldMap } from "../src/map.ts";
import { projectGraph } from "../src/map-graph.ts";
import { mapRegistry } from "../src/map-kinds.ts";
import { layoutGraph, type Point, WORLD } from "../src/map-layout.ts";
import {
  applyInput,
  boundsOf,
  FRAME,
  fitGraph,
  fitTo,
  IDENTITY,
  KEEP_IN_VIEW,
  keepInReach,
  keyInput,
  MAX_FIT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  PAN_STEP,
  panBy,
  sameViewport,
  toScreen,
  toWorld,
  type Viewport,
  type ViewportInput,
  wheelInput,
  ZOOM_STEP,
  zoomAbout,
} from "../src/map-viewport.ts";
import { appendMapFixture } from "../src/testing/index.ts";

const near = (a: Point, b: Point) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}) =>
  keyInput({ key: k, metaKey: mods.meta ?? false, ctrlKey: mods.ctrl ?? false, altKey: mods.alt });

describe("the viewport's maths", () => {
  it("zooms about a point: the world point under it stays under it", () => {
    const v: Viewport = { k: 1.5, x: -120, y: 40 };
    const at = { x: 300, y: 200 };
    const before = toWorld(v, at);
    const zoomed = zoomAbout(v, 1.25, at);
    expect(zoomed.k).toBeCloseTo(1.875, 9);
    near(toWorld(zoomed, at), before);
    near(toScreen(zoomed, before), at);
  });

  it("zooms about the middle of the frame when no point is given", () => {
    const zoomed = zoomAbout(IDENTITY, 2);
    near(toScreen(zoomed, { x: WORLD.width / 2, y: WORLD.height / 2 }), {
      x: WORLD.width / 2,
      y: WORLD.height / 2,
    });
  });

  it("keeps the scale between its limits, and then holds the point", () => {
    const out = zoomAbout(IDENTITY, 1e6, { x: 10, y: 20 });
    expect(out.k).toBe(MAX_SCALE);
    near(toWorld(out, { x: 10, y: 20 }), { x: 10, y: 20 });
    expect(zoomAbout(IDENTITY, 1e-6).k).toBe(MIN_SCALE);
  });

  it("zooming in and out by the same factor comes back", () => {
    const v: Viewport = { k: 1.2, x: 33, y: -17 };
    const back = zoomAbout(zoomAbout(v, ZOOM_STEP, { x: 50, y: 60 }), 1 / ZOOM_STEP, {
      x: 50,
      y: 60,
    });
    expect(back.k).toBeCloseTo(v.k, 9);
    expect(back.x).toBeCloseTo(v.x, 9);
    expect(back.y).toBeCloseTo(v.y, 9);
  });

  it("pans by the distance moved, at any scale", () => {
    const v: Viewport = { k: 3, x: 10, y: 20 };
    expect(panBy(v, 5, -7)).toEqual({ k: 3, x: 15, y: 13 });
  });

  it("fits bounds in the frame, centred, with room around, and never magnifies past the limit", () => {
    const bounds = { left: 100, top: 50, right: 500, bottom: 250 };
    const v = fitTo(bounds);
    const tl = toScreen(v, { x: bounds.left, y: bounds.top });
    const br = toScreen(v, { x: bounds.right, y: bounds.bottom });
    expect(tl.x).toBeGreaterThan(0);
    expect(tl.y).toBeGreaterThan(0);
    expect(br.x).toBeLessThan(WORLD.width);
    expect(br.y).toBeLessThan(WORLD.height);
    // Centred: the same room each side.
    expect(tl.x).toBeCloseTo(WORLD.width - br.x, 6);
    expect(tl.y).toBeCloseTo(WORLD.height - br.y, 6);
    // One small node is not blown up to the whole panel.
    expect(fitTo({ left: 400, top: 250, right: 410, bottom: 260 }).k).toBe(MAX_FIT_SCALE);
  });

  it("fits bounds larger than the frame by zooming out", () => {
    const v = fitTo({ left: -500, top: -300, right: 1400, bottom: 840 });
    expect(v.k).toBeLessThan(1);
    const tl = toScreen(v, { x: -500, y: -300 });
    const br = toScreen(v, { x: 1400, y: 840 });
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(WORLD.width);
    expect(br.y).toBeLessThanOrEqual(WORLD.height);
  });

  it("can't be panned until the graph is out of reach", () => {
    const bounds = { left: 100, top: 100, right: 300, bottom: 300 };
    const lost = keepInReach(panBy(IDENTITY, -5000, 5000), bounds);
    const tl = toScreen(lost, { x: bounds.left, y: bounds.top });
    const br = toScreen(lost, { x: bounds.right, y: bounds.bottom });
    expect(br.x).toBeGreaterThanOrEqual(KEEP_IN_VIEW - 1e-9);
    expect(tl.y).toBeLessThanOrEqual(WORLD.height - KEEP_IN_VIEW + 1e-9);
    // A view that is in reach is the very same object.
    expect(keepInReach(IDENTITY, bounds)).toBe(IDENTITY);
  });
});

describe("the inputs", () => {
  const ctx = {
    bounds: { left: 0, top: 0, right: WORLD.width, bottom: WORLD.height },
    fit: IDENTITY,
  };

  it("zooms with Cmd and plus or minus, and with Ctrl where there is no Cmd", () => {
    expect(key("+", { meta: true })).toEqual({ type: "zoom", factor: ZOOM_STEP });
    expect(key("=", { meta: true })).toEqual({ type: "zoom", factor: ZOOM_STEP });
    expect(key("-", { meta: true })).toEqual({ type: "zoom", factor: 1 / ZOOM_STEP });
    expect(key("+", { ctrl: true })).toEqual({ type: "zoom", factor: ZOOM_STEP });
    expect(key("-", { ctrl: true })).toEqual({ type: "zoom", factor: 1 / ZOOM_STEP });
  });

  it("fits with Cmd and 0, and ignores plus and minus without Cmd", () => {
    expect(key("0", { meta: true })).toEqual({ type: "fit" });
    expect(key("+")).toBeNull();
    expect(key("-")).toBeNull();
    expect(key("0")).toBeNull();
    expect(key("+", { meta: true, alt: true })).toBeNull();
  });

  it("pans with the arrow keys the way scrolling does, and ignores the rest", () => {
    expect(key("ArrowRight")).toEqual({ type: "pan", dx: -PAN_STEP, dy: 0 });
    expect(key("ArrowLeft")).toEqual({ type: "pan", dx: PAN_STEP, dy: 0 });
    expect(key("ArrowDown")).toEqual({ type: "pan", dx: 0, dy: -PAN_STEP });
    expect(key("ArrowUp")).toEqual({ type: "pan", dx: 0, dy: PAN_STEP });
    expect(key("Enter")).toBeNull();
    expect(key("a")).toBeNull();
    // An arrow with Cmd is the browser's, not the graph's.
    expect(key("ArrowLeft", { meta: true })).toBeNull();
  });

  it("applies a keyboard zoom and pan to the view", () => {
    const zoomed = applyInput(IDENTITY, key("+", { meta: true }) as ViewportInput, ctx);
    expect(zoomed.k).toBeCloseTo(ZOOM_STEP, 9);
    const right = applyInput(zoomed, key("ArrowRight") as ViewportInput, ctx);
    expect(right.k).toBe(zoomed.k);
    expect(right.x).toBeCloseTo(zoomed.x - PAN_STEP, 9);
    expect(right.y).toBe(zoomed.y);
    const out = applyInput(right, key("-", { meta: true }) as ViewportInput, ctx);
    expect(out.k).toBeCloseTo(1, 9);
  });

  it("goes back to the fit on a fit input, wherever the view was", () => {
    const fit: Viewport = { k: 1.4, x: -20, y: -10 };
    expect(applyInput({ k: 5, x: 300, y: 300 }, { type: "fit" }, { ...ctx, fit })).toBe(fit);
  });

  it("zooms about the pointer on a pinch, in on a negative delta and out on a positive one", () => {
    const at = { x: 200, y: 100 };
    const inward = wheelInput({ deltaX: 0, deltaY: -10, ctrlKey: true }, at);
    const outward = wheelInput({ deltaX: 0, deltaY: 10, ctrlKey: true }, at);
    expect(inward).toMatchObject({ type: "zoom", at });
    expect((inward as { factor: number }).factor).toBeGreaterThan(1);
    expect((outward as { factor: number }).factor).toBeLessThan(1);
    const v = applyInput(IDENTITY, inward, ctx);
    near(toWorld(v, at), at);
  });

  it("pans with the fingers on a two-finger scroll, scaled to the panel", () => {
    const at = { x: 0, y: 0 };
    expect(wheelInput({ deltaX: 12, deltaY: -30, ctrlKey: false }, at)).toEqual({
      type: "pan",
      dx: -12,
      dy: 30,
    });
    // A panel drawn at half the world's size: 10 screen pixels are 20 world units.
    expect(wheelInput({ deltaX: 10, deltaY: 0, ctrlKey: false }, at, 2)).toEqual({
      type: "pan",
      dx: -20,
      dy: -0,
    });
  });
});

describe("a viewport never moves a node", () => {
  async function graphAndLayout() {
    const log = new MemoryLogStore();
    await appendMapFixture(log);
    const map = foldMap(await log.events(), mapRegistry);
    const graph = projectGraph(map);
    return { graph, layout: layoutGraph(graph) };
  }

  const inputs: fc.Arbitrary<ViewportInput> = fc.oneof(
    fc.record({
      type: fc.constant("zoom" as const),
      factor: fc.double({ min: 0.2, max: 5, noNaN: true }),
      at: fc.record({
        x: fc.double({ min: 0, max: WORLD.width, noNaN: true }),
        y: fc.double({ min: 0, max: WORLD.height, noNaN: true }),
      }),
    }),
    fc.record({
      type: fc.constant("pan" as const),
      dx: fc.double({ min: -2000, max: 2000, noNaN: true }),
      dy: fc.double({ min: -2000, max: 2000, noNaN: true }),
    }),
    fc.constant({ type: "fit" as const }),
  );

  it("leaves the layout as it was after any run of inputs, and the layout never reads the viewport", async () => {
    const { graph, layout } = await graphAndLayout();
    const bounds = boundsOf(graph, layout);
    const fit = fitGraph(graph, layout);
    const frozen = structuredClone(layout);
    fc.assert(
      fc.property(fc.array(inputs, { maxLength: 40 }), (run) => {
        let v: Viewport = fit;
        for (const input of run) v = applyInput(v, input, { bounds, fit });
        // Every node is still where it was, in the world, and the view says where that is.
        expect(layout).toEqual(frozen);
        expect(layoutGraph(graph, layout)).toEqual(layoutGraph(graph, frozen));
        for (const p of Object.values(layout)) near(toWorld(v, toScreen(v, p)), p);
        // The scale is always a usable one, and the graph is never lost.
        expect(v.k).toBeGreaterThanOrEqual(MIN_SCALE);
        expect(v.k).toBeLessThanOrEqual(MAX_SCALE);
        expect(sameViewport(keepInReach(v, bounds), v)).toBe(true);
      }),
      { numRuns: 200 },
    );
    // The layout is the same one a person who never touched the view would see.
    expect(layoutGraph(graph, null)).toEqual(layout);
  });

  it("fits every node of a graph in the panel", async () => {
    const { graph, layout } = await graphAndLayout();
    const v = fitGraph(graph, layout);
    for (const p of Object.values(layout)) {
      const s = toScreen(v, p);
      expect(s.x).toBeGreaterThanOrEqual(FRAME.left);
      expect(s.x).toBeLessThanOrEqual(FRAME.right);
      expect(s.y).toBeGreaterThanOrEqual(FRAME.top);
      expect(s.y).toBeLessThanOrEqual(FRAME.bottom);
    }
  });

  it("fits each level of the semantic zoom on its own, and an empty graph shows the whole world", async () => {
    const log = new MemoryLogStore();
    await appendMapFixture(log);
    const map = foldMap(await log.events(), mapRegistry);
    const context = projectGraph(map);
    const cluster = context.nodes.find((n) => n.type === "cluster");
    if (cluster === undefined) throw new Error("the fixture has no cluster");
    const inKind = projectGraph(map, { level: "kind", kind: cluster.kind });
    const lay = layoutGraph(inKind);
    const v = fitGraph(inKind, lay);
    for (const p of Object.values(lay)) {
      const s = toScreen(v, p);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(WORLD.width);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(WORLD.height);
    }
    expect(fitGraph({ ...inKind, nodes: [], lanes: [] }, {})).toEqual(IDENTITY);
  });
});
