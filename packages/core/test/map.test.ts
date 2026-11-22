import { describe, expect, it } from "vitest";
import { acceptanceSpec } from "../src/acceptance.ts";
import { adrAcceptance } from "../src/adr.ts";
import { MemoryLogStore } from "../src/log.ts";
import {
  BY_CLASS,
  foldMap,
  isMapRequest,
  type KindDecl,
  KindRegistry,
  type MapSnapshot,
  statesOfMachine,
} from "../src/map.ts";
import { mapOf, mapRegistry, pullRequestMapState } from "../src/map-kinds.ts";
import { emptyMapText, problemLines } from "../src/map-types.ts";
import { pullRequestAcceptance } from "../src/pull-request.ts";
import {
  appendMapFixture,
  mapFixtureTime as at,
  MAP_MAIN,
  MAP_PR_FAILING,
  MAP_PR_MERGED,
  MAP_PR_READY,
  MAP_SESSION,
  MAP_THREAD_CONCLUDING,
  MAP_THREAD_OPEN,
  MAP_THREAD_WITHDRAWN,
  pullRequestState,
} from "../src/testing/index.ts";
import { threadMachine } from "../src/thread.ts";

async function fixtureLog() {
  const log = new MemoryLogStore();
  await appendMapFixture(log);
  return log.events();
}

const row = (m: MapSnapshot, kind: string) => {
  const r = m.rows.find((x) => x.kind === kind);
  if (r === undefined) throw new Error(`no row ${kind}`);
  return r;
};
/** A row's counts by column, leaving out the empty ones. */
const counts = (m: MapSnapshot, kind: string) =>
  Object.fromEntries(
    row(m, kind)
      .cells.filter((c) => c.count > 0)
      .map((c) => [c.column, c.count]),
  );
const ids = (m: MapSnapshot, kind: string, column: string) =>
  row(m, kind)
    .cells.find((c) => c.column === column)
    ?.items.map((i) => i.id)
    .sort();

