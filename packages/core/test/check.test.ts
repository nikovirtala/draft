import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../src/agent.ts";
import {
  CHECK_REMINDER_MS,
  checkLifecycle,
  dueReminders,
  foldChecks,
  requestsOfMerge,
} from "../src/check.ts";
import {
  type Actor,
  type DraftEvent,
  type EventDraft,
  knownEvents,
  sealEvent,
  type Target,
} from "../src/events.ts";
import { GithubClient } from "../src/github.ts";
import type { InterruptCandidate } from "../src/interrupts.ts";
import { FileLogStore } from "../src/log.ts";
import { mapOf } from "../src/map-kinds.ts";
import { Projection } from "../src/projection.ts";
import { PullRequestResolver } from "../src/pull-request.ts";
import type { Resolver } from "../src/resolver.ts";
import { FakeGithub } from "../src/testing/index.ts";
import { Workspace } from "../src/workspace.ts";
import { AGENT, SYSTEM, USER } from "./helpers.ts";

const REPO = "nikovirtala/draft";
const PR: Target = { type: "pull-request", id: `${REPO}/pull/9` };
const ADR_ID = "8rhwhgbw";
const ADR: Target = { type: "adr", id: `${REPO}:${ADR_ID}` };

const BODY = [
  "## Summary",
  "",
  "A change.",
  "",
  "## After deploy",
  "",
  `- **Look at the palette.** Why no test can show it: it is a look. It gates ADR ${ADR_ID}.`,
  "  1. Run `pnpm dev`. You should see a window on cream.",
  "  2. Type `show the map`. You should see a graph.",
  "- **Sign in once.** Why no test can show it: it needs your account.",
  "  1. Run `kiro-cli login`. You should see a browser tab open.",
  "",
  "## Filed for later",
  "",
  "None",
].join("\n");

describe("what a merged pull request asks for", () => {
  const state = (over: Record<string, unknown> = {}) => ({
    state: "merged",
    repo: REPO,
    number: 9,
    title: "A change",
    url: `https://github.com/${REPO}/pull/9`,
    headSha: "a".repeat(40),
    body: BODY,
    ...over,
  });

  it("is one request for each item, keyed by the pull request, its head and the item's place", () => {
    const requests = requestsOfMerge(PR, state());
    expect(requests.map((r) => r.key)).toEqual([
      `check:pull-request:${REPO}/pull/9:${"a".repeat(40)}:0`,
      `check:pull-request:${REPO}/pull/9:${"a".repeat(40)}:1`,
    ]);
    expect(requests[0]).toMatchObject({
      title: "Look at the palette",
      source: {
        type: "merged-pull-request",
        target: PR,
        ref: `${REPO}#9`,
        sha: "a".repeat(40),
      },
      candidates: [ADR_ID],
    });
    expect(requests[0]?.steps).toHaveLength(2);
  });

  it("is nothing for a pull request that has not merged, has no body, or says Nothing", () => {
    expect(requestsOfMerge(PR, state({ state: "open" }))).toEqual([]);
    expect(requestsOfMerge(PR, state({ body: null }))).toEqual([]);
    expect(requestsOfMerge(PR, state({ body: "## After deploy\n\nNothing" }))).toEqual([]);
  });
});

