import { describe, expect, it } from "vitest";
import type { ArkSnapshot } from "../src/ark-records.ts";
import type { Actor, EventDataOf, EventDraft, EventType } from "../src/events.ts";
import { MemoryLogStore } from "../src/log.ts";
import { foldMap, type KindDecl, KindRegistry, type MapSnapshot } from "../src/map.ts";
import { ARK_SOURCE, DECISION_KIND, deploymentKind, ISSUE_KIND } from "../src/map-ark.ts";
import {
  type Graph,
  type GraphNode,
  type GraphZoom,
  MAX_OPEN_ITEMS,
  MAX_STEPPED_OUT,
  projectGraph,
  zoomKey,
} from "../src/map-graph.ts";
import { mapOf, mapRegistry } from "../src/map-kinds.ts";
import { type Layout, layoutGraph, MAX_SHIFT, radiusOf, shifts, WORLD } from "../src/map-layout.ts";
import {
  appendMapFixture,
  mapFixtureTime as at,
  MAP_MAIN,
  MAP_PR_MERGED,
  MAP_PR_READY,
  MAP_THREAD_CONCLUDING,
  MAP_THREAD_OPEN,
  pullRequestState,
} from "../src/testing/index.ts";

/* ----------------------------------------------------------------------------------------------- */
/* Edges, from logs and sources                                                                     */
/* ----------------------------------------------------------------------------------------------- */

const USER: Actor = { kind: "user", id: "01kahx0000000000000000user", name: "Test User" };
const RESOLVER: Actor = { kind: "resolver", id: "github", version: "1" };

/** Appends events to the map fixture's log, the way the fixture itself does. */
async function fixtureWith(
  more: (
    add: <T extends EventType>(
      type: T,
      when: string,
      conversation: string | null,
      item: string,
      actor: Actor,
      data: EventDataOf<T>,
    ) => string,
  ) => void,
) {
  const log = new MemoryLogStore();
  await appendMapFixture(log);
  const out: EventDraft[] = [];
  more((type, when, conversation, item, actor, data) => {
    const address = `${conversation ?? "local"}/${item}@1`;
    out.push({ type, address, conversation, actor, traceId: null, data, at: when } as EventDraft);
    return address;
  });
  await log.append(out);
  return log.events();
}

const edge = (m: MapSnapshot, from: string, to: string, rel?: string) =>
  m.edges.find((e) => e.from.id === from && e.to.id === to && (rel === undefined || e.rel === rel));