describe("the map of a recorded log", () => {
  it("counts threads by the thread machine's states", async () => {
    const m = mapOf(await fixtureLog());
    expect(row(m, "thread").columns.map((c) => c.id)).toEqual([
      "open",
      "concluding",
      "wrapped-up",
      "superseded",
      "withdrawn",
    ]);
    expect(counts(m, "thread")).toEqual({ open: 1, concluding: 1, withdrawn: 1 });
    expect(ids(m, "thread", "concluding")).toEqual([MAP_THREAD_CONCLUDING]);
    expect(ids(m, "thread", "open")).toEqual([MAP_THREAD_OPEN]);
    expect(ids(m, "thread", "withdrawn")).toEqual([MAP_THREAD_WITHDRAWN]);
    expect(row(m, "thread").source).toBe("machine");
  });

  it("counts steps: completed, failed, unfinished, settled", async () => {
    const m = mapOf(await fixtureLog());
    // Folding the past knows of no process: an unfinished step is still running.
    expect(counts(m, "step")).toEqual({ running: 1, failed: 1, completed: 2, settled: 1 });
    expect(row(m, "step").source).toBe("derived");
    expect(row(m, "step").derivation).toMatch(/step\.started/);
  });

  it("calls a step interrupted when it isn't running in this process", async () => {
    const records = await fixtureLog();
    const running = mapOf(records, { live: { runningSteps: new Set([`${MAP_MAIN}/s3@1`]) } });
    expect(counts(running, "step").running).toBe(1);
    const lost = mapOf(records, { live: { runningSteps: new Set() } });
    expect(counts(lost, "step")).toEqual({ interrupted: 1, failed: 1, completed: 2, settled: 1 });
  });

  it("counts interrupts by kind", async () => {
    const m = mapOf(await fixtureLog());
    // Two hosted requests (one cleared) and two local prompts (one answered by a step).
    expect(counts(m, "interrupt:permission")).toEqual({ open: 2, cleared: 1, settled: 1 });
    expect(counts(m, "interrupt:unasked-call")).toEqual({ open: 1 });
    expect(counts(m, "interrupt:acceptance")).toEqual({ open: 1, cleared: 1, settled: 1 });
    // A kind with nothing to show stays out of the map until it has an item.
    expect(m.rows.find((r) => r.kind === "interrupt:failed-check")).toBeUndefined();
  });

  it("counts acceptance requests by the acceptance machine's states", async () => {
    const m = mapOf(await fixtureLog());
    expect(row(m, "acceptance").columns.map((c) => c.id)).toEqual([
      "waiting",
      "requested",
      "changes-requested",
      "accepted",
      "rejected",
      "superseded",
      "withdrawn",
      "dismissed",
    ]);
    expect(counts(m, "acceptance")).toEqual({ waiting: 1, requested: 1, accepted: 1 });
    // A request opens at the stub of what it asks about.
    const item = row(m, "acceptance").cells.find((c) => c.column === "requested")?.items[0];
    expect(item?.open).toEqual({
      kind: "stub",
      target: `pull-request:${MAP_PR_READY}`,
      from: `${MAP_MAIN}/m1@1`,
      conversation: MAP_MAIN,
    });
  });

  it("gives every kind of record's acceptance the same states", () => {
    const a = statesOfMachine(acceptanceSpec(adrAcceptance)).map((s) => s.id);
    const p = statesOfMachine(acceptanceSpec(pullRequestAcceptance)).map((s) => s.id);
    expect(a).toEqual(p);
  });

  it("derives a Kiro session's state from the status the stub carries", async () => {
    const m = mapOf(await fixtureLog());
    expect(counts(m, "kiro-session")).toEqual({ awaiting_permission: 1 });
    const item = row(m, "kiro-session").cells.find((c) => c.count > 0)?.items[0];
    expect(item).toMatchObject({
      id: MAP_SESSION,
      label: "Fix the build",
      class: "waiting",
      waitsOn: "user",
      open: { kind: "stub", target: `kiro-session:${MAP_SESSION}`, conversation: MAP_MAIN },
    });
  });

  it("derives a pull request's state from what GitHub reported", async () => {
    const m = mapOf(await fixtureLog());
    expect(counts(m, "pull-request")).toEqual({ merged: 1, ready: 1, failing: 1 });
    expect(ids(m, "pull-request", "merged")).toEqual([MAP_PR_MERGED]);
    expect(ids(m, "pull-request", "ready")).toEqual([MAP_PR_READY]);
    expect(ids(m, "pull-request", "failing")).toEqual([MAP_PR_FAILING]);
  });

  it("says which state a pull request is in, by the first rule that applies", () => {
    const id = "o/r/pull/1";
    const of = (o: Record<string, unknown>) => pullRequestMapState(id, pullRequestState(1, o));
    expect(of({})).toBe("ready");
    expect(of({ draft: true })).toBe("draft");
    expect(of({ state: "closed" })).toBe("closed");
    expect(of({ mergeableState: "dirty", mergeable: false })).toBe("failing");
    expect(of({ review: { decision: "changes_requested", reviews: [], requested: [] } })).toBe(
      "changes-requested",
    );
    expect(of({ viewerReviewRequested: true, mergeableState: "blocked" })).toBe("review-requested");
    expect(
      of({
        checks: [{ name: "ci", status: "in_progress", conclusion: null, source: "check-run" }],
      }),
    ).toBe("checking");
    expect(of({ mergeableState: "blocked" })).toBe("open");
    // A snapshot too thin to judge is open, and nothing breaks.
    expect(pullRequestMapState(id, { state: "open" })).toBe("open");
  });

  it("highlights the cells that wait on the person", async () => {
    const m = mapOf(await fixtureLog());
    const waiting = m.rows.flatMap((r) =>
      r.cells
        .filter((c) => c.waitingOnPerson > 0)
        .map((c) => `${r.kind}/${c.column}:${c.waitingOnPerson}`),
    );
    expect(waiting.sort()).toEqual(
      [
        "acceptance/requested:1",
        "interrupt:acceptance/open:1",
        "interrupt:permission/open:2",
        "interrupt:unasked-call/open:1",
        "kiro-session/awaiting_permission:1",
        "pull-request/failing:1",
        "pull-request/ready:1",
        "step/failed:1",
        "thread/concluding:1",
      ].sort(),
    );
    expect(m.totals.waitingOnPerson).toBe(m.rows.reduce((n, r) => n + r.waitingOnPerson, 0));
  });

  it("carries the context on every item and transition", async () => {
    const m = mapOf(await fixtureLog());
    const items = m.rows.flatMap((r) => r.cells.flatMap((c) => c.items));
    expect(items.length).toBe(m.totals.items);
    expect(new Set(items.map((i) => i.context))).toEqual(new Set(["local"]));
    expect(new Set(m.transitions.map((t) => t.context))).toEqual(new Set(["local"]));
    expect(mapOf(await fixtureLog(), { context: "elsewhere" }).transitions[0]?.context).toBe(
      "elsewhere",
    );
  });
});

