import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubClient } from "../src/github.ts";
import { MemoryLogStore } from "../src/log.ts";
import { foldMap, type MapSnapshot } from "../src/map.ts";
import { ArkMap } from "../src/map-ark.ts";
import { type Graph, projectGraph } from "../src/map-graph.ts";
import { mapRegistry } from "../src/map-kinds.ts";
import { type LabelBox, type Labels, layoutLabels } from "../src/map-labels.ts";
import { type Layout, layoutGraph, radiusOf, WORLD } from "../src/map-layout.ts";
import { boundsOf } from "../src/map-viewport.ts";
import { appendMapFixture, FakeGithub, seedArk } from "../src/testing/index.ts";

let github: FakeGithub;
beforeEach(async () => {
  github = await new FakeGithub().start();
});
afterEach(async () => {
  await github.stop();
});

/** The fixture context's map: the log's kinds, and the ark kinds of a repository it covers. */
async function fixtureMap(): Promise<MapSnapshot> {
  const log = new MemoryLogStore();
  await appendMapFixture(log);
  seedArk(github);
  const registry = mapRegistry.fork();
  const ark = new ArkMap(registry, {
    github: new GithubClient({ token: "t", baseUrl: github.baseUrl }),
    repos: () => ["nikovirtala/draft"],
    intervalMs: 0,
  });
  ark.setVisible("w", true);
  await ark.tick();
  return foldMap(await log.events(), registry, { sources: ark.sources() });
}

const rectOf = (l: LabelBox) => ({
  left: l.x - l.w / 2,
  right: l.x + l.w / 2,
  top: l.y - l.h / 2,
  bottom: l.y + l.h / 2,
});

/** What a label may not touch: every node's drawing (circle, ring or loop) and every other label. */
function collisions(graph: Graph, layout: Layout, labels: Labels): string[] {
  const found: string[] = [];
  const list = Object.values(labels);
  for (const l of list) {
    const b = rectOf(l);
    if (b.left < 0 || b.top < 0 || b.right > WORLD.width || b.bottom > WORLD.height)
      found.push(`${l.id} leaves the world`);
    for (const n of graph.nodes) {
      const p = layout[n.id];
      if (p === undefined) continue;
      const r = radiusOf(n) + (n.type === "cluster" ? 6 : 4);
      const nx = Math.max(b.left, Math.min(p.x, b.right));
      const ny = Math.max(b.top, Math.min(p.y, b.bottom));
      if (Math.hypot(nx - p.x, ny - p.y) < r) found.push(`${l.id} overlaps the node ${n.id}`);
    }
    for (const o of list) {
      if (o.id >= l.id) continue;
      const c = rectOf(o);
      if (b.left < c.right && c.left < b.right && b.top < c.bottom && c.top < b.bottom)
        found.push(`${l.id} overlaps the label ${o.id}`);
    }
  }
  return found;
}

/** Whether the view names items, as MapGraph decides: in an item's neighbourhood or a small graph. */
const named = (g: Graph): boolean => g.zoom.level === "item" || g.nodes.length <= 14;