describe("the fold of a check's facts", () => {
  const key = "check:k:1";
  let n = 0;
  const seal = (e: Omit<EventDraft, "address" | "conversation" | "traceId">, at: string) =>
    sealEvent(
      {
        ...e,
        address: `local/c1/i${++n}@1`,
        conversation: "local/c1",
        traceId: null,
      } as EventDraft,
      { id: `01KAHX0000000000000000${String(n).padStart(4, "0")}`, at, prevHash: "0".repeat(64) },
    );
  const requested = (at: string, actor: Actor = SYSTEM) =>
    seal(
      {
        type: "check.requested",
        actor,
        data: {
          key,
          source: {
            type: "merged-pull-request",
            target: PR,
            ref: `${REPO}#9`,
            sha: "a".repeat(40),
            title: null,
            url: null,
          },
          index: 0,
          title: "Look",
          reason: "",
          steps: [],
          tail: null,
          raw: "x",
          parsed: false,
          gates: [],
        },
      },
      at,
    );
  const passed = (at: string, actor: Actor = USER, note: string | null = null) =>
    seal({ type: "check.passed", actor, data: { key, note } }, at);
  const failed = (at: string, actor: Actor = USER, note = "it was blank") =>
    seal({ type: "check.failed", actor, data: { key, note } }, at);
  const reminded = (at: string, actor: Actor = SYSTEM) =>
    seal({ type: "check.reminded", actor, data: { key } }, at);
  const fold = (...events: DraftEvent[]) =>
    foldChecks(events.map((event, seq) => ({ event, seq })));
  const T0 = "2026-11-23T10:00:00.000Z";

  it("is requested until a person answers, then passed or failed with their note", () => {
    expect(fold(requested(T0))[0]).toMatchObject({ state: "requested", answer: null });
    expect(
      fold(requested(T0), passed("2026-11-23T11:00:00.000Z", USER, "looked fine"))[0],
    ).toMatchObject({
      state: "passed",
      answer: { outcome: "passed", by: "Test User", note: "looked fine" },
    });
    expect(fold(requested(T0), failed("2026-11-23T11:00:00.000Z"))[0]).toMatchObject({
      state: "failed",
      answer: { outcome: "failed", note: "it was blank" },
    });
    expect(fold(requested(T0), passed("2026-11-23T11:00:00.000Z"))[0]?.answer?.note).toBeNull();
  });

  it("takes an answer only from a person, and only once", () => {
    expect(fold(requested(T0), passed("2026-11-23T11:00:00.000Z", AGENT))[0]?.state).toBe(
      "requested",
    );
    expect(fold(requested(T0), failed("2026-11-23T11:00:00.000Z", SYSTEM))[0]?.state).toBe(
      "requested",
    );
    const answered = fold(
      requested(T0),
      failed("2026-11-23T11:00:00.000Z"),
      passed("2026-11-23T12:00:00.000Z"),
    )[0];
    expect(answered?.state).toBe("failed");
    expect(answered?.path.map((p) => p.state)).toEqual(["requested", "failed"]);
  });

  it("asks for the same key once: the first request counts", () => {
    const checks = fold(requested(T0), requested("2026-11-23T12:00:00.000Z"));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.requestedAt).toBe(T0);
  });

  it("raises a check again a day after it last asked, and again a day after that", () => {
    const [c] = fold(requested(T0));
    const day = CHECK_REMINDER_MS;
    expect(dueReminders([c as never], Date.parse(T0) + day - 1)).toEqual([]);
    expect(dueReminders([c as never], Date.parse(T0) + day)).toHaveLength(1);
    const again = fold(requested(T0), reminded("2026-11-24T10:00:00.000Z"))[0];
    expect(again).toMatchObject({
      state: "requested",
      reminders: 1,
      raisedAt: "2026-11-24T10:00:00.000Z",
    });
    expect(dueReminders([again as never], Date.parse("2026-11-25T09:59:59.999Z"))).toEqual([]);
    expect(dueReminders([again as never], Date.parse("2026-11-25T10:00:00.000Z"))).toHaveLength(1);
  });

  it("does not remind a check that is answered, and takes a reminder only from draft", () => {
    const answered = fold(
      requested(T0),
      passed("2026-11-23T11:00:00.000Z"),
      reminded("2026-11-24T10:00:00.000Z"),
    )[0];
    expect(answered?.reminders).toBe(0);
    expect(dueReminders([answered as never], Date.parse(T0) + 3 * CHECK_REMINDER_MS)).toEqual([]);
    expect(fold(requested(T0), reminded("2026-11-24T10:00:00.000Z", USER))[0]?.reminders).toBe(0);
  });

  it("is a machine only a person can pass or fail", () => {
    const m = checkLifecycle();
    expect(m.personOnlyTriggers().sort()).toEqual(["fail", "pass"]);
    expect(m.triggersFirableBy("agent")).toEqual([]);
    expect(m.next("requested", "fail", "user", "").ok).toBe(false);
  });
});

/** A decision's resolver: proposed, and ready to accept as soon as it is referenced. */
const adrResolver: Resolver = {
  type: "adr",
  version: "1",
  detect: () => [],
  fetch: async (id) => ({ status: "proposed", title: "Accept only as the person", id }),
  interrupts: (target): InterruptCandidate[] => [
    {
      key: `accept:adr:${target.id}:sha`,
      kind: "acceptance",
      summary: `${target.id} is ready to accept`,
      detail: { acceptance: "adr", target, title: "Accept only as the person" },
    },
  ],
};