describe("transitions", () => {
  it("return the moves in a window, with their times", async () => {
    const m = mapOf(await fixtureLog(), { window: { since: at(19), until: at(21) } });
    const moves = m.transitions.map((t) => `${t.at} ${t.kind} ${t.from}>${t.to}`).sort();
    expect(moves).toEqual(
      [
        `${at(19)} pull-request ready>merged`,
        `${at(19, 30)} pull-request draft>failing`,
        `${at(20)} acceptance null>requested`,
        `${at(20)} interrupt:acceptance null>open`,
        `${at(20, 30)} acceptance null>requested`,
        `${at(20, 30)} interrupt:acceptance null>open`,
        `${at(21)} acceptance null>requested`,
        `${at(21)} interrupt:acceptance null>open`,
      ].sort(),
    );
  });

  it("know which column each end is in, and a coarser grouping merges them", async () => {
    const records = await fixtureLog();
    const fine = mapOf(records).transitions.find(
      (t) => t.kind === "kiro-session" && t.to === "awaiting_permission",
    );
    expect(fine).toMatchObject({
      from: "running",
      fromColumn: "running",
      toColumn: "awaiting_permission",
      at: at(18),
    });
    const coarse = mapOf(records, { grouping: BY_CLASS }).transitions.find(
      (t) => t.kind === "kiro-session" && t.to === "awaiting_permission",
    );
    expect(coarse).toMatchObject({ fromColumn: "active", toColumn: "waiting" });
  });

  it("follow an item through every state it was in", async () => {
    const m = mapOf(await fixtureLog());
    const path = m.transitions
      .filter((t) => t.kind === "acceptance" && t.item.endsWith("pull/3:3"))
      .map((t) => `${t.from}>${t.to}`);
    expect(path).toEqual(["null>requested", "requested>waiting"]);
  });

  it("are empty outside the window", async () => {
    const m = mapOf(await fixtureLog(), { window: { since: at(40) } });
    expect(m.transitions).toEqual([]);
    // The counts are the state at the position, whatever the window.
    expect(m.totals.items).toBe(mapOf(await fixtureLog()).totals.items);
  });
});

describe("a past position", () => {
  it("is the same fold stopped earlier", async () => {
    const records = await fixtureLog();
    const upTo = records.findIndex((r) => r.at === at(18)) + 1;
    expect(upTo).toBeGreaterThan(0);
    const then = mapOf(records, { position: upTo });
    expect(then.position).toBe(upTo);
    expect(then.at).toBe(at(18));
    expect(counts(then, "kiro-session")).toEqual({ awaiting_permission: 1 });
    expect(counts(then, "pull-request")).toEqual({ ready: 2, draft: 1 });
    // Nothing of what came later: no acceptance request yet, so its row is not there at all.
    expect(then.rows.some((r) => r.kind === "acceptance")).toBe(false);
    expect(counts(then, "thread")).toEqual({ open: 1, concluding: 1, withdrawn: 1 });
    const before = records.findIndex((r) => r.at === at(18));
    expect(counts(mapOf(records, { position: before }), "kiro-session")).toEqual({ running: 1 });
  });

  it("is empty at position zero and the whole log past the end", async () => {
    const records = await fixtureLog();
    const none = mapOf(records, { position: 0 });
    expect(none.totals.items).toBe(0);
    expect(none.at).toBeNull();
    expect(mapOf(records, { position: records.length + 50 })).toEqual(mapOf(records));
  });

  it("is a pure function of the records", async () => {
    const records = await fixtureLog();
    expect(JSON.stringify(mapOf(records))).toBe(JSON.stringify(mapOf([...records])));
  });
});

