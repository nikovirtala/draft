import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../src/agent.ts";
import { type DraftEvent, knownEvents } from "../src/events.ts";
import { KNOWN_FEED_TYPES } from "../src/feed.ts";
import { GithubClient } from "../src/github.ts";
import { KiroRemoteRest } from "../src/kiro-remote-rest.ts";
import { FileLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { PullRequestResolver } from "../src/pull-request.ts";
import { KiroSessionResolver } from "../src/resolver.ts";
import { FakeGithub, FakeKiroRemote } from "../src/testing/index.ts";
import { Workspace } from "../src/workspace.ts";
import { USER } from "./helpers.ts";

/**
 * Kiro Remote's change feed read into a context, end to end in core: a fake Kiro Remote serving
 * /v1/events and /v1/sessions/{id}, a workspace with the session and the pull request it waits
 * for on its map, and what the map, the stub and "needs you" say as the feed moves.
 */

const SESSION = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
const OTHER = "01KAHX8A1B2C3D4E5F6G7H8J9K";
const REPO = "nikovirtala/kiro-remote";
const PR = `${REPO}#7`;
const PR_ID = `${REPO}/pull/7`;

const open: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

interface Setup {
  dir?: string;
  kiro?: FakeKiroRemote;
  github?: FakeGithub;
  known?: ReadonlySet<string>;
  now?: () => number;
  /** Write nothing to the person's log until asked: the session is not mentioned yet. */
  mention?: boolean;
}

async function harness(o: Setup = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "draft-feed-"));
  const kiro =
    o.kiro ??
    (await new FakeKiroRemote({
      sessions: [
        { id: SESSION, title: "Wait for the feed", status: "running" },
        { id: OTHER, title: "Another", status: "idle" },
      ],
    }).start());
  const github = o.github ?? (await new FakeGithub().start());
  if (o.kiro === undefined) open.push(() => kiro.stop());
  if (o.github === undefined) {
    github.addPull(REPO, 7, { title: "Add the feed", draft: true });
    open.push(() => github.stop());
  }
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const tools = kiro.asTools();
  const ws = await Workspace.open({
    log,
    projection,
    agent: new FakeAgentRuntime({ turns: [], fallback: "Nothing scripted." }, tools, {
      model: "claude-opus-5-5",
    }),
    resolvers: [
      new KiroSessionResolver(tools),
      new PullRequestResolver(new GithubClient({ token: "t0ken", baseUrl: github.baseUrl })),
    ],
    user: USER,
    poller: { baseMs: 0 },
    feed: {
      api: new KiroRemoteRest({ baseUrl: kiro.baseUrl, token: async () => null }),
      intervalMs: 60_000,
      ...(o.known === undefined ? {} : { known: o.known }),
      ...(o.now === undefined ? {} : { now: o.now }),
    },
  });
  open.push(() => {
    log.close();
    projection.close();
  });
  if (o.mention !== false) await ws.main.submit(`${SESSION} waits for ${PR}`);
  const events = (): DraftEvent[] => knownEvents(log.events());
  const feedFacts = (type: string) => events().filter((e) => e.type === type);
  return {
    dir,
    kiro,
    github,
    ws,
    log,
    events,
    feedFacts,
    /** The feed is read now, as when the app gains focus. */
    read: () => ws.focus(),
    map: () => ws.map(),
    stub: () => ws.main.state().stubs[`kiro-session:${SESSION}`],
    notes: () => ws.main.state().timeline.flatMap((b) => (b.kind === "note" ? [b] : [])),
    attention: () => ws.attention(),
    reads: () => kiro.rest.filter((r) => r.path.startsWith("/v1/events")).map((r) => r.path),
  };
}

const edgesOf = (map: ReturnType<Workspace["map"]>) =>
  map.edges.filter((e) => e.rel === "waits-for");