async function harness(proposed: { repo: string; id: string }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "draft-checks-"));
  const github = await new FakeGithub().start();
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const ws = await Workspace.open({
    log,
    projection,
    agent: new FakeAgentRuntime({ turns: [], fallback: "Nothing scripted." }, {} as never, {
      model: "claude-opus-5-5",
    }),
    resolvers: [
      new PullRequestResolver(new GithubClient({ token: "t0ken", baseUrl: github.baseUrl })),
      adrResolver,
    ],
    user: USER,
    poller: { baseMs: 0 },
    proposedDecisions: async () => proposed,
  });
  // A draft: nothing about it is ready to accept, so only the checks need the person.
  github.addPull(REPO, 9, {
    title: "A change",
    body: BODY,
    headSha: "a".repeat(40),
    draft: true,
  });
  await ws.main.submit(`${REPO}#9`);
  return {
    ws,
    github,
    events: () => knownEvents(log.events()),
    merge: async () => {
      github.updatePull(REPO, 9, { state: "closed", merged: true });
      ws.setVisible([PR]);
      await ws.tick();
    },
    close: () => {
      log.close();
      projection.close();
      void github.stop();
    },
  };
}

describe("a pull request seen to merge", () => {
  it("asks for one check per item, as needing the person, once however often it is seen", async () => {
    const h = await harness();
    expect(h.ws.main.attention()).toEqual([]);
    await h.merge();
    const requested = h.events().filter((e) => e.type === "check.requested");
    expect(requested).toHaveLength(2);
    expect(h.ws.main.attention().map((a) => a.cause)).toEqual(["check", "check"]);
    const blocks = h.ws.main.state().timeline.filter((b) => b.kind === "check");
    expect(blocks.map((b) => b.kind === "check" && b.check.title)).toEqual([
      "Look at the palette",
      "Sign in once",
    ]);
    // The same merge seen again, and the pull request changing after it, ask for nothing more.
    h.github.updatePull(REPO, 9, { title: "A change, renamed" });
    await h.ws.tick();
    await h.ws.tick();
    expect(h.events().filter((e) => e.type === "check.requested")).toHaveLength(2);
    // Every request names its source: the pull request and its head.
    expect(requested[0]?.type === "check.requested" && requested[0].data.source).toMatchObject({
      type: "merged-pull-request",
      ref: `${REPO}#9`,
      sha: "a".repeat(40),
    });
    // The pull request's own writes stay GitHub-free: only reads.
    expect(h.github.requests.every((r) => r.method === "GET")).toBe(true);
    h.close();
  });

  it("asks for nothing when it is merged without an After deploy section to read", async () => {
    const h = await harness();
    h.github.updatePull(REPO, 9, { body: "## After deploy\n\nNothing" });
    await h.merge();
    expect(h.events().filter((e) => e.type === "check.requested")).toEqual([]);
    expect(h.ws.main.attention()).toEqual([]);
    h.close();
  });

  it("joins the map as a row of its own, waiting on the person", async () => {
    const h = await harness();
    await h.merge();
    const map = h.ws.map();
    const row = map.rows.find((r) => r.kind === "check");
    expect(row).toMatchObject({ total: 2, waitingOnPerson: 2 });
    expect(row?.cells.find((c) => c.column === "requested")?.items[0]).toMatchObject({
      kind: "check",
      state: "requested",
      waitsOn: "user",
    });
    expect(map.totals.waitingOnPerson).toBeGreaterThanOrEqual(2);
    h.close();
  });
});