describe("the registry", () => {
  it("makes a kind a row by registering it, with no map code", async () => {
    const registry = new KindRegistry();
    const heard: KindDecl = {
      id: "notice",
      label: "Notices",
      source: "derived",
      derivation: "a notice is heard, then read when the next one comes",
      states: [
        { id: "heard", label: "Heard", class: "waiting", waitsOn: "user" },
        { id: "read", label: "Read", class: "terminal" },
      ],
      items: ({ events }) => {
        const notices = events.filter((e) => e.event.type === "notice.posted");
        return notices.map((n, i) => {
          const last = i === notices.length - 1;
          const path = [{ state: "heard", at: n.event.at, seq: n.seq }];
          const next = notices[i + 1];
          if (next !== undefined) path.push({ state: "read", at: next.event.at, seq: next.seq });
          return {
            id: n.event.id,
            label: last ? "latest" : "older",
            open: { kind: "conversation" as const, conversation: MAP_MAIN, anchor: null },
            path,
          };
        });
      },
    };
    registry.register(heard);
    const records = await fixtureLog();
    // The fixture has no notices: the kind shows nothing, because it didn't ask to be always shown.
    expect(foldMap(records, registry).rows).toEqual([]);

    const log = new MemoryLogStore();
    await appendMapFixture(log);
    await log.append(
      [1, 2, 3].map((n) => ({
        type: "notice.posted" as const,
        address: `${MAP_MAIN}/n${n}@1`,
        conversation: MAP_MAIN,
        actor: { kind: "system" as const, id: "draft", version: "0" },
        traceId: null,
        data: { what: "github-access", text: `note ${n}` },
        at: at(30 + n),
      })),
    );
    const m = foldMap(log.events(), registry);
    expect(m.rows.map((r) => r.kind)).toEqual(["notice"]);
    expect(m.rows[0]?.cells.map((c) => [c.column, c.count, c.waitingOnPerson])).toEqual([
      ["heard", 1, 1],
      ["read", 2, 0],
    ]);
    expect(m.transitions.map((t) => `${t.from}>${t.to}`).sort()).toEqual([
      "heard>read",
      "heard>read",
      "null>heard",
      "null>heard",
      "null>heard",
    ]);
    expect(m.rows[0]?.source).toBe("derived");
  });

  it("refuses a kind that can't be drawn", () => {
    const r = new KindRegistry();
    const base: KindDecl = {
      id: "x",
      label: "X",
      source: "derived",
      derivation: "",
      states: [{ id: "a", label: "A", class: "terminal" }],
      items: () => [],
    };
    expect(() => r.register({ ...base, states: [] })).toThrow(/no states/);
    expect(() =>
      r.register({ ...base, states: [{ id: "a", label: "A", class: "waiting" }, ...base.states] }),
    ).toThrow(/waits on no one/);
    expect(() =>
      r.register({ ...base, states: [{ id: "a", label: "A", class: "active" }] }),
    ).toThrow(/no terminal/);
    expect(() =>
      r.register({ ...base, states: [...base.states, { id: "a", label: "A", class: "terminal" }] }),
    ).toThrow(/twice/);
    r.register(base);
    expect(() => r.register(base)).toThrow(/already registered/);
  });

  it("keeps drawing when one kind fails", async () => {
    const registry = new KindRegistry();
    registry.register({
      id: "broken",
      label: "Broken",
      source: "derived",
      derivation: "",
      states: [{ id: "a", label: "A", class: "terminal" }],
      alwaysShown: true,
      items: () => {
        throw new Error("no luck");
      },
    });
    registry.register({
      id: "lost",
      label: "Lost",
      source: "derived",
      derivation: "",
      states: [{ id: "a", label: "A", class: "terminal" }],
      items: () => [
        {
          id: "i",
          label: "i",
          open: { kind: "conversation", conversation: MAP_MAIN, anchor: null },
          path: [{ state: "nowhere", at: at(0), seq: 0 }],
        },
      ],
    });
    registry.register(mapRegistry.get("thread") as KindDecl);
    const m = foldMap(await fixtureLog(), registry);
    expect(m.rows.map((r) => r.kind)).toEqual(["thread"]);
    expect(m.problems.map((p) => p.kind)).toEqual(["broken", "lost"]);
  });

  it("lists the kinds draft runs today, as rows in a fixed order", () => {
    expect(mapRegistry.list().map((k) => k.id)).toEqual([
      "thread",
      "step",
      "interrupt:permission",
      "interrupt:unasked-call",
      "interrupt:acceptance",
      "interrupt:failed-check",
      "interrupt:merge-conflict",
      "interrupt:changes-requested",
      "interrupt:review-requested",
      "acceptance",
      "kiro-session",
      "pull-request",
    ]);
    // Where a kind has a machine its states are the machine's.
    expect(mapRegistry.get("thread")?.states.map((s) => s.id)).toEqual(
      statesOfMachine(threadMachine().spec).map((s) => s.id),
    );
  });

  it("gives each kind a state that is waiting on someone or a terminal one it can end in", () => {
    for (const k of mapRegistry.list()) {
      expect(
        k.states.some((s) => s.class === "terminal"),
        k.id,
      ).toBe(true);
      for (const s of k.states)
        if (s.class === "waiting") expect(s.waitsOn, `${k.id}/${s.id}`).toBeDefined();
    }
  });
});