describe("starting from what the service says", () => {
  it("reads the feed to its end, then each session's links and waits, once", async () => {
    const h = await harness({ mention: false });
    // From before the feed: no event, only what the session says.
    h.kiro.sessions.get(SESSION)?.waits.push({
      pr: PR,
      repo: REPO,
      number: 7,
      source: "mcp",
      createdAt: "2026-11-20T10:00:00.000Z",
    });
    h.kiro.emit({
      type: "link.added",
      sessionId: OTHER,
      pr: `${REPO}#1`,
      payload: { method: "harvest", prState: "open" },
    });
    await h.ws.main.submit(`${SESSION} waits for ${PR}`);
    await h.read();

    expect(h.feedFacts("feed.event")).toHaveLength(1);
    const [baseline] = h.feedFacts("feed.baseline");
    expect(baseline?.data).toMatchObject({
      feed: "kiro-remote",
      cursor: 1,
      session: SESSION,
      waits: [{ pr: PR, source: "mcp", since: "2026-11-20T10:00:00.000Z" }],
    });
    // The feed is only asked for the sessions the context mentions.
    expect(h.feedFacts("feed.baseline")).toHaveLength(1);
    expect(h.stub()?.feed).toMatchObject({
      feed: "kiro-remote",
      cursor: 1,
      baseline: 1,
      waits: [{ pr: PR }],
      stale: null,
    });
    // Reading again, with nothing new, writes nothing.
    const before = h.events().length;
    await h.read();
    expect(h.events().length).toBe(before);
  });

  it("reads nothing while the context mentions no session", async () => {
    const h = await harness({ mention: false });
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    expect(h.kiro.rest).toEqual([]);
    expect(h.feedFacts("feed.event")).toEqual([]);
  });
});

describe("a session waiting for a pull request", () => {
  it("is an edge on the map from the session to the pull request, until the wait ends", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    const map = h.map();
    expect(edgesOf(map)).toEqual([
      {
        context: map.context,
        from: { kind: "kiro-session", id: SESSION },
        to: { kind: "pull-request", id: PR_ID },
        rel: "waits-for",
        at: expect.any(String),
      },
    ]);
    // The map says which feed and which cursor it was folded from.
    expect(map.feeds).toEqual([{ feed: "kiro-remote", cursor: 1, stale: null }]);
    expect(h.stub()?.feed?.waits.map((w) => w.pr)).toEqual([PR]);

    h.kiro.endWait(SESSION, PR, "stopped");
    await h.read();
    expect(edgesOf(h.map())).toEqual([]);
    expect(h.stub()?.feed?.waits).toEqual([]);
    expect(h.map().feeds[0]?.cursor).toBe(2);
  });

  it("says why it last woke once the pull request merges and the wake is delivered", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    const wake = h.kiro.endWait(SESSION, PR, "merged") as string;
    await h.read();
    // Queued, not sent yet: no last wake, and no wait.
    expect(h.stub()?.feed?.lastWake).toBeNull();
    h.kiro.deliverWake(SESSION, wake);
    await h.read();
    expect(h.stub()?.feed?.lastWake).toMatchObject({
      cause: "wait",
      kind: "pr_wait_merged",
      pr: PR,
      text: `a pull request it waited for ${PR} merged`,
    });
    const node = h
      .map()
      .rows.flatMap((r) => r.cells.flatMap((c) => c.items))
      .find((i) => i.id === SESSION);
    expect(node?.note).toBe(`woke: a pull request it waited for ${PR} merged`);
    expect(edgesOf(h.map())).toEqual([]);
  });

  it("keeps a session's wakes and their causes, for a count of the ones done by hand", async () => {
    const h = await harness();
    h.kiro.emit({
      type: "wake.queued",
      sessionId: SESSION,
      pr: PR,
      payload: { itemId: "w1", kind: "pr_merged", cause: "linked_pr_event", merged: false },
    });
    h.kiro.emit({
      type: "wake.queued",
      sessionId: SESSION,
      pr: PR,
      payload: { itemId: "w2", kind: "pr_conflict", cause: "conflict", merged: false },
    });
    await h.read();
    const fold = (await import("../src/kiro-feed.ts")).foldKiroFeed(
      h.events().flatMap((e, seq) => (e.type.startsWith("feed.") ? [{ event: e, seq }] : [])),
    );
    expect(fold.sessions.get(SESSION)?.wakes.map((w) => [w.itemId, w.cause])).toEqual([
      ["w1", "linked_pr_event"],
      ["w2", "conflict"],
    ]);
  });
});

