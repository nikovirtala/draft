import { describe, expect, it } from "vitest";
import type { DraftEvent } from "../src/events.ts";
import { FEED_TYPE_NAMES, KIRO_FEED } from "../src/feed.ts";
import { feedStale, foldKiroFeed, lastWake, sessionFeedView, wakesOf } from "../src/kiro-feed.ts";
import { wakeText } from "../src/kiro-feed-types.ts";

/** The facts the reader writes, as the fold reads them. Only type, data and time matter to it. */
type Fact = { type: string; data: Record<string, unknown>; at?: string };
const fold = (facts: Fact[]) =>
  foldKiroFeed(
    facts.map((f, seq) => ({
      event: { ...f, at: f.at ?? "2026-11-24T08:00:00.000Z" } as unknown as DraftEvent,
      seq,
    })),
  );

let n = 0;
const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  o: { session?: string; pr?: string | null; effect?: string; source?: string; v?: number } = {},
): Fact => ({
  type: "feed.event",
  data: {
    feed: KIRO_FEED,
    event: {
      v: o.v ?? 1,
      id: `e${++n}`,
      seq,
      ts: `2026-11-24T08:00:${String(seq).padStart(2, "0")}.000Z`,
      type,
      effect: o.effect ?? (type.startsWith("wake.") ? "annotation" : "state"),
      sessionId: o.session ?? "S1",
      pr: o.pr === undefined ? "octo/repo#7" : o.pr,
      source: o.source ?? "webhook",
      payload,
    },
  },
});

const baseline = (
  cursor: number,
  o: {
    session?: string;
    links?: { pr: string; method: string; prState: string }[];
    waits?: { pr: string; source: string; since: string }[];
  } = {},
): Fact => ({
  type: "feed.baseline",
  data: {
    feed: KIRO_FEED,
    cursor,
    session: o.session ?? "S1",
    links: o.links ?? [],
    waits: o.waits ?? [],
  },
});

const wake = (item: string, kind = "pr_wait_merged", cause = "wait") => ({
  itemId: item,
  kind,
  cause,
});