describe("the sentence that asks for the map", () => {
  it.each([
    "show the map",
    "Show me the map",
    "open the map.",
    "please show the map",
    "show me everything that's moving",
    "Show me everything that is moving!",
    "bring up the map please",
  ])("recognizes %s", (text) => expect(isMapRequest(text)).toBe(true));
  it.each([
    "draw a map of Finland",
    "show the map of the repository layout in a diagram",
    "the map is wrong",
    "",
  ])("leaves %s to the agent", (text) => expect(isMapRequest(text)).toBe(false));
});

describe("an empty map", () => {
  it("shows no row of zeros: a kind appears when it has an item", () => {
    const m = mapOf([]);
    expect(m.totals).toEqual({ items: 0, open: 0, waitingOnPerson: 0 });
    expect(m.rows.map((r) => r.kind)).toEqual([]);
    expect(m.totals.items).toBe(0);
    // Every kind is still known, so the empty state can name them.
    expect(m.kinds.map((k) => k.id)).toEqual(mapRegistry.list().map((k) => k.id));
  });

  it("shows a row of zeros only for a kind that says it always shows", () => {
    const registry = mapRegistry.fork();
    registry.register({
      id: "always",
      label: "Always",
      source: "derived",
      derivation: "a test kind",
      states: [{ id: "a", label: "A", class: "terminal" }],
      alwaysShown: true,
      items: () => [],
    });
    expect(foldMap([], registry).rows.map((r) => r.kind)).toEqual(["always"]);
  });

  it("shows the rows of the kinds that have items on a recorded log", async () => {
    const m = mapOf(await fixtureLog());
    expect(m.rows.map((r) => r.kind)).toEqual([
      "thread",
      "step",
      "interrupt:permission",
      "interrupt:unasked-call",
      "interrupt:acceptance",
      "acceptance",
      "kiro-session",
      "pull-request",
    ]);
    expect(m.rows.every((r) => r.total > 0)).toBe(true);
  });

  it("names every kind of the registry in its sentence, with a kind registered later", () => {
    const registry = mapRegistry.fork();
    registry.register({
      id: "widget",
      label: "Widgets",
      source: "derived",
      derivation: "a test kind",
      states: [{ id: "a", label: "A", class: "terminal" }],
      items: () => [],
    });
    const text = emptyMapText(foldMap([], registry).kinds);
    for (const name of [
      "Threads",
      "Steps",
      "Interrupts",
      "Acceptance requests",
      "Kiro sessions",
      "Pull requests",
      "Widgets",
    ])
      expect(text).toContain(name);
    expect(text).toContain("Pull requests and Widgets appear here");
    // Kinds that share a prefix are one name.
    expect(text.match(/Interrupts/g)).toHaveLength(1);
    expect(emptyMapText(mapRegistry.list())).not.toContain("Widgets");
  });

  it("says the same words once however many kinds report them", () => {
    expect(
      problemLines([
        { kind: "decision", message: "still reading a, b, c from GitHub" },
        { kind: "issue", message: "still reading a, b, c from GitHub" },
        { kind: "deployment:a:production", message: "a is slow" },
      ]),
    ).toEqual(["still reading a, b, c from GitHub", "a is slow"]);
  });
});