describe("resuming", () => {
  it("continues from the cursor in the log after a restart and never replays", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    h.kiro.emit({
      type: "link.added",
      sessionId: OTHER,
      pr: `${REPO}#2`,
      payload: { method: "trailer", prState: "open" },
    });
    await h.read();
    expect(h.feedFacts("feed.event")).toHaveLength(2);
    h.log.close();

    // The app starts again over the same log.
    const again = await harness({ dir: h.dir, kiro: h.kiro, github: h.github, mention: false });
    again.kiro.rest.length = 0;
    again.kiro.startWaiting(SESSION, `${REPO}#8`);
    await again.read();
    expect(again.reads()).toEqual(["/v1/events?after=2&limit=200"]);
    expect(
      again.feedFacts("feed.event").map((e) => (e.data as { event: { seq: number } }).event.seq),
    ).toEqual([1, 2, 3]);
    expect(again.feedFacts("feed.baseline")).toHaveLength(1);
    expect(
      again
        .stub()
        ?.feed?.waits.map((w) => w.pr)
        .sort(),
    ).toEqual([PR, `${REPO}#8`]);
  });

  it("starts a session mentioned later from the service's state at that cursor", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    h.kiro.startWaiting(OTHER, `${REPO}#3`);
    await h.ws.main.submit(`and ${OTHER}`);
    await h.read();
    const baselines = h
      .feedFacts("feed.baseline")
      .map((e) => e.data as { session: string; cursor: number });
    expect(baselines.map((b) => [b.session, b.cursor])).toEqual([
      [SESSION, 1],
      [OTHER, 2],
    ]);
  });
});

describe("what it doesn't know", () => {
  it("skips an annotation of an unknown type, keeps it, and follows what comes after", async () => {
    const h = await harness();
    h.kiro.emit({
      type: "wake.rescheduled",
      effect: "annotation",
      sessionId: SESSION,
      payload: { later: true },
    });
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    expect(h.feedFacts("feed.stopped")).toEqual([]);
    expect(h.notes()).toEqual([]);
    expect(h.feedFacts("feed.event")).toHaveLength(2);
    expect(h.stub()?.feed?.waits).toHaveLength(1);
    expect(h.stub()?.feed?.cursor).toBe(2);
  });

  it("stops at a state type it doesn't know: one notice naming it, and the waits are marked stale", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    h.kiro.emit({
      type: "wait.paused",
      effect: "state",
      sessionId: SESSION,
      pr: PR,
      payload: { until: "later" },
    });
    h.kiro.startWaiting(SESSION, `${REPO}#9`);
    await h.read();

    expect(h.feedFacts("feed.stopped").map((e) => e.data)).toEqual([
      { feed: "kiro-remote", seq: 2, type: "wait.paused", reason: "type" },
    ]);
    const notes = h.notes().filter((n) => n.what === "kiro-feed-stopped");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain("wait.paused");
    // Nothing after the event was followed.
    expect(h.stub()?.feed?.waits.map((w) => w.pr)).toEqual([PR]);
    expect(h.stub()?.feed?.stale).toContain("wait.paused");
    const map = h.map();
    expect(map.rows.find((r) => r.kind === "kiro-session")?.stale).toContain("wait.paused");
    expect(map.problems.map((p) => p.message).join("\n")).toContain("wait.paused");
    expect(map.feeds[0]).toMatchObject({ feed: "kiro-remote", cursor: 1 });
    expect(map.feeds[0]?.stale).toContain("wait.paused");

    // It stays stopped: no more reads, and no second notice.
    const reads = h.reads().length;
    await h.read();
    await h.read();
    expect(h.reads()).toHaveLength(reads);
    expect(h.notes().filter((n) => n.what === "kiro-feed-stopped")).toHaveLength(1);
  });

  it("stops at a state event it can't read, even of a type it knows", async () => {
    const h = await harness();
    h.kiro.emit({
      type: "wait.removed",
      sessionId: SESSION,
      pr: PR,
      payload: { reason: 7 },
    });
    await h.read();
    expect(h.feedFacts("feed.stopped").map((e) => e.data)).toMatchObject([
      { seq: 1, type: "wait.removed", reason: "invalid" },
    ]);
  });

  it("follows the feed again once draft knows the type that stopped it", async () => {
    const older = new Set([...KNOWN_FEED_TYPES].filter((t) => t !== "wait.removed"));
    const h = await harness({ known: older });
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    h.kiro.endWait(SESSION, PR, "stopped");
    await h.read();
    expect(h.feedFacts("feed.stopped")).toHaveLength(1);
    // The wait ended, but this draft can't tell: it still shows it, marked stale.
    expect(h.stub()?.feed?.waits.map((w) => w.pr)).toEqual([PR]);
    expect(h.stub()?.feed?.stale).toContain("wait.removed");
    h.log.close();

    // The app is updated: it reads wait.removed.
    const newer = await harness({ dir: h.dir, kiro: h.kiro, github: h.github, mention: false });
    await newer.read();
    expect(newer.feedFacts("feed.restarted").map((e) => e.data)).toMatchObject([
      { reason: "resumed", cursor: 1 },
    ]);
    expect(newer.stub()?.feed?.waits).toEqual([]);
    expect(newer.stub()?.feed?.stale).toBeNull();
    expect(newer.map().rows.find((r) => r.kind === "kiro-session")?.stale).toBeNull();
  });
});