describe("the names of the graph's nodes", () => {
  const scales = [0.8, 1, 1.2];

  it("overlap no node and no other name at the context, whatever the width of the panel", async () => {
    const map = await fixtureMap();
    const graph = projectGraph(map);
    expect(graph.nodes.filter((n) => n.type === "cluster").length).toBeGreaterThanOrEqual(8);
    const layout = layoutGraph(graph);
    for (const scale of scales) {
      // As the view draws it, and with every item named too.
      for (const items of [named(graph), true]) {
        const labels = layoutLabels(graph, layout, null, { named: items, scale });
        const wanted = graph.nodes.filter((n) => items || n.type === "cluster").length;
        expect(Object.keys(labels).length).toBe(wanted);
        if (items && !named(graph)) continue;
        expect(collisions(graph, layout, labels), `at ${scale}`).toEqual([]);
      }
    }
  });

  it("overlap nothing at every kind and every item of the fixture context either", async () => {
    const map = await fixtureMap();
    const checked: string[] = [];
    for (const row of map.rows) {
      const kind = projectGraph(map, { level: "kind", kind: row.kind });
      const layout = layoutGraph(kind);
      expect(
        collisions(kind, layout, layoutLabels(kind, layout, null, { named: named(kind) })),
        row.kind,
      ).toEqual([]);
      checked.push(row.kind);
      for (const i of row.cells.flatMap((c) => c.items).slice(0, 3)) {
        const item = projectGraph(map, { level: "item", kind: row.kind, id: i.id });
        const at = layoutGraph(item);
        expect(
          collisions(item, at, layoutLabels(item, at, null, { named: named(item) })),
          `${row.kind} ${i.id}`,
        ).toEqual([]);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(8);
  });

  it("never put the name of 'Interrupts: acceptance request' across the Steps cluster, nor 'permission request' under an item", async () => {
    const map = await fixtureMap();
    const graph = projectGraph(map);
    const layout = layoutGraph(graph);
    const labels = layoutLabels(graph, layout, null, { named: false });
    for (const n of graph.nodes)
      if (n.type === "cluster" && /Interrupts|Steps|Pull|Threads/.test(n.label))
        expect(labels[n.id]?.lines.join(" ")).toBeTruthy();
    expect(collisions(graph, layout, labels)).toEqual([]);
  });

  it("are wrapped or moved before they are shortened, and shortened only with room for nothing else", async () => {
    const map = await fixtureMap();
    const graph = projectGraph(map);
    const labels = layoutLabels(graph, layoutGraph(graph), null, { named: false });
    const used = new Set(Object.values(labels).map((l) => l.setting));
    // At the fixture's size no name has to lose a word of itself.
    expect(used.has("short")).toBe(false);
    for (const l of Object.values(labels)) {
      const n = graph.nodes.find((x) => x.id === l.id);
      expect(l.lines.join(" ")).toBe(n?.label);
    }
  });

  it("stay where they were while the log moves, and only a name something grew into moves", async () => {
    const map = await fixtureMap();
    const graph = projectGraph(map);
    const layout = layoutGraph(graph);
    const first = layoutLabels(graph, layout, null, { named: false });
    // The same graph again, and then with a node more, laid out from the layout before it.
    expect(layoutLabels(graph, layout, first, { named: false })).toEqual(first);
    const moved = { ...graph, nodes: graph.nodes.slice(0, -1) };
    const without = layoutLabels(moved, layout, first, { named: false });
    for (const [id, l] of Object.entries(without)) expect(first[id]).toEqual(l);
    const again = layoutLabels(graph, layout, without, { named: false });
    expect(collisions(graph, layout, again)).toEqual([]);
    const kept = Object.keys(without).filter((id) => again[id]?.side === without[id]?.side);
    expect(kept.length).toBeGreaterThanOrEqual(Object.keys(without).length - 1);
    // A function of its inputs.
    expect(layoutLabels(graph, layout, first, { named: false, scale: 1 })).toEqual(
      layoutLabels(graph, layout, first, { named: false, scale: 1 }),
    );
  });

  it("move to another side when something grows into them, and keep the others", async () => {
    const map = await fixtureMap();
    const graph = projectGraph(map);
    const layout = layoutGraph(graph);
    const first = layoutLabels(graph, layout, null, { named: false });
    // A panel a fifth narrower draws every name a quarter bigger: those that no longer fit move or wrap.
    const narrow = layoutLabels(graph, layout, first, { named: false, scale: 0.8 });
    expect(collisions(graph, layout, narrow)).toEqual([]);
    expect(
      Object.values(narrow).some(
        (l, i) => l.side !== Object.values(first)[i]?.side || l.setting !== "full",
      ),
    ).toBe(true);
  });

  it("are inside the bounds a fit shows, so a fit never cuts one off", async () => {
    const map = await fixtureMap();
    const graph = projectGraph(map);
    const layout = layoutGraph(graph);
    const labels = layoutLabels(graph, layout, null, { named: true });
    const b = boundsOf(graph, layout, labels);
    for (const l of Object.values(labels)) {
      const r = rectOf(l);
      expect(r.left).toBeGreaterThanOrEqual(b.left - 1e-9);
      expect(r.right).toBeLessThanOrEqual(b.right + 1e-9);
      expect(r.top).toBeGreaterThanOrEqual(b.top - 1e-9);
      expect(r.bottom).toBeLessThanOrEqual(b.bottom + 1e-9);
    }
  });
});