describe("a person's answer to a check", () => {
  it("passes one with an optional note and fails the other with the note it needs", async () => {
    const h = await harness();
    await h.merge();
    const [a, b] = h.ws.main.attention();
    // Failing needs the words that say what was seen.
    await expect(h.ws.main.answerCheck(b?.id as string, "failed", "  ")).rejects.toThrow(
      /Say what you saw/,
    );
    await h.ws.main.answerCheck(b?.id as string, "failed", "no browser tab opened");
    await h.ws.main.answerCheck(a?.id as string, "passed", null);
    expect(h.ws.main.attention()).toEqual([]);
    const answers = h
      .events()
      .filter((e) => e.type === "check.passed" || e.type === "check.failed");
    expect(answers.map((e) => [e.type, e.actor.kind, e.data])).toEqual([
      ["check.failed", "user", { key: b?.id, note: "no browser tab opened" }],
      ["check.passed", "user", { key: a?.id, note: null }],
    ]);
    // An answered check is not answered again.
    await expect(h.ws.main.answerCheck(a?.id as string, "failed", "again")).rejects.toThrow(
      /already answered/,
    );
    // The map: passed is done; failed is waiting, but not on the person.
    const row = h.ws.map().rows.find((r) => r.kind === "check");
    expect(row?.waitingOnPerson).toBe(0);
    expect(row?.cells.find((c) => c.column === "passed")?.items[0]).toMatchObject({
      class: "terminal",
    });
    expect(row?.cells.find((c) => c.column === "failed")?.items[0]).toMatchObject({
      class: "waiting",
      waitsOn: "agent",
      stateLabel: "Failed",
    });
    h.close();
  });

  it("raises a check again after a day, and says so in the log", async () => {
    const h = await harness();
    await h.merge();
    const first = h.ws.main.attention()[0];
    const day = CHECK_REMINDER_MS;
    await h.ws.main.remindChecks(Date.now() + day - 60_000);
    expect(h.events().filter((e) => e.type === "check.reminded")).toEqual([]);
    const later = Date.now() + day + 60_000;
    await h.ws.main.remindChecks(later);
    const reminded = h.events().filter((e) => e.type === "check.reminded");
    expect(reminded).toHaveLength(2);
    expect(reminded.every((e) => e.actor.kind === "system")).toBe(true);
    // It is still needing the person, raised at the time of the reminder.
    const [raised] = h.ws.main.attention();
    expect(raised?.id).toBe(first?.id);
    expect(Date.parse(raised?.at as string)).toBe(later);
    // The same moment again asks for nothing.
    await h.ws.main.remindChecks(later);
    expect(h.events().filter((e) => e.type === "check.reminded")).toHaveLength(2);
    h.close();
  });
});

describe("a check that names a proposed decision", () => {
  it("links to it, and offers its acceptance once it passes, never when it fails", async () => {
    const h = await harness([{ repo: REPO, id: ADR_ID }]);
    await h.merge();
    const requested = h.events().filter((e) => e.type === "check.requested");
    expect(requested.map((e) => e.type === "check.requested" && e.data.gates)).toEqual([[ADR], []]);
    // Nothing is offered while the check waits: the decision is not even a stub yet.
    expect(h.ws.main.attention().map((a) => a.cause)).toEqual(["check", "check"]);
    expect(h.events().filter((e) => e.type === "interrupt.raised")).toEqual([]);
    const [gated, other] = h.ws.main.attention();
    // Failing the one that gates it offers nothing.
    await h.ws.main.answerCheck(other?.id as string, "failed", "no tab");
    expect(h.events().filter((e) => e.type === "interrupt.raised")).toEqual([]);
    // Passing it offers the acceptance, in this conversation, as an ordinary acceptance request.
    await h.ws.main.answerCheck(gated?.id as string, "passed", "looks right");
    const raised = h.events().filter((e) => e.type === "interrupt.raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.type === "interrupt.raised" && raised[0].data).toMatchObject({
      kind: "acceptance",
      target: ADR,
    });
    expect(h.ws.main.attention().map((a) => a.cause)).toEqual(["acceptance"]);
    const reference = h
      .events()
      .find((e) => e.type === "reference.made" && e.data.target.type === "adr");
    expect(reference?.type === "reference.made" && reference.data).toMatchObject({
      target: ADR,
      relation: "gates",
      kind: "structural",
    });
    // The map draws the link.
    expect(h.ws.map().transitions.some((t) => t.kind === "check" && t.to === "passed")).toBe(true);
    h.close();
  });

  it("links only to what is proposed in the context's repositories", async () => {
    const h = await harness([{ repo: REPO, id: "zzzzzzzz" }]);
    await h.merge();
    expect(h.events().flatMap((e) => (e.type === "check.requested" ? [e.data.gates] : []))).toEqual(
      [[], []],
    );
    h.close();
  });
});

describe("the map of a log with checks", () => {
  it("is a pure fold: the same log gives the same map", async () => {
    const h = await harness();
    await h.merge();
    const records = h.events();
    expect(mapOf(records)).toEqual(mapOf(records));
    h.close();
  });
});
