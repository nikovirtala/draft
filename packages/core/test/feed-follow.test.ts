import { describe, expect, it } from "vitest";
import { classifyFeedEvent, type RawFeedPage } from "../src/feed.ts";
import { type Classified, type FeedSource, followPages } from "../src/feed-follow.ts";

/** A feed of numbered events served in pages, as GET /v1/events serves them. */
function source(events: unknown[]): FeedSource & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: "test",
    calls,
    async page(after, limit): Promise<RawFeedPage> {
      calls.push(after);
      const later = events.filter((e) => (e as { seq: number }).seq > after);
      const page = later.slice(0, limit);
      return {
        events: page,
        nextCursor: (page.at(-1) as { seq: number } | undefined)?.seq ?? after,
        hasMore: later.length > page.length,
      };
    },
  };
}

const ev = (seq: number, type = "wait.removed", payload: object = { reason: "merged" }) => ({
  v: 1,
  id: `id-${seq}`,
  seq,
  ts: "2026-11-24T08:00:00.000Z",
  type,
  effect: type.startsWith("wake.") ? "annotation" : "state",
  sessionId: "S1",
  pr: "octo/repo#7",
  source: "webhook",
  payload,
});

const classify = (raw: unknown): Classified<unknown> => {
  const c = classifyFeedEvent(raw);
  if (c.kind === "handle") return { kind: "handle", event: c.event, seq: c.event.seq };
  if (c.kind === "skip") return { kind: "skip", event: c.event, seq: c.event.seq };
  return { kind: "stop", seq: c.seq, type: c.type, reason: c.reason };
};

describe("following a feed from a cursor", () => {
  it("pages until the feed has no more, and says where it ended", async () => {
    const feed = source([1, 2, 3, 4, 5].map((n) => ev(n)));
    const r = await followPages(feed, classify, 0, { limit: 2 });
    expect(r.handled.map((h) => h.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.cursor).toBe(5);
    expect(r.end).toEqual({ kind: "caught-up" });
    expect(feed.calls).toEqual([0, 2, 4]);
  });

  it("reads only what is after the cursor", async () => {
    const feed = source([1, 2, 3].map((n) => ev(n)));
    const r = await followPages(feed, classify, 2);
    expect(r.handled.map((h) => h.seq)).toEqual([3]);
    expect(feed.calls).toEqual([2]);
  });

  it("with nothing new keeps the cursor it was given", async () => {
    const r = await followPages(source([ev(1)]), classify, 1);
    expect(r).toMatchObject({ handled: [], cursor: 1, end: { kind: "caught-up" } });
  });

  it("ignores an event it has read already", async () => {
    const page = { events: [ev(2), ev(3)], nextCursor: 3, hasMore: false };
    const r = await followPages({ id: "t", page: async () => page }, classify, 2);
    expect(r.handled.map((h) => h.seq)).toEqual([3]);
  });

  it("skips an annotation it doesn't know, and moves the cursor past it", async () => {
    const feed = source([
      ev(1),
      ev(2, "wake.future", { whatever: true }),
      ev(3, "wake.queued", {
        itemId: "i",
        kind: "pr_merged",
        cause: "linked_pr_event",
        merged: false,
      }),
    ]);
    const r = await followPages(feed, classify, 0);
    expect(r.handled.map((h) => h.seq)).toEqual([1, 3]);
    expect(r.skipped.map((s) => s.seq)).toEqual([2]);
    expect(r.cursor).toBe(3);
    expect(r.end).toEqual({ kind: "caught-up" });
  });

  it("stops at a state type it doesn't know, with the cursor before it", async () => {
    const feed = source([ev(1), ev(2, "wait.paused", { reason: "x" }), ev(3)]);
    const r = await followPages(feed, classify, 0);
    expect(r.handled.map((h) => h.seq)).toEqual([1]);
    expect(r.cursor).toBe(1);
    expect(r.end).toEqual({ kind: "stopped", type: "wait.paused", reason: "type", seq: 2 });
  });

  it("stops at a state event it can't read, whatever its type", async () => {
    const r = await followPages(source([ev(1, "wait.removed", { reason: 7 })]), classify, 0);
    expect(r.end).toMatchObject({
      kind: "stopped",
      type: "wait.removed",
      reason: "invalid",
      seq: 1,
    });
  });

  it("finds a gap: events after the cursor expired", async () => {
    const r = await followPages(source([ev(1), ev(2), ev(5), ev(6)]), classify, 0);
    expect(r.handled.map((h) => h.seq)).toEqual([1, 2]);
    expect(r.cursor).toBe(2);
    expect(r.end).toEqual({ kind: "gap", expected: 3, got: 5 });
  });

  it("finds a gap right after a stored cursor", async () => {
    const r = await followPages(source([ev(7), ev(8)]), classify, 4);
    expect(r.handled).toEqual([]);
    expect(r.end).toEqual({ kind: "gap", expected: 5, got: 7 });
  });

  it("starts wherever a feed starts when it is read for the first time", async () => {
    const r = await followPages(source([ev(40), ev(41), ev(42)]), classify, 0, { fromStart: true });
    expect(r.handled.map((h) => h.seq)).toEqual([40, 41, 42]);
    expect(r.cursor).toBe(42);
  });

  it("still finds a gap in the middle of a first read", async () => {
    const r = await followPages(source([ev(40), ev(41), ev(44)]), classify, 0, { fromStart: true });
    expect(r.end).toEqual({ kind: "gap", expected: 42, got: 44 });
  });

  it("reads a long backlog over several calls: the cursor says where it stopped", async () => {
    const feed = source(Array.from({ length: 10 }, (_, i) => ev(i + 1)));
    const first = await followPages(feed, classify, 0, { limit: 3, maxPages: 2 });
    expect(first.cursor).toBe(6);
    expect(first.end).toEqual({ kind: "more" });
    const next = await followPages(feed, classify, first.cursor, { limit: 3, maxPages: 2 });
    expect(next.handled.map((h) => h.seq)).toEqual([7, 8, 9, 10]);
    expect(next.end).toEqual({ kind: "caught-up" });
  });

  it("does not loop on a feed that says there is more and sends nothing", async () => {
    const feed: FeedSource = {
      id: "t",
      page: async (after) => ({ events: [], nextCursor: after, hasMore: true }),
    };
    expect((await followPages(feed, classify, 3)).cursor).toBe(3);
  });

  it("lets a failing read through to the caller", async () => {
    const feed: FeedSource = {
      id: "t",
      page: async () => {
        throw new Error("503");
      },
    };
    await expect(followPages(feed, classify, 0)).rejects.toThrow("503");
  });
});