describe("events that expired", () => {
  it("starts again from the starting state, and says so", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    // While the app was away the service dropped what the app hadn't read, and a wait ended.
    h.kiro.emit({
      type: "link.added",
      sessionId: OTHER,
      pr: `${REPO}#2`,
      payload: { method: "trailer", prState: "open" },
    });
    h.kiro.emit({
      type: "link.added",
      sessionId: OTHER,
      pr: `${REPO}#3`,
      payload: { method: "trailer", prState: "open" },
    });
    h.kiro.endWait(SESSION, PR, "stopped");
    h.kiro.expireBefore(4);
    await h.read();

    expect(h.feedFacts("feed.restarted").map((e) => e.data)).toEqual([
      { feed: "kiro-remote", reason: "gap", cursor: 3, expected: 2, got: 4 },
    ]);
    const note = h.notes().find((n) => n.what === "kiro-feed-restarted");
    expect(note?.text).toContain("after 1");
    // The wait that ended in the gap is gone, because the baseline came from the service.
    expect(h.stub()?.feed?.waits).toEqual([]);
    expect(h.feedFacts("feed.baseline")).toHaveLength(2);
    expect(h.stub()?.feed?.cursor).toBe(4);
    expect(h.stub()?.feed?.baseline).toBe(4);
    expect(edgesOf(h.map())).toEqual([]);
  });
});