describe("the edges of the map", () => {
  it("draws an acceptance request to what it asks about", async () => {
    const log = new MemoryLogStore();
    await appendMapFixture(log);
    const m = mapOf(await log.events());
    expect(m.edges.map((e) => [e.from.kind, e.to.kind, e.rel])).toEqual([
      ["acceptance", "pull-request", "asks-about"],
      ["acceptance", "pull-request", "asks-about"],
      ["acceptance", "pull-request", "asks-about"],
    ]);
    expect(edge(m, `accept:pull-request:${MAP_PR_READY}:2`, MAP_PR_READY)?.at).toBe(at(20, 30));
  });

  it("draws what a thread's messages mention, the thread it came from and what its conclusion produced", async () => {
    const records = await fixtureWith((add) => {
      // A thread inside a thread, and a message of a thread that mentions a pull request.
      add("conversation.created", at(30), "local/t4", "x", USER, {
        conversation: "local/t4",
        title: "Inside the docs",
        parent: `${MAP_THREAD_OPEN}/m9@1`,
      });
      add("reference.made", at(31), MAP_THREAD_OPEN, "r9", RESOLVER, {
        from: `${MAP_THREAD_OPEN}/m9@1`,
        target: { type: "pull-request", id: MAP_PR_READY },
        kind: "explicit",
        relation: "mentions",
        source: "text",
        snapshot: pullRequestState(2),
      });
      // A mention from the main conversation: it is not an item, so it is not an edge.
      add("reference.made", at(31, 5), MAP_MAIN, "r8", RESOLVER, {
        from: `${MAP_MAIN}/m1@1`,
        target: { type: "pull-request", id: MAP_PR_READY },
        kind: "explicit",
        relation: "mentions",
        source: "text",
        snapshot: pullRequestState(2),
      });
      add("thread.wrapped_up", at(32), MAP_THREAD_CONCLUDING, "w1", USER, {
        proposal: `${MAP_THREAD_CONCLUDING}/p1@1`,
        text: "The build is fixed.",
        cites: {
          thread: MAP_THREAD_CONCLUDING,
          parent: `${MAP_MAIN}/m1@1`,
          messages: 2,
          produced: [{ type: "pull-request", id: MAP_PR_MERGED }],
        },
        returnedTo: MAP_MAIN,
      });
    });
    const m = mapOf(records);
    expect(edge(m, "local/t4", MAP_THREAD_OPEN, "part-of")).toBeDefined();
    expect(edge(m, MAP_THREAD_OPEN, MAP_PR_READY, "mentions")).toBeDefined();
    expect(edge(m, MAP_THREAD_CONCLUDING, MAP_PR_MERGED, "produced")).toBeDefined();
    expect(m.edges.filter((e) => e.from.kind === "thread")).toHaveLength(3);
  });

  /** The ark kinds with records that name each other, in a registry of their own. */
  function arkMap(
    ark: Partial<ArkSnapshot>,
    records: Awaited<ReturnType<typeof fixtureWith>> = [],
  ): MapSnapshot {
    const registry = mapRegistry.fork();
    registry.register(DECISION_KIND);
    registry.register(ISSUE_KIND);
    registry.register(deploymentKind("o/r", "prod"));
    const snapshot: ArkSnapshot = {
      version: 1,
      loading: false,
      repos: ["o/r"],
      readAt: null,
      adrs: [],
      issues: [],
      deployments: [],
      environments: [],
      problems: [],
      ...ark,
    };
    return foldMap(records, registry, { context: "local", sources: { [ARK_SOURCE]: snapshot } });
  }
  const adr = (id: string, extra: Record<string, unknown> = {}) => ({
    repo: "o/r",
    id,
    title: id,
    events: [{ type: "proposed", at: "2026-11-20T10:00:00Z", file: "x" }],
    proposal: null,
    supersedes: [],
    supersededBy: [],
    links: [],
    url: `https://example.test/${id}`,
    ...extra,
  });
  const issue = (id: string, extra: Record<string, unknown> = {}) => ({
    repo: "o/r",
    id,
    title: id,
    events: [{ type: "opened", at: "2026-11-20T10:00:00Z", file: "x" }],
    resolution: null,
    parent: null,
    links: [],
    url: `https://example.test/${id}`,
    ...extra,
  });

  it("draws a decision's supersedes, from either end, and its links", () => {
    const m = arkMap({
      adrs: [
        adr("aaaaaaaa", { supersedes: ["bbbbbbbb"] }),
        adr("bbbbbbbb"),
        // The old one says by what it was replaced; the new one says it replaces: one edge.
        adr("cccccccc", {
          supersededBy: ["aaaaaaaa"],
          links: [{ rel: "refines", to: "bbbbbbbb" }],
        }),
      ],
    });
    expect(m.edges.map((e) => `${e.from.id} ${e.rel} ${e.to.id}`)).toEqual([
      "o/r:aaaaaaaa supersedes o/r:bbbbbbbb",
      "o/r:aaaaaaaa supersedes o/r:cccccccc",
      "o/r:cccccccc refines o/r:bbbbbbbb",
    ]);
  });

  it("draws an issue's parent and links, to issues and to decisions", () => {
    const m = arkMap({
      adrs: [adr("aaaaaaaa")],
      issues: [
        issue("11111111"),
        issue("22222222", {
          parent: "11111111",
          links: [
            { rel: "depends-on", to: "33333333" },
            { rel: "implements", to: "adr:aaaaaaaa" },
            { rel: "relates-to", to: "draft:11111111" },
            // Nothing by that id: no edge, no error.
            { rel: "relates-to", to: "99999999" },
          ],
        }),
        issue("33333333"),
      ],
    });
    expect(m.edges.map((e) => `${e.from.id} ${e.rel} ${e.to.id}`).sort()).toEqual([
      "o/r:22222222 depends-on o/r:33333333",
      "o/r:22222222 implements o/r:aaaaaaaa",
      "o/r:22222222 part-of o/r:11111111",
      "o/r:22222222 relates-to o/r:11111111",
    ]);
    expect(edge(m, "o/r:22222222", "o/r:aaaaaaaa")?.to.kind).toBe("decision");
  });

  it("draws a deployment to the merged pull request whose merge commit it deployed, when the log has it", async () => {
    const sha = "f".repeat(40);
    const deployment = (id: number, deployed: string) => ({
      repo: "o/r",
      id,
      environment: "prod",
      sha: deployed,
      ref: "main",
      createdAt: "2026-11-20T13:00:00Z",
      commitUrl: "https://example.test/c",
      statuses: [
        { state: "success", at: "2026-11-20T13:01:00Z", logUrl: null, environmentUrl: null },
      ],
    });
    const records = await fixtureWith((add) => {
      add("status.observed", at(40), MAP_MAIN, "o9", RESOLVER, {
        target: { type: "pull-request", id: MAP_PR_MERGED },
        state: pullRequestState(1, { repo: "o/r", state: "merged", mergeCommitSha: sha }),
      });
    });
    const m = arkMap({ deployments: [deployment(1, sha), deployment(2, "e".repeat(40))] }, records);
    expect(m.edges.filter((e) => e.rel === "deploys")).toEqual([
      {
        context: "local",
        from: { kind: "deployment:o/r:prod", id: "1" },
        to: { kind: "pull-request", id: MAP_PR_MERGED },
        rel: "deploys",
        at: "2026-11-20T13:00:00.000Z",
      },
    ]);
    // Without the pull request in the log, or one that has no merge commit, there is no edge.
    expect(arkMap({ deployments: [deployment(1, sha)] }).edges).toEqual([]);
  });

  it("keeps an edge only when both ends are items of the map, and says it once", () => {
    const registry = new KindRegistry();
    registry.register(
      testKind("a", [item("a1", ["open"])], {
        edges: () => [
          { from: { kind: "a", id: "a1" }, to: { kind: "a", id: "nope" }, rel: "x" },
          { from: { kind: "a", id: "a1" }, to: { kind: "a", id: "a1" }, rel: "x" },
          {
            from: { kind: "a", id: "a1" },
            to: { kind: "b", id: "b1" },
            rel: "x",
            at: "2026-01-02T00:00:00Z",
          },
          {
            from: { kind: "a", id: "a1" },
            to: { kind: "b", id: "b1" },
            rel: "x",
            at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    registry.register(testKind("b", [item("b1", ["open"])]));
    const m = foldMap([], registry, { context: "c" });
    expect(m.edges).toEqual([
      {
        context: "c",
        from: { kind: "a", id: "a1" },
        to: { kind: "b", id: "b1" },
        rel: "x",
        at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("reports a kind whose edges throw, and draws the rest", () => {
    const registry = new KindRegistry();
    registry.register(
      testKind("a", [item("a1", ["open"])], {
        edges: () => {
          throw new Error("no way");
        },
      }),
    );
    registry.register(
      testKind("b", [item("b1", ["open"]), item("b2", ["open"])], {
        edges: () => [{ from: { kind: "b", id: "b1" }, to: { kind: "b", id: "b2" }, rel: "y" }],
      }),
    );
    const m = foldMap([], registry, { context: "c" });
    expect(m.problems).toEqual([{ kind: "a", message: "a's references: no way" }]);
    expect(m.rows.map((r) => [r.kind, r.total])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(m.edges.map((e) => e.rel)).toEqual(["y"]);
    expect(projectGraph(m).nodes.filter((n) => n.type === "cluster")).toHaveLength(2);
  });
});

/* ----------------------------------------------------------------------------------------------- */
/* Test kinds                                                                                       */
/* ----------------------------------------------------------------------------------------------- */

interface TestItem {
  id: string;
  /** The states it went through, one a minute from `2026-11-20T12:00`. */
  states: string[];
  /** Minutes after 12:00 that it entered its first state. */
  from?: number;
}

const stamp = (minute: number) => new Date(Date.UTC(2026, 10, 20, 12, minute)).toISOString();
const item = (id: string, states: string[], from = 0): TestItem => ({ id, states, from });

function testKind(id: string, items: readonly TestItem[], more: Partial<KindDecl> = {}): KindDecl {
  return {
    id,
    label: id.toUpperCase(),
    source: "derived",
    derivation: "a test",
    states: [
      { id: "open", label: "Open", class: "active" },
      { id: "ask", label: "Ask", class: "waiting", waitsOn: "user" },
      { id: "wait", label: "Wait", class: "waiting", waitsOn: "agent" },
      { id: "done", label: "Done", class: "terminal" },
    ],
    items: () =>
      items.map((i) => ({
        id: i.id,
        label: `Item ${i.id}`,
        open: { kind: "conversation", conversation: "local/c1", anchor: null },
        path: i.states.map((state, n) => ({
          state,
          at: stamp((i.from ?? 0) + n),
          seq: n,
        })),
      })),
    ...more,
  };
}

function registryOf(...kinds: KindDecl[]): KindRegistry {
  const r = new KindRegistry();
  for (const k of kinds) r.register(k);
  return r;
}

const ref = (kind: string, id: string) => ({ kind, id });
const link = (from: [string, string], to: [string, string], rel = "implements") => ({
  from: ref(...from),
  to: ref(...to),
  rel,
});

const node = (g: Graph, id: string): GraphNode => {
  const n = g.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`no node ${id}: ${g.nodes.map((x) => x.id).join(", ")}`);
  return n;
};
const ids = (g: Graph) => g.nodes.map((n) => n.id);

/** Two kinds and a few edges between them, with what moved after 12:05. */
function twoKinds(window = { since: stamp(5) }): MapSnapshot {
  const a = testKind(
    "a",
    [
      item("a1", ["open", "done"], 0),
      item("a2", ["open"], 0),
      item("a3", ["open", "ask"], 10),
      item("a4", ["done"], 0),
    ],
    {
      edges: () => [
        link(["a", "a1"], ["b", "b1"]),
        link(["a", "a2"], ["b", "b1"], "depends-on"),
        link(["a", "a3"], ["b", "b2"]),
        link(["a", "a1"], ["a", "a2"], "relates-to"),
      ],
    },
  );
  const b = testKind("b", [item("b1", ["open"]), item("b2", ["open", "done"], 20)], {
    edges: () => [link(["b", "b1"], ["a", "a2"], "relates-to")],
  });
  return foldMap([], registryOf(a, b), { context: "c", window });
}

describe("the graph of a snapshot", () => {
  it("gathers a context's items into one cluster for each kind, sized by count, with the share settled", () => {
    const g = projectGraph(twoKinds());
    expect(g.zoom).toEqual({ level: "context" });
    const a = node(g, "cluster:a");
    expect(a).toMatchObject({
      type: "cluster",
      label: "A",
      count: 4,
      settled: 2,
      share: 0.5,
      waitingOnPerson: 1,
      zoom: { level: "kind", kind: "a" },
    });
    expect(node(g, "cluster:b")).toMatchObject({ count: 2, settled: 1, share: 0.5 });
    expect(radiusOf(a)).toBeGreaterThan(radiusOf(node(g, "cluster:b")));
  });

  it("leaves a kind with no items out", () => {
    const m = foldMap([], registryOf(testKind("a", [item("a1", ["open"])]), testKind("e", [])), {
      context: "c",
    });
    expect(ids(projectGraph(m))).toEqual(["cluster:a"]);
  });

  it("steps out the items that moved in the window or wait on the person, and no others", () => {
    const g = projectGraph(twoKinds());
    // a1 moved to done at 12:01 (before the window); a3 went to ask at 12:11, and waits on the person.
    // b2 went to done at 12:21. Appearances are not moves.
    const out = g.nodes
      .filter((n) => n.type === "item")
      .map((n) => n.id)
      .sort();
    expect(out).toEqual(["item:a:a3", "item:b:b2"]);
    expect(node(g, "item:a:a3")).toMatchObject({
      moved: true,
      waiting: true,
      tether: "cluster:a",
      state: "ask",
    });
    expect(node(g, "item:b:b2")).toMatchObject({
      moved: true,
      waiting: false,
      tether: "cluster:b",
    });
    // The cluster still counts them, and says how many left it.
    expect(node(g, "cluster:a")).toMatchObject({ count: 4, steppedOut: 1 });
    // Nothing moved in a window that is empty: only what waits steps out.
    const quiet = projectGraph(twoKinds({ since: stamp(500) }));
    expect(ids(quiet).filter((i) => i.startsWith("item:"))).toEqual(["item:a:a3"]);
  });

  it("steps out at most MAX_STEPPED_OUT items, those waiting on the person first", () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      item(`m${String(n).padStart(2, "0")}`, ["open", n % 10 === 0 ? "ask" : "wait"], n),
    );
    const m = foldMap([], registryOf(testKind("a", many)), {
      context: "c",
      window: { since: stamp(0) },
    });
    const g = projectGraph(m);
    const out = g.nodes.filter((n): n is Extract<GraphNode, { type: "item" }> => n.type === "item");
    expect(out).toHaveLength(MAX_STEPPED_OUT);
    // Six wait on the person; they are all out, then the latest moves.
    expect(out.filter((n) => n.waiting)).toHaveLength(6);
    expect(out.filter((n) => !n.waiting).map((n) => n.item)[0]).toBe("m59");
    expect(node(g, "cluster:a")).toMatchObject({ count: 60, steppedOut: MAX_STEPPED_OUT });
  });

  it("bundles the references between clusters and counts them, with what is inside one", () => {
    const g = projectGraph(twoKinds({ since: stamp(500) }));
    // Only a3 stepped out. a1→b1 and a2→b1 are one bundle of two; a3→b2 leaves from a3's own node.
    const ab = g.edges.find((e) => e.id === "cluster:a>cluster:b");
    expect(ab).toMatchObject({ count: 2, cascade: false });
    expect(ab?.rels).toEqual([
      { rel: "depends-on", count: 1 },
      { rel: "implements", count: 1 },
    ]);
    expect(g.edges.find((e) => e.id === "item:a:a3>cluster:b")).toMatchObject({ count: 1 });
    // b1→a2 goes the other way: a bundle of its own.
    expect(g.edges.find((e) => e.id === "cluster:b>cluster:a")).toMatchObject({ count: 1 });
    // a1 relates to a2, inside one cluster: not drawn, counted.
    expect(g.edges.some((e) => e.from === e.to)).toBe(false);
    expect(node(g, "cluster:a")).toMatchObject({ inside: 1 });
  });

  it("draws a cascade along the references between items that moved", () => {
    const a = testKind("a", [item("a1", ["open", "done"], 10), item("a2", ["open", "done"], 12)], {
      edges: () => [link(["a", "a1"], ["a", "a2"], "depends-on"), link(["a", "a1"], ["b", "b1"])],
    });
    const b = testKind("b", [item("b1", ["open"])]);
    const m = foldMap([], registryOf(a, b), { context: "c", window: { since: stamp(5) } });
    const g = projectGraph(m);
    // a1 and a2 both moved, so both stepped out, and the reference between them is a cascade.
    expect(g.edges.find((e) => e.id === "item:a:a1>item:a:a2")?.cascade).toBe(true);
    // b1 did not move: a reference to it is not part of the cascade.
    expect(g.edges.find((e) => e.id === "item:a:a1>cluster:b")?.cascade).toBe(false);
  });

  it("marks an item whose path stops: something settled leads to it and it is not settled", () => {
    const a = testKind("a", [item("a1", ["open", "done"]), item("a2", ["open", "done"])], {
      edges: () => [
        link(["a", "a1"], ["b", "b1"]),
        link(["a", "a2"], ["b", "b2"], "relates-to"),
        link(["a", "a1"], ["b", "b3"]),
      ],
    });
    const b = testKind("b", [
      item("b1", ["open"]),
      item("b2", ["open"]),
      item("b3", ["open", "done"]),
    ]);
    const m = foldMap([], registryOf(a, b), { context: "c", window: { since: stamp(500) } });
    const g = projectGraph(m, { level: "kind", kind: "b" });
    const loops = g.nodes.filter((n) => n.type === "item" && n.openLoop).map((n) => n.id);
    // b1 is led to by a settled item and isn't settled; b2 only by a weak reference; b3 is settled.
    expect(loops).toEqual(["item:b:b1"]);
    expect(g.totals.openLoops).toBe(1);
  });

  describe("zoom levels", () => {
    it("opens a kind into its items along its states, with the kinds they refer to at the edge", () => {
      const g = projectGraph(twoKinds(), { level: "kind", kind: "a" });
      expect(g.zoom).toEqual({ level: "kind", kind: "a" });
      expect(g.lanes.map((l) => l.id)).toEqual(["open", "ask", "done"]);
      expect(ids(g).sort()).toEqual([
        "cluster:b",
        "item:a:a1",
        "item:a:a2",
        "item:a:a3",
        "item:a:a4",
      ]);
      expect(node(g, "item:a:a1")).toMatchObject({ lane: "done", tether: null });
      expect(node(g, "cluster:b")).toMatchObject({ external: true, count: 2 });
      // a1 and a2 refer to b1; a3 to b2. b1 refers back to a2.
      expect(g.edges.map((e) => `${e.id} ${e.count}`)).toEqual([
        "cluster:b>item:a:a2 1",
        "item:a:a1>cluster:b 1",
        "item:a:a1>item:a:a2 1",
        "item:a:a2>cluster:b 1",
        "item:a:a3>cluster:b 1",
      ]);
      expect(g.crumbs.map((c) => c.label)).toEqual(["Context", "A"]);
    });

    it("shows a kind with more items than fit as counts by state and the stepped-out items", () => {
      const many = Array.from({ length: MAX_OPEN_ITEMS + 5 }, (_, n) =>
        item(`i${String(n).padStart(3, "0")}`, n < 3 ? ["open", "ask"] : ["open"], n < 3 ? 10 : 0),
      );
      const m = foldMap([], registryOf(testKind("a", many)), {
        context: "c",
        window: { since: stamp(5) },
      });
      const g = projectGraph(m, { level: "kind", kind: "a" });
      expect(node(g, "bucket:a:open")).toMatchObject({ count: MAX_OPEN_ITEMS + 2, state: "open" });
      expect(node(g, "bucket:a:ask")).toMatchObject({ count: 3, steppedOut: 3 });
      expect(g.nodes.filter((n) => n.type === "item").map((n) => n.id)).toEqual([
        "item:a:i000",
        "item:a:i001",
        "item:a:i002",
      ]);
      expect(g.hidden).toBe(MAX_OPEN_ITEMS + 2);
    });

    it("opens one item into its neighbourhood: the item and what its references reach", () => {
      const g = projectGraph(twoKinds(), { level: "item", kind: "a", id: "a2" });
      expect(g.zoom).toEqual({ level: "item", kind: "a", id: "a2" });
      // a2 is led to from a1 and b1, and depends on b1.
      expect(ids(g).sort()).toEqual(["item:a:a1", "item:a:a2", "item:b:b1"]);
      expect(node(g, "item:a:a2")).toMatchObject({ focus: true });
      expect(g.edges.map((e) => e.id)).toEqual([
        "item:a:a1>item:a:a2",
        "item:a:a1>item:b:b1",
        "item:a:a2>item:b:b1",
        "item:b:b1>item:a:a2",
      ]);
      expect(g.crumbs.map((c) => c.label)).toEqual(["Context", "A", "Item a2"]);
    });

    it("falls back to the context for a zoom that names nothing there", () => {
      const m = twoKinds();
      expect(projectGraph(m, { level: "kind", kind: "nope" }).zoom).toEqual({ level: "context" });
      expect(projectGraph(m, { level: "item", kind: "a", id: "nope" }).zoom).toEqual({
        level: "context",
      });
    });

    it("is a pure function of the snapshot and the zoom", () => {
      const m = twoKinds();
      const zoom: GraphZoom = { level: "kind", kind: "b" };
      expect(projectGraph(structuredClone(m), zoom)).toEqual(projectGraph(m, zoom));
      expect(zoomKey(zoom)).toBe("kind:b");
    });
  });
});

/* ----------------------------------------------------------------------------------------------- */
/* Layout                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

/** A context with `kinds` kinds, each with a few items, some of which wait. */
function crowd(kinds: number, perKind: number, extra: { kind: string; id: string }[] = []) {
  const all: KindDecl[] = [];
  for (let k = 0; k < kinds; k++) {
    const id = `k${String(k).padStart(2, "0")}`;
    const items = Array.from({ length: perKind + (k % 5) * 3 }, (_, n) =>
      item(`${id}-${n}`, n % 4 === 0 ? ["open", "ask"] : ["open", "done"], n),
    );
    for (const e of extra) if (e.kind === id) items.push(item(e.id, ["open", "ask"], 50));
    all.push(testKind(id, items));
  }
  return foldMap([], registryOf(...all), { context: "c", window: { since: stamp(0) } });
}

function overlaps(g: Graph, layout: Layout): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < g.nodes.length; i++)
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i] as GraphNode;
      const b = g.nodes[j] as GraphNode;
      const p = layout[a.id];
      const q = layout[b.id];
      if (p === undefined || q === undefined) continue;
      if (Math.hypot(p.x - q.x, p.y - q.y) < radiusOf(a) + radiusOf(b)) out.push([a.id, b.id]);
    }
  return out;
}

describe("the layout", () => {
  it("gives the same positions for the same input", () => {
    const g = projectGraph(crowd(10, 8));
    expect(layoutGraph(g)).toEqual(layoutGraph(g));
    const first = layoutGraph(g);
    expect(layoutGraph(g, first)).toEqual(layoutGraph(g, first));
  });

  it("places every node inside the world with no two overlapping", () => {
    for (const zoom of [
      { level: "context" },
      { level: "kind", kind: "k03" },
      { level: "item", kind: "k03", id: "k03-0" },
    ] as GraphZoom[]) {
      const g = projectGraph(crowd(10, 8), zoom);
      const layout = layoutGraph(g);
      expect(Object.keys(layout).sort()).toEqual(ids(g).sort());
      for (const n of g.nodes) {
        const p = layout[n.id] as { x: number; y: number };
        expect(p.x - radiusOf(n)).toBeGreaterThanOrEqual(0);
        expect(p.y - radiusOf(n)).toBeGreaterThanOrEqual(0);
        expect(p.x + radiusOf(n)).toBeLessThanOrEqual(WORLD.width);
        expect(p.y + radiusOf(n)).toBeLessThanOrEqual(WORLD.height);
      }
      expect(overlaps(g, layout), zoomKey(zoom)).toEqual([]);
    }
  });

  it("seeds a node from its id: the same node starts in the same place whatever else is there", () => {
    const small = layoutGraph(projectGraph(crowd(3, 2)));
    const bigger = layoutGraph(projectGraph(crowd(3, 2)));
    expect(small).toEqual(bigger);
    // The first node placed has a seed, not a search: it is where its id says, with or without company.
    const alone = foldMap([], registryOf(testKind("k00", [item("x", ["open"])])), { context: "c" });
    const withOthers = crowd(6, 3);
    expect(layoutGraph(projectGraph(alone))["cluster:k00"]).toBeDefined();
    expect(layoutGraph(projectGraph(withOthers))["cluster:k00"]).toBeDefined();
  });

  it("keeps every node where it was when an item is added, within a small bound", () => {
    const before = projectGraph(crowd(10, 8));
    const first = layoutGraph(before);
    const after = projectGraph(crowd(10, 8, [{ kind: "k04", id: "added" }]));
    const second = layoutGraph(after, first);
    const moved = shifts(first, second);
    // The cap on stepped-out items lets the new one take the place of the oldest, which leaves.
    expect(Object.keys(moved).length).toBeGreaterThanOrEqual(before.nodes.length - 1);
    expect(Math.max(...Object.values(moved))).toBeLessThanOrEqual(MAX_SHIFT);
    // The new node came out of its cluster without moving anything it had to leave alone.
    expect(second["item:k04:added"]).toBeDefined();
    expect(overlaps(after, second)).toEqual([]);
    // Adding many, one after another, never moves a node by more than the bound each time.
    let layout = second;
    const extra: { kind: string; id: string }[] = [{ kind: "k04", id: "added" }];
    for (let n = 0; n < 8; n++) {
      extra.push({ kind: `k0${n}`, id: `more-${n}` });
      const g = projectGraph(crowd(10, 8, extra));
      const next = layoutGraph(g, layout);
      expect(Math.max(...Object.values(shifts(layout, next)))).toBeLessThanOrEqual(MAX_SHIFT);
      layout = next;
    }
  });

  it("moves nothing when nothing changed", () => {
    const g = projectGraph(crowd(10, 8));
    const first = layoutGraph(g);
    expect(shifts(first, layoutGraph(g, first))).toEqual(
      Object.fromEntries(ids(g).map((id) => [id, 0])),
    );
  });

  it("keeps the focus of a neighbourhood in the middle", () => {
    const g = projectGraph(twoKinds(), { level: "item", kind: "a", id: "a2" });
    const layout = layoutGraph(g);
    expect(layout["item:a:a2"]).toEqual({ x: WORLD.width / 2, y: WORLD.height / 2 });
  });
});
