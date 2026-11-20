import { describe, expect, it } from "vitest";
import type { Target } from "../src/events.ts";
import { KiroSessionResolver, type Resolver, StubPoller } from "../src/resolver.ts";
import { FakeKiroRemote } from "../src/testing/index.ts";

const RUNNING = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
const WAITING = "01KAHX8A1B2C3D4E5F6G7H8J9K";
const t = (id: string): Target => ({ type: "kiro-session", id });

function setup() {
  const fake = new FakeKiroRemote({
    sessions: [
      { id: RUNNING, title: "Fix the build", status: "running" },
      {
        id: WAITING,
        title: "Write the docs",
        status: "awaiting_permission",
        pendingPermissions: 2,
      },
    ],
  });
  const resolver = new KiroSessionResolver(fake.asTools());
  let now = 0;
  const known = new Map<string, Record<string, unknown>>();
  const written: { id: string; state: Record<string, unknown> }[] = [];
  const outcomes: string[] = [];
  const poller = new StubPoller(
    new Map<string, Resolver>([[resolver.type, resolver]]),
    (target) => known.get(target.id) ?? null,
    async (target, state) => {
      written.push({ id: target.id, state });
      known.set(target.id, state);
    },
    (o) => outcomes.push(o.outcome),
    { baseMs: 1000, maxMs: 8000, now: () => now },
  );
  return { fake, resolver, poller, known, written, outcomes, advance: (ms: number) => (now += ms) };
}

describe("the Kiro session resolver", () => {
  it("reads title, status and pending permissions", async () => {
    const { resolver } = setup();
    expect(await resolver.fetch(WAITING)).toMatchObject({
      title: "Write the docs",
      status: "awaiting_permission",
      pendingPermissions: 2,
    });
  });

  it("reports an unknown session as missing", async () => {
    const { resolver } = setup();
    expect(await resolver.fetch("01KAHXZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });

  it("throws when Kiro Remote can't tell", async () => {
    const { resolver, fake } = setup();
    fake.failNext = 1;
    await expect(resolver.fetch(RUNNING)).rejects.toThrow(/unavailable/);
  });
});

describe("the stub poller", () => {
  it("polls only stubs on screen", async () => {
    const { poller, fake, advance } = setup();
    poller.setVisible([t(RUNNING)]);
    await poller.runDue();
    advance(10_000);
    await poller.runDue();
    expect(
      fake.calls.filter((c) => c.tool === "kiro_get_session").map((c) => c.args.sessionId),
    ).toEqual([RUNNING, RUNNING]);
    poller.setVisible([]);
    advance(60_000);
    expect(await poller.runDue()).toEqual([]);
  });

  it("writes a status event only when something changed", async () => {
    const { poller, fake, written, advance } = setup();
    poller.setVisible([t(RUNNING)]);
    await poller.runDue();
    expect(written).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      advance(10_000);
      await poller.runDue();
    }
    expect(written).toHaveLength(1);
    fake.update(RUNNING, { status: "awaiting_permission", pendingPermissions: 1 });
    advance(10_000);
    await poller.runDue();
    expect(written).toHaveLength(2);
    expect(written[1]?.state).toMatchObject({
      status: "awaiting_permission",
      pendingPermissions: 1,
    });
  });

  it("backs off while nothing changes, up to the maximum, and resets on a change", async () => {
    const { poller, fake, advance, known } = setup();
    known.set(
      RUNNING,
      (await new KiroSessionResolver(fake.asTools()).fetch(RUNNING)) as Record<string, unknown>,
    );
    poller.setVisible([t(RUNNING)]);
    const intervals: number[] = [];
    for (let i = 0; i < 5; i++) {
      await poller.runDue();
      intervals.push(poller.intervalOf(t(RUNNING)) as number);
      advance(intervals.at(-1) as number);
    }
    expect(intervals).toEqual([2000, 4000, 8000, 8000, 8000]);
    // Not due yet: nothing is polled early.
    advance(-1);
    expect(await poller.runDue()).toEqual([]);
    advance(1);
    fake.update(RUNNING, { status: "idle" });
    await poller.runDue();
    expect(poller.intervalOf(t(RUNNING))).toBe(1000);
  });

  it("backs off on failures and counts them", async () => {
    const { poller, fake, advance, outcomes } = setup();
    poller.setVisible([t(RUNNING)]);
    fake.failNext = 2;
    await poller.runDue();
    advance(2000);
    await poller.runDue();
    expect(outcomes).toEqual(["failed", "failed"]);
    expect(poller.intervalOf(t(RUNNING))).toBe(4000);
    advance(4000);
    await poller.runDue();
    expect(outcomes.at(-1)).toBe("changed");
  });

  it("polls a stub at once when it comes back into view, with its backoff reset", async () => {
    const { poller, advance } = setup();
    poller.setVisible([t(RUNNING)]);
    await poller.runDue();
    advance(1000);
    await poller.runDue();
    poller.setVisible([]);
    advance(100);
    poller.setVisible([t(RUNNING)]);
    expect(poller.intervalOf(t(RUNNING))).toBe(1000);
    expect(await poller.runDue()).toHaveLength(1);
    // Staying in view keeps the schedule: a repeated setVisible does not poll again.
    poller.setVisible([t(RUNNING)]);
    expect(await poller.runDue()).toEqual([]);
  });
});