describe("the fold of the change feed", () => {
  it("is empty before anything was read", () => {
    const f = fold([]);
    expect(f).toMatchObject({ cursor: 0, started: false, stopped: null, restarts: 0 });
    expect(f.sessions.size).toBe(0);
    expect(feedStale(f)).toBeNull();
  });

  it("starts from what the service said and follows the feed after the baseline's cursor", () => {
    const f = fold([
      baseline(0, {
        links: [{ pr: "octo/repo#1", method: "harvest", prState: "open" }],
        waits: [{ pr: "octo/repo#5", source: "mcp", since: "2026-11-23T10:00:00Z" }],
      }),
      event(1, "wait.registered", { waitSource: "rest" }),
      event(2, "wait.removed", { reason: "stopped" }, { pr: "octo/repo#5" }),
      event(3, "link.state_changed", { from: "open", to: "merged" }, { pr: "octo/repo#1" }),
    ]);
    const s = f.sessions.get("S1");
    expect(s?.waits.map((w) => [w.pr, w.source])).toEqual([["octo/repo#7", "rest"]]);
    expect(s?.links).toEqual([{ pr: "octo/repo#1", method: "harvest", prState: "merged" }]);
    expect(s?.baseline).toBe(0);
    expect(f.cursor).toBe(3);
    expect(f.started).toBe(true);
  });

  it("does not apply what the baseline already reflects, and doesn't mind when it replays it", () => {
    // Registered (1) and removed (2) before the baseline; the service says: waiting for #9 only.
    const f = fold([
      event(1, "wait.registered", { waitSource: "mcp" }),
      event(2, "wait.removed", { reason: "stopped" }),
      event(3, "wait.registered", { waitSource: "mcp" }, { pr: "octo/repo#9" }),
      baseline(3, { waits: [{ pr: "octo/repo#9", source: "mcp", since: "" }] }),
      // The event landed between the cursor and the answer: applying it twice changes nothing.
      event(4, "wait.registered", { waitSource: "mcp" }, { pr: "octo/repo#9" }),
    ]);
    expect(f.sessions.get("S1")?.waits.map((w) => w.pr)).toEqual(["octo/repo#9"]);
  });

  it("handles every state type of the contract", () => {
    const f = fold([
      baseline(0),
      event(1, "link.added", { method: "trailer", prState: "open" }, { pr: "octo/repo#2" }),
      event(2, "link.added", { method: "manual", prState: "open" }, { pr: "octo/repo#3" }),
      event(3, "link.state_changed", { from: "open", to: "closed" }, { pr: "octo/repo#2" }),
      event(4, "link.removed", { reason: "unlinked" }, { pr: "octo/repo#3" }),
      event(5, "wait.registered", { waitSource: "trailer" }),
      event(6, "wait.registered", { waitSource: "mcp" }, { pr: "octo/repo#8" }),
      event(7, "wait.removed", { reason: "merged" }),
    ]);
    const s = f.sessions.get("S1");
    expect(s?.links).toEqual([{ pr: "octo/repo#2", method: "trailer", prState: "closed" }]);
    expect(s?.waits.map((w) => w.pr)).toEqual(["octo/repo#8"]);
    expect(s?.ended).toMatchObject([{ pr: "octo/repo#7", reason: "merged", fresh: true }]);
  });

  it("keeps the state of a session it has no baseline for unknown, and its wakes", () => {
    const f = fold([
      event(1, "wait.registered", { waitSource: "mcp" }, { session: "S2" }),
      event(2, "wake.queued", { ...wake("w1"), merged: false }, { session: "S2" }),
    ]);
    const s = f.sessions.get("S2");
    expect(s?.baseline).toBeNull();
    expect(s?.waits).toEqual([]);
    expect(s?.wakes).toHaveLength(1);
  });

  describe("wakes", () => {
    const wakes = [
      baseline(0),
      event(
        1,
        "wake.queued",
        { ...wake("w1", "pr_merged", "linked_pr_event"), merged: false },
        { pr: "octo/repo#1" },
      ),
      event(
        2,
        "wake.queued",
        { ...wake("w2", "pr_conflict", "conflict"), merged: true },
        { pr: "octo/repo#2" },
      ),
      event(
        3,
        "wake.delivered",
        { ...wake("w1", "pr_merged", "linked_pr_event"), turnId: "t1" },
        { pr: "octo/repo#1" },
      ),
      event(
        4,
        "wake.dropped",
        { ...wake("w2", "pr_conflict", "conflict"), reason: "deleted" },
        { pr: "octo/repo#2" },
      ),
    ];

    it("follows each wake from queued to delivered or dropped, with its cause", () => {
      const f = fold(wakes);
      const w = wakesOf(f, "S1");
      expect(w.map((x) => [x.itemId, x.cause, x.kind, x.state, x.pr])).toEqual([
        ["w1", "linked_pr_event", "pr_merged", "delivered", "octo/repo#1"],
        ["w2", "conflict", "pr_conflict", "dropped", "octo/repo#2"],
      ]);
      expect(w[0]).toMatchObject({ turnId: "t1", merged: false, source: "webhook" });
      expect(w[1]).toMatchObject({ droppedReason: "deleted", merged: true });
    });

    it("says a session last woke for the wake delivered last", () => {
      const f = fold([
        ...wakes,
        event(5, "wake.queued", { ...wake("w3"), merged: false }, { pr: "octo/repo#9" }),
        event(6, "wake.delivered", { ...wake("w3"), turnId: "t3" }, { pr: "octo/repo#9" }),
      ]);
      expect(lastWake(f.sessions.get("S1"))).toMatchObject({
        itemId: "w3",
        cause: "wait",
        pr: "octo/repo#9",
      });
      expect(sessionFeedView(f, "S1")?.lastWake?.text).toBe(
        "a pull request it waited for octo/repo#9 merged",
      );
    });

    it("has no last wake for one that is queued, released or dropped", () => {
      const f = fold([
        baseline(0),
        event(1, "wake.queued", { ...wake("w1"), merged: false }),
        event(2, "wake.delivered", { ...wake("w1"), turnId: "t1" }),
        event(3, "wake.released", { ...wake("w1"), turnId: "t1" }),
      ]);
      expect(wakesOf(f, "S1")[0]?.state).toBe("queued");
      expect(lastWake(f.sessions.get("S1"))).toBeNull();
    });

    it("keeps wakes queryable by cause, for a count of the wakes a person did by hand", () => {
      const f = fold(wakes);
      const byCause = Object.groupBy(wakesOf(f, "S1"), (w) => w.cause);
      expect(Object.keys(byCause).sort()).toEqual(["conflict", "linked_pr_event"]);
    });

    it("words each cause", () => {
      expect(wakeText("conflict", "pr_conflict", "octo/repo#2")).toBe(
        "its pull request octo/repo#2 no longer merges",
      );
      expect(wakeText("linked_pr_event", "pr_merged", "octo/repo#1")).toBe(
        "its pull request octo/repo#1 merged",
      );
      expect(wakeText("wait", "something_new", null)).toBe(
        "a pull request it waited for something new",
      );
    });
  });

  describe("a wait that ended", () => {
    const ended = (reason: string, seq = 2) => [
      baseline(0, { waits: [{ pr: "octo/repo#7", source: "mcp", since: "" }] }),
      event(seq, "wait.removed", { reason }),
    ];

    it.each(["merged", "closed", "unreadable", "stopped", "registration_failed"])(
      "%s takes the wait away and is remembered",
      (reason) => {
        const s = fold(ended(reason)).sessions.get("S1");
        expect(s?.waits).toEqual([]);
        expect(s?.ended).toMatchObject([{ reason, pr: "octo/repo#7", fresh: true }]);
      },
    );

    it("keeps a reason added since, as given: it removes the wait and is shown among the ended", () => {
      const f = fold(ended("session_deleted"));
      const s = f.sessions.get("S1");
      expect(s?.waits).toEqual([]);
      expect(s?.ended).toMatchObject([
        { reason: "session_deleted", pr: "octo/repo#7", fresh: true },
      ]);
      expect(sessionFeedView(f, "S1")?.ended.map((e) => e.reason)).toEqual(["session_deleted"]);
      expect(f.stopped).toBeNull();
      expect(feedStale(f)).toBeNull();
    });

    it("is history, not fresh, when it happened before the session's baseline", () => {
      const f = fold([event(1, "wait.removed", { reason: "unreadable" }), baseline(1)]);
      expect(f.sessions.get("S1")?.ended).toMatchObject([{ reason: "unreadable", fresh: false }]);
    });

    it("shows on the session's view unless the pull request merged", () => {
      const f = fold([
        ...ended("unreadable"),
        event(3, "wait.removed", { reason: "merged" }, { pr: "octo/repo#8" }),
      ]);
      expect(sessionFeedView(f, "S1")?.ended.map((e) => e.reason)).toEqual(["unreadable"]);
    });
  });

  describe("what it doesn't know", () => {
    it("skips an annotation of a type it doesn't know, and still moves the cursor past it", () => {
      const f = fold([
        baseline(0),
        event(1, "wake.rescheduled", { whatever: 1 }, { effect: "annotation" }),
        event(2, "wait.registered", { waitSource: "mcp" }),
      ]);
      expect(f.cursor).toBe(2);
      expect(f.sessions.get("S1")?.waits).toHaveLength(1);
      expect(f.sessions.get("S1")?.wakes).toEqual([]);
      expect(f.stopped).toBeNull();
    });

    it("ignores an event of a contract version it doesn't know", () => {
      const f = fold([baseline(0), event(1, "wait.registered", { waitSource: "mcp" }, { v: 2 })]);
      expect(f.sessions.get("S1")?.waits).toEqual([]);
    });

    it("is stale once the reader stopped, and says which event", () => {
      const f = fold([
        baseline(0),
        event(1, "wait.registered", { waitSource: "mcp" }),
        {
          type: "feed.stopped",
          data: { feed: KIRO_FEED, seq: 2, type: "wait.paused", reason: "type" },
        },
      ]);
      expect(f.stopped).toMatchObject({ seq: 2, type: "wait.paused" });
      expect(feedStale(f)).toContain("wait.paused");
      expect(feedStale(f)).toContain("event 2");
      // What it had is still shown, marked stale by whoever draws it.
      expect(f.sessions.get("S1")?.waits).toHaveLength(1);
      expect(sessionFeedView(f, "S1")?.stale).toContain("wait.paused");
    });

    it("keeps one feed's facts apart from another's", () => {
      const other = { type: "feed.event", data: { feed: "deploys", event: { seq: 99 } } };
      expect(fold([other as Fact]).cursor).toBe(0);
    });
  });

  describe("a restart", () => {
    it("rebuilds links and waits from the baselines after it, and keeps the history", () => {
      const f = fold([
        baseline(0, { waits: [{ pr: "octo/repo#5", source: "mcp", since: "" }] }),
        event(1, "wake.queued", { ...wake("w1"), merged: false }),
        event(2, "wait.removed", { reason: "unreadable" }, { pr: "octo/repo#5" }),
        {
          type: "feed.restarted",
          data: { feed: KIRO_FEED, reason: "gap", cursor: 49, expected: 3, got: 50 },
        },
        event(50, "wait.registered", { waitSource: "mcp" }, { pr: "octo/repo#6" }),
        baseline(50, { waits: [{ pr: "octo/repo#6", source: "mcp", since: "" }] }),
        event(51, "wait.registered", { waitSource: "mcp" }, { pr: "octo/repo#7" }),
      ]);
      const s = f.sessions.get("S1");
      expect(s?.waits.map((w) => w.pr)).toEqual(["octo/repo#6", "octo/repo#7"]);
      expect(s?.baseline).toBe(50);
      expect(s?.wakes).toHaveLength(1);
      expect(s?.ended).toHaveLength(1);
      expect(f.restarts).toBe(1);
      expect(f.cursor).toBe(51);
    });

    it("has no state until its baselines are written", () => {
      const f = fold([
        baseline(0, { waits: [{ pr: "octo/repo#5", source: "mcp", since: "" }] }),
        {
          type: "feed.restarted",
          data: { feed: KIRO_FEED, reason: "gap", cursor: 49, expected: 3, got: 50 },
        },
        event(50, "wait.registered", { waitSource: "mcp" }),
      ]);
      expect(f.started).toBe(false);
      expect(f.sessions.get("S1")?.waits).toEqual([]);
      expect(f.cursor).toBe(50);
    });

    it("clears a stop", () => {
      const f = fold([
        baseline(0),
        {
          type: "feed.stopped",
          data: { feed: KIRO_FEED, seq: 2, type: "wait.paused", reason: "type" },
        },
        {
          type: "feed.restarted",
          data: { feed: KIRO_FEED, reason: "resumed", cursor: 1, expected: null, got: null },
        },
      ]);
      expect(f.stopped).toBeNull();
    });
  });

  it("is a pure function: the same facts, the same fold", () => {
    const facts = [baseline(0), event(1, "wait.registered", { waitSource: "mcp" })];
    expect(fold(facts)).toEqual(fold(facts));
  });

  it("knows each type of the contract", () => {
    // Every type has a case above; this fails when the contract gains one nobody folded.
    expect(FEED_TYPE_NAMES).toHaveLength(9);
  });
});