describe("a wait that ended unreadable", () => {
  const item = (h: Awaited<ReturnType<typeof harness>>) =>
    h.attention().filter((a) => a.cause === "wait-ended");

  it("is one item in needs you that the person dismisses", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    expect(item(h)).toEqual([]);
    h.kiro.endWait(SESSION, PR, "unreadable");
    await h.read();
    expect(item(h)).toHaveLength(1);

    const block = h.ws.main
      .state()
      .timeline.find((b) => b.kind === "interrupt" && b.cause === "wait-ended");
    expect(block).toMatchObject({
      state: "open",
      summary: `Wait for the feed stopped waiting for ${PR}: it couldn't be read`,
      outcomes: ["dismissed"],
      detail: { feed: "kiro-remote", sessionId: SESSION, pr: PR, reason: "unreadable", seq: 2 },
    });
    // Reading again, and after a restart, raises nothing more.
    await h.read();
    expect(h.events().filter((e) => e.type === "interrupt.raised")).toHaveLength(1);

    await h.ws.main.settleInterrupt((block as { id: string }).id, "dismissed");
    expect(item(h)).toEqual([]);
    await h.read();
    expect(h.events().filter((e) => e.type === "interrupt.raised")).toHaveLength(1);
    const settled = h.events().find((e) => e.type === "interrupt.settled");
    expect(settled?.actor.kind).toBe("user");
  });

  it("is raised for a wait whose registration failed, and not for one that merged, closed or stopped", async () => {
    const h = await harness();
    for (const [n, reason] of (
      ["merged", "closed", "stopped", "registration_failed"] as const
    ).entries()) {
      h.kiro.startWaiting(SESSION, `${REPO}#${20 + n}`);
      h.kiro.endWait(SESSION, `${REPO}#${20 + n}`, reason);
    }
    await h.read();
    // These happened before the session's baseline was taken: they are history, not an inbox.
    expect(item(h)).toEqual([]);
    h.kiro.startWaiting(SESSION, `${REPO}#30`);
    h.kiro.endWait(SESSION, `${REPO}#30`, "registration_failed");
    h.kiro.startWaiting(SESSION, `${REPO}#31`);
    h.kiro.endWait(SESSION, `${REPO}#31`, "merged");
    await h.read();
    expect(item(h)).toHaveLength(1);
    expect(h.events().find((e) => e.type === "interrupt.raised")?.data).toMatchObject({
      detail: { pr: `${REPO}#30`, reason: "registration_failed" },
    });
  });

  it("is not raised for a reason added since, such as session_deleted, which also never stops the feed", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    h.kiro.emit({
      type: "wait.removed",
      sessionId: SESSION,
      pr: PR,
      source: "sweep",
      payload: { reason: "session_deleted" },
    });
    h.kiro.startWaiting(SESSION, `${REPO}#8`);
    await h.read();
    expect(item(h)).toEqual([]);
    expect(h.feedFacts("feed.stopped")).toEqual([]);
    expect(h.stub()?.feed?.waits.map((w) => w.pr)).toEqual([`${REPO}#8`]);
    expect(h.stub()?.feed?.ended).toMatchObject([{ pr: PR, reason: "session_deleted" }]);
    expect(h.stub()?.feed?.stale).toBeNull();
    expect(edgesOf(h.map())).toEqual([]);
  });

  it("shows on the map as an interrupt of its own kind, waiting on the person", async () => {
    const h = await harness();
    h.kiro.startWaiting(SESSION, PR);
    await h.read();
    h.kiro.endWait(SESSION, PR, "unreadable");
    await h.read();
    const row = h.map().rows.find((r) => r.kind === "interrupt:wait-ended");
    expect(row?.total).toBe(1);
    expect(row?.waitingOnPerson).toBe(1);
  });
});

describe("when the service can't be read", () => {
  it("writes nothing, doesn't throw, and tries again later and less often", async () => {
    let t = 1_000_000;
    const h = await harness({ now: () => t });
    h.kiro.startWaiting(SESSION, PR);
    h.kiro.failRest = 2;
    await h.read();
    expect(h.feedFacts("feed.event")).toEqual([]);
    expect(h.kiro.rest).toHaveLength(1);
    // The first failure doubles the interval: two minutes.
    t += 61_000;
    await h.ws.tick();
    expect(h.kiro.rest).toHaveLength(1);
    t += 60_000;
    await h.ws.tick();
    expect(h.kiro.rest).toHaveLength(2);
    // The second doubles it again: four minutes.
    t += 121_000;
    await h.ws.tick();
    expect(h.kiro.rest).toHaveLength(2);
    t += 120_000;
    await h.ws.tick();
    expect(h.feedFacts("feed.event")).toHaveLength(1);
  });
});
