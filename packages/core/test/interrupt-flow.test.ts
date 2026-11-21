import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRuntime, type FakeScript } from "../src/agent.ts";
import { buildAgentContext } from "../src/agent-context.ts";
import { type DraftEvent, type EventDraft, knownEvents, type Target } from "../src/events.ts";
import { GithubClient } from "../src/github.ts";
import { FileLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { PullRequestResolver } from "../src/pull-request.ts";
import { KiroSessionResolver } from "../src/resolver.ts";
import { FakeGithub, FakeKiroRemote } from "../src/testing/index.ts";
import { Workspace } from "../src/workspace.ts";
import { fakeKiro, openService } from "./fixtures.ts";
import { AGENT, CONV, genesisDrafts, TRACE, USER } from "./helpers.ts";

const LAUNCH = { prompt: "Fix the flaky test", repos: ["nikovirtala/draft"], title: "Fix it" };
const script = (turns: FakeScript["turns"]): FakeScript => ({
  turns,
  fallback: "Nothing scripted.",
});

interface Harness {
  ws: Workspace;
  kiro: FakeKiroRemote;
  github: FakeGithub;
  log: FileLogStore;
  projection: Projection;
  events: () => DraftEvent[];
  close: () => void;
}

async function harness(
  turns: FakeScript["turns"],
  o: { sessions?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "draft-interrupts-"));
  const kiro = new FakeKiroRemote({ sessions: [] });
  const github = await new FakeGithub().start();
  const tools = kiro.asTools();
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const client = new GithubClient({ token: "t0ken", baseUrl: github.baseUrl });
  const agent = new FakeAgentRuntime(script(turns), tools, { model: "claude-opus-5-5" });
  const ws = await Workspace.open({
    log,
    projection,
    agent,
    resolvers: [
      new KiroSessionResolver(tools),
      new PullRequestResolver(client, async () => "niko"),
    ],
    user: USER,
    actions: tools,
    poller: { baseMs: 0 },
  });
  void o;
  const answerAll = (conversation: string) =>
    ws.conversation(conversation).onChange((c) => {
      if (c.type !== "state") return;
      for (const p of c.state.prompts)
        queueMicrotask(() => ws.conversation(conversation).answerPrompt(p.id, true));
    });
  answerAll(ws.mainConversation);
  const origBranch = ws.branch.bind(ws);
  ws.branch = async (...a) => {
    const c = await origBranch(...a);
    answerAll(c);
    return c;
  };
  return {
    ws,
    kiro,
    github,
    log,
    projection,
    events: () => knownEvents(log.events()),
    close: () => {
      log.close();
      projection.close();
      void github.stop();
    },
  };
}

const sessionTarget = (id: string): Target => ({ type: "kiro-session", id });

async function launchInThread(h: Harness): Promise<{ thread: string; sessionId: string }> {
  await h.ws.main.submit("start");
  const parent = h.ws.main.state().messages[0]?.address as string;
  const thread = await h.ws.branch(parent, USER);
  await h.ws.conversation(thread).submit("launch the session");
  const sessionId = [...h.kiro.sessions.keys()][0] as string;
  return { thread, sessionId };
}

const baseTurns: FakeScript["turns"] = [
  { match: "^start$", steps: [{ text: "Started.", delayMs: 0 }] },
  {
    match: "launch",
    steps: [
      { tool: "kiro_launch_session", input: LAUNCH },
      { text: "Launched.", delayMs: 0 },
    ],
  },
];

describe("a hosted session's permission request", () => {
  it("arrives in the thread whose step launched the session, and you allow it there", async () => {
    const h = await harness(baseTurns);
    const { thread, sessionId } = await launchInThread(h);
    h.kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
    h.ws.setVisible([sessionTarget(sessionId)]);
    await h.ws.tick();

    // It is in the thread, not in the main conversation.
    expect(
      h.ws
        .conversation(thread)
        .attention()
        .map((a) => a.cause),
    ).toEqual(["permission"]);
    expect(h.ws.main.attention()).toEqual([]);
    expect(h.ws.attention()).toHaveLength(1);
    const block = h.ws
      .conversation(thread)
      .state()
      .timeline.find((b) => b.kind === "interrupt");
    expect(block).toMatchObject({
      kind: "interrupt",
      cause: "permission",
      state: "open",
      outcomes: ["allowed", "denied"],
      target: sessionTarget(sessionId),
    });
    const raised = h
      .events()
      .find((e) => e.type === "interrupt.raised") as DraftEvent<"interrupt.raised">;
    expect(raised.conversation).toBe(thread);
    expect(raised.actor).toMatchObject({ kind: "resolver", id: "kiro-session" });

    // You allow it: draft calls Kiro Remote as you, and the answer is in the log with you as actor.
    const key = (block as { id: string }).id;
    await h.ws.conversation(thread).settleInterrupt(key, "allowed");
    const answer = h.kiro.calls.filter((c) => c.tool === "kiro_answer_permission");
    expect(answer).toHaveLength(1);
    expect(answer[0]?.args).toMatchObject({
      sessionId,
      requestId: "perm-1",
      optionId: "allow_once",
    });
    expect(h.kiro.sessions.get(sessionId)?.permissions[0]?.status).toBe("answered");

    const mine = h
      .events()
      .filter(
        (e) =>
          e.actor.kind === "user" &&
          e.conversation === thread &&
          !["conversation.created", "agent.selected"].includes(e.type),
      )
      .map((e) => e.type);
    expect(mine).toEqual(["message.posted", "step.started", "step.completed", "interrupt.settled"]);
    const settled = h
      .events()
      .find((e) => e.type === "interrupt.settled") as DraftEvent<"interrupt.settled">;
    expect(settled.actor).toEqual(USER);
    expect(settled.data).toMatchObject({ key, kind: "permission", outcome: "allowed" });
    expect(settled.data.via).not.toBeNull();
    expect(h.ws.attention()).toEqual([]);
    expect(
      h.ws
        .conversation(thread)
        .state()
        .timeline.find((b) => b.kind === "interrupt"),
    ).toMatchObject({
      state: "settled",
      settled: { outcome: "allowed", by: USER.name },
    });
    // The answer is not shown as a step that needs attention.
    expect(h.ws.conversation(thread).attention()).toEqual([]);
    h.close();
  });

  it("is denied with the request's reject option", async () => {
    const h = await harness(baseTurns);
    const { thread, sessionId } = await launchInThread(h);
    h.kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
    h.ws.setVisible([sessionTarget(sessionId)]);
    await h.ws.tick();
    const key = h.ws.conversation(thread).attention()[0]?.id as string;
    await h.ws.conversation(thread).settleInterrupt(key, "denied");
    expect(h.kiro.calls.find((c) => c.tool === "kiro_answer_permission")?.args).toMatchObject({
      optionId: "reject_once",
    });
    h.close();
  });

  it("clears when it is answered somewhere else", async () => {
    const h = await harness(baseTurns);
    const { thread, sessionId } = await launchInThread(h);
    h.kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
    h.ws.setVisible([sessionTarget(sessionId)]);
    await h.ws.tick();
    expect(h.ws.attention()).toHaveLength(1);
    h.kiro.update(sessionId, { status: "running", pendingPermissions: 0 });
    await h.ws.tick();
    expect(h.ws.attention()).toEqual([]);
    const cleared = h
      .events()
      .find((e) => e.type === "interrupt.cleared") as DraftEvent<"interrupt.cleared">;
    expect(cleared.conversation).toBe(thread);
    expect(cleared.actor.kind).toBe("resolver");
    expect(
      h.ws
        .conversation(thread)
        .state()
        .timeline.find((b) => b.kind === "interrupt"),
    ).toMatchObject({
      state: "cleared",
    });
    h.close();
  });

  it("can't be settled twice, nor by an outcome its kind doesn't have", async () => {
    const h = await harness(baseTurns);
    const { thread, sessionId } = await launchInThread(h);
    h.kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
    h.ws.setVisible([sessionTarget(sessionId)]);
    await h.ws.tick();
    const svc = h.ws.conversation(thread);
    const key = svc.attention()[0]?.id as string;
    await expect(svc.settleInterrupt(key, "retry")).rejects.toThrow(/not allowed/);
    await svc.settleInterrupt(key, "allowed");
    await expect(svc.settleInterrupt(key, "allowed")).rejects.toThrow(/already settled/);
    expect(h.kiro.calls.filter((c) => c.tool === "kiro_answer_permission")).toHaveLength(1);
    h.close();
  });
});

describe("where a hosted session's interrupts belong", () => {
  it("goes by the step that launched it, even when the main conversation names it later", async () => {
    const h = await harness([
      ...baseTurns,
      { match: "the session was", steps: [{ text: "Noted.", delayMs: 0 }] },
    ]);
    const { thread, sessionId } = await launchInThread(h);
    await h.ws.main.submit(`the session was ${sessionId}`);
    h.kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
    h.ws.setVisible([sessionTarget(sessionId)]);
    await h.ws.tick();
    expect(h.projection.ownerOf(sessionTarget(sessionId))).toBe(thread);
    expect(h.ws.conversation(thread).attention()).toHaveLength(1);
    expect(h.ws.main.attention()).toHaveLength(0);
    h.close();
  });

  it("else goes by the conversation that first referenced it", async () => {
    const h = await harness([{ match: "look at", steps: [{ text: "Looking.", delayMs: 0 }] }]);
    h.kiro.sessions.clear();
    const seed = new FakeKiroRemote({
      sessions: [{ id: "01KAHX7Z1M2N3P4Q5R6S7T8V9W", title: "Fix the build", status: "running" }],
    });
    // Point the harness's Kiro at a session that nobody launched.
    for (const [id, s] of seed.sessions) h.kiro.sessions.set(id, s);
    await h.ws.main.submit("hello");
    const parent = h.ws.main.state().messages[0]?.address as string;
    const thread = await h.ws.branch(parent, USER);
    await h.ws.conversation(thread).submit("look at 01KAHX7Z1M2N3P4Q5R6S7T8V9W");
    await h.ws.main.submit("and 01KAHX7Z1M2N3P4Q5R6S7T8V9W again");
    expect(h.projection.ownerOf(sessionTarget("01KAHX7Z1M2N3P4Q5R6S7T8V9W"))).toBe(thread);
    h.close();
  });

  it("else goes to the main conversation", async () => {
    const h = await harness([]);
    expect(h.projection.ownerOf(sessionTarget("01KAHX7Z1M2N3P4Q5R6S7T8V9W"))).toBe(
      h.ws.mainConversation,
    );
    expect(h.projection.ownerOf({ type: "pull-request", id: "a/b/pull/1" })).toBe(
      h.ws.mainConversation,
    );
    h.close();
  });
});

describe("the agent", () => {
  it("is refused kiro_answer_permission by draft's tool policy", async () => {
    const h = await harness([
      {
        match: "answer",
        steps: [
          {
            tool: "kiro_answer_permission",
            input: {
              sessionId: "01KAHX7Z1M2N3P4Q5R6S7T8V9W",
              requestId: "perm-1",
              optionId: "allow_once",
            },
          },
          { text: "Tried.", delayMs: 0 },
        ],
      },
    ]);
    let asked = 0;
    h.ws.main.onChange((c) => {
      if (c.type === "state" && c.state.prompts.length > 0) asked++;
    });
    await h.ws.main.submit("answer it for me");
    expect(asked).toBe(0);
    expect(h.kiro.calls.filter((c) => c.tool === "kiro_answer_permission")).toEqual([]);
    const called = h
      .events()
      .find((e) => e.type === "agent.tool_called") as DraftEvent<"agent.tool_called">;
    expect(called.data).toMatchObject({
      name: "mcp__kiro-remote__kiro_answer_permission",
      decision: "denied-by-policy",
      resultSummary: null,
    });
    expect(h.events().some((e) => e.type === "step.started")).toBe(false);
    h.close();
  });
});

/** A log with three started steps and no completions, as a crash would leave it. */
async function interruptedLog() {
  const dir = mkdtempSync(join(tmpdir(), "draft-interrupted-"));
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const step = (id: string, name: string, input: Record<string, unknown>): EventDraft => ({
    type: "step.started",
    address: `${CONV}/${id}@1`,
    conversation: CONV,
    actor: AGENT,
    traceId: TRACE,
    data: {
      idempotencyKey: `key-${id}`,
      toolUseId: `toolu_${id}`,
      name: `mcp__kiro-remote__${name}`,
      input,
      decision: "approved-by-user",
    },
  });
  await log.append([
    ...genesisDrafts(),
    step("s1", "kiro_launch_session", LAUNCH),
    step("s2", "kiro_cancel_turn", { sessionId: "01KAHX7Z1M2N3P4Q5R6S7T8V9W" }),
    step("s3", "kiro_send_prompt", { sessionId: "01KAHX7Z1M2N3P4Q5R6S7T8V9W", prompt: "hi" }),
  ]);
  log.close();
  return dir;
}

describe("an interrupted step", () => {
  it("is settled as done or failed with one event that names the started step, and stays settled after a restart", async () => {
    const dir = await interruptedLog();
    const kiro = fakeKiro();
    const first = await openService(dir, kiro);
    const open = () =>
      first.service
        .attention()
        .filter((a) => a.cause === "unfinished-step")
        .map((a) => a.id);
    expect(open()).toEqual([`${CONV}/s1@1`, `${CONV}/s2@1`, `${CONV}/s3@1`]);
    await first.service.settleInterrupt(`${CONV}/s2@1`, "done");
    await first.service.settleInterrupt(`${CONV}/s3@1`, "failed");
    expect(open()).toEqual([`${CONV}/s1@1`]);
    const settled = knownEvents(first.log.events()).filter(
      (e): e is DraftEvent<"interrupt.settled"> => e.type === "interrupt.settled",
    );
    expect(settled.map((e) => [e.data.outcome, e.data.started, e.actor.kind])).toEqual([
      ["done", `${CONV}/s2@1`, "user"],
      ["failed", `${CONV}/s3@1`, "user"],
    ]);
    // Nothing was run: settling as done or failed records a decision, it doesn't act.
    expect(kiro.calls.filter((c) => c.tool !== "kiro_get_session")).toEqual([]);
    first.close();

    const second = await openService(dir, kiro);
    expect(
      second.service
        .attention()
        .filter((a) => a.cause === "unfinished-step")
        .map((a) => a.id),
    ).toEqual([`${CONV}/s1@1`]);
    const settledBlock = second.service
      .state()
      .timeline.filter((b) => b.kind === "interrupt" && b.state === "settled");
    expect(settledBlock).toHaveLength(2);
    // The agent's next context no longer lists them as open items.
    expect(buildAgentContext(second.projection, CONV).openItems).toHaveLength(1);
    second.close();
  });

  it("retried starts a new step with a new key, and the old step is never run again", async () => {
    const dir = await interruptedLog();
    const kiro = fakeKiro();
    const first = await openService(dir, kiro);
    await first.service.settleInterrupt(`${CONV}/s1@1`, "retry");

    const launches = kiro.calls.filter((c) => c.tool === "kiro_launch_session");
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args).toEqual(LAUNCH);

    const events = knownEvents(first.log.events());
    const settled = events.find(
      (e) => e.type === "interrupt.settled",
    ) as DraftEvent<"interrupt.settled">;
    const started = events.filter(
      (e): e is DraftEvent<"step.started"> => e.type === "step.started",
    );
    const retry = started.at(-1) as DraftEvent<"step.started">;
    expect(started).toHaveLength(4);
    expect(retry.data.retryOf).toBe(`${CONV}/s1@1`);
    expect(retry.data.idempotencyKey).not.toBe("key-s1");
    expect(retry.actor).toEqual(USER);
    // The settlement and the new step start together: no moment where a second retry could begin.
    expect(settled.data).toMatchObject({
      outcome: "retry",
      started: `${CONV}/s1@1`,
      via: retry.address,
    });
    expect(events.indexOf(settled)).toBeLessThan(events.indexOf(retry));
    expect(events.at(-1)?.type).toBe("step.completed");

    // Neither another settlement, a restart nor a poll runs it again.
    await expect(first.service.settleInterrupt(`${CONV}/s1@1`, "retry")).rejects.toThrow(
      /already settled/,
    );
    first.close();
    const second = await openService(dir, kiro);
    await second.service.tick();
    expect(kiro.calls.filter((c) => c.tool === "kiro_launch_session")).toHaveLength(1);
    expect(
      second.service
        .attention()
        .filter((a) => a.cause === "unfinished-step")
        .map((a) => a.id),
    ).toEqual([`${CONV}/s2@1`, `${CONV}/s3@1`]);
    second.close();
  });

  it("a retry that fails at Kiro Remote is a failed step of its own", async () => {
    const dir = await interruptedLog();
    const kiro = fakeKiro();
    const first = await openService(dir, kiro);
    kiro.failNext = 1;
    await first.service.settleInterrupt(`${CONV}/s2@1`, "retry");
    // The retry reached Kiro Remote and failed there: a failed step of its own, to settle again.
    const failed = first.service.attention().filter((a) => a.cause === "failed-step");
    expect(failed).toHaveLength(1);
    expect(kiro.calls.filter((c) => c.tool === "kiro_cancel_turn")).toHaveLength(1);
    first.close();
  });

  it("refuses to retry what draft never runs for you", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-interrupted-"));
    const log = FileLogStore.open(join(dir, "log.jsonl"));
    await log.append([
      ...genesisDrafts(),
      {
        type: "step.started",
        address: `${CONV}/s1@1`,
        conversation: CONV,
        actor: AGENT,
        traceId: TRACE,
        data: {
          idempotencyKey: "k",
          toolUseId: "t",
          name: "mcp__other__delete_everything",
          input: {},
          decision: "approved-by-user",
        },
      },
    ]);
    log.close();
    const o = await openService(dir, fakeKiro());
    await expect(o.service.settleInterrupt(`${CONV}/s1@1`, "retry")).rejects.toThrow(/won't run/);
    o.close();
  });
});

describe("a failed step", () => {
  it("is a failure to acknowledge or retry, until a person does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-failed-"));
    const kiro = fakeKiro();
    const o = await openService(
      dir,
      kiro,
      script([
        {
          match: "go",
          steps: [
            {
              tool: "kiro_send_prompt",
              input: { sessionId: "01KAHXZZZZZZZZZZZZZZZZZZZZ", prompt: "hi" },
            },
          ],
        },
      ]),
    );
    o.service.onChange((c) => {
      if (c.type === "state")
        for (const p of c.state.prompts) queueMicrotask(() => o.service.answerPrompt(p.id, true));
    });
    await o.service.submit("go");
    const [item] = o.service.attention();
    expect(item).toMatchObject({ cause: "failed-step" });
    expect(item?.id).toMatch(/^failed:/);
    await o.service.settleInterrupt(item?.id as string, "acknowledged");
    expect(o.service.attention()).toEqual([]);
    const settled = knownEvents(o.log.events()).find(
      (e) => e.type === "interrupt.settled",
    ) as DraftEvent<"interrupt.settled">;
    expect(settled.data.started).toMatch(/\/.+@1$/);
    expect(settled.data.kind).toBe("failed-step");
    o.close();
  });
});

describe("pull request events", () => {
  const REPO = "nikovirtala/draft";
  const PR: Target = { type: "pull-request", id: `${REPO}/pull/7` };

  it("become interrupts where the pull request is referenced, and clear when they stop holding", async () => {
    const h = await harness([]);
    h.github.addPull(REPO, 7, {
      checks: [
        { name: "build", conclusion: "success" },
        { name: "e2e", conclusion: "failure" },
      ],
      mergeable: false,
      mergeableState: "dirty",
      reviews: [{ id: 11, user: "reviewer", state: "CHANGES_REQUESTED" }],
      requestedReviewers: ["niko"],
    });
    await h.ws.main.submit(`please look at ${REPO}#7`);
    const causes = () => h.ws.main.attention().map((a) => a.cause);
    expect(causes()).toEqual([
      "failed-check",
      "merge-conflict",
      "changes-requested",
      "review-requested",
    ]);
    // Everything the reference says is also in its snapshot: what acceptance will need.
    const snapshot = h.ws.main.state().messages[0]?.references[0]?.snapshot as Record<
      string,
      unknown
    >;
    expect(snapshot).toMatchObject({
      state: "open",
      mergeableState: "dirty",
      checksSummary: { total: 2, passed: 1, failed: 1, pending: 0 },
      review: { decision: "changes_requested" },
      viewerReviewRequested: true,
    });
    expect(
      (snapshot.checks as { name: string; conclusion: string }[]).map((c) => [
        c.name,
        c.conclusion,
      ]),
    ).toEqual([
      ["build", "success"],
      ["e2e", "failure"],
    ]);

    // The check passes and the conflict is resolved: both interrupts clear on the next poll.
    h.github.updatePull(REPO, 7, {
      checks: [
        { name: "build", conclusion: "success" },
        { name: "e2e", conclusion: "success" },
      ],
      mergeable: true,
      mergeableState: "clean",
    });
    h.ws.setVisible([PR]);
    await h.ws.tick();
    expect(causes()).toEqual(["changes-requested", "review-requested"]);
    const cleared = h.events().filter((e) => e.type === "interrupt.cleared");
    expect(cleared).toHaveLength(2);

    // A new push that fails again is a new interrupt; settling is as you.
    h.github.updatePull(REPO, 7, {
      headSha: `b${"0".repeat(39)}`,
      checks: [{ name: "e2e", conclusion: "failure" }],
    });
    await h.ws.tick();
    // Oldest first within a rank: the review that asked for changes arose before the new failure.
    expect(causes()).toEqual(["changes-requested", "failed-check", "review-requested"]);
    const key = h.ws.main.attention()[1]?.id as string;
    await h.ws.main.settleInterrupt(key, "acknowledged");
    expect(causes()).toEqual(["changes-requested", "review-requested"]);
    // The same failed check on the same commit stays settled when it is seen again.
    await h.ws.tick();
    expect(causes()).toEqual(["changes-requested", "review-requested"]);
    const settled = h
      .events()
      .find((e) => e.type === "interrupt.settled") as DraftEvent<"interrupt.settled">;
    expect(settled.actor).toEqual(USER);
    h.close();
  });

  it("only ever reads from GitHub", async () => {
    const h = await harness([]);
    h.github.addPull(REPO, 7, { checks: [{ name: "e2e", conclusion: "failure" }] });
    await h.ws.main.submit(`${REPO}#7`);
    await h.ws.main.settleInterrupt(h.ws.main.attention()[0]?.id as string, "acknowledged");
    expect(h.github.requests.length).toBeGreaterThan(0);
    expect(h.github.requests.every((r) => r.method === "GET")).toBe(true);
    h.close();
  });
});

describe("one attention order across conversations", () => {
  it("puts a hosted permission first, then failures, then reviews, across conversations", async () => {
    const REPO = "nikovirtala/draft";
    const h = await harness(baseTurns);
    h.github.addPull(REPO, 7, {
      checks: [{ name: "e2e", conclusion: "failure" }],
      requestedReviewers: ["niko"],
    });
    const { thread, sessionId } = await launchInThread(h);
    await h.ws.main.submit(`and ${REPO}#7`);
    h.kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
    h.ws.setVisible([sessionTarget(sessionId)]);
    await h.ws.tick();
    // An interrupted step in the main conversation, older than the permission.
    expect(
      h.ws.attention().map((a) => [a.conversation === thread ? "thread" : "main", a.cause]),
    ).toEqual([
      ["thread", "permission"],
      ["main", "failed-check"],
      ["main", "review-requested"],
    ]);
    h.close();
  });
});

describe("a thread wraps up", () => {
  const turns: FakeScript["turns"] = [
    { match: "^start$", steps: [{ text: "Started.", delayMs: 0 }] },
    { match: "first idea", steps: [{ text: "Fine.", delayMs: 0 }] },
    {
      match: "wrap this up",
      steps: [
        { text: "We chose the polling resolver, and the PR is ready for review.", delayMs: 0 },
      ],
    },
    { match: "wrap this up", steps: [{ text: "We chose polling. Nothing is open.", delayMs: 0 }] },
  ];

  async function thread() {
    const h = await harness(turns);
    await h.ws.main.submit("start");
    const parent = h.ws.main.state().messages[0]?.address as string;
    const conversation = await h.ws.branch(parent, USER);
    const svc = h.ws.conversation(conversation);
    await svc.submit("first idea");
    return { h, conversation, svc, parent };
  }

  it("drafts a conclusion when asked, and you confirm it with one action", async () => {
    const { h, conversation, svc, parent } = await thread();
    expect(svc.threadState()?.state).toBe("open");
    await svc.submit("wrap this up");
    const fold = svc.threadState();
    expect(fold?.state).toBe("concluding");
    expect(fold?.conclusion?.text).toContain("polling resolver");
    expect(fold?.conclusion?.cites).toMatchObject({ thread: conversation, parent });
    expect(fold?.conclusion?.cites.messages).toBe(4);
    const proposed = h.events().find((e) => e.type === "thread.conclusion_proposed");
    expect(proposed?.actor.kind).toBe("agent");
    // It waits on you: in the attention order, and on the thread's stub.
    expect(svc.attention().map((a) => a.cause)).toEqual(["conclusion"]);
    expect(h.ws.threads()[0]).toMatchObject({ state: "concluding", waiting: 1 });

    await svc.confirmConclusion();
    expect(svc.threadState()?.state).toBe("wrapped-up");
    const wrapped = h
      .events()
      .find((e) => e.type === "thread.wrapped_up") as DraftEvent<"thread.wrapped_up">;
    expect(wrapped.actor).toEqual(USER);
    expect(wrapped.data).toMatchObject({
      returnedTo: h.ws.mainConversation,
      proposal: fold?.conclusion?.address,
    });
    // It is in the main conversation at the thread's stub, citing the thread.
    expect(h.ws.threads()[0]).toMatchObject({
      state: "wrapped-up",
      waiting: 0,
      parent,
      conclusion: {
        text: expect.stringContaining("polling resolver"),
        cites: { thread: conversation },
      },
    });
    expect(svc.attention()).toEqual([]);
    // The main conversation's agent is told what the thread concluded.
    const ctx = buildAgentContext(h.projection, h.ws.mainConversation);
    expect(ctx.conclusions).toMatchObject([
      { thread: conversation, text: expect.stringContaining("polling") },
    ]);
    // A thread that wrapped up takes no more turns.
    await expect(svc.submit("one more thing")).rejects.toThrow(/ended/);
    h.close();
  });

  it("can be declined: the thread is open again and the agent drafts another", async () => {
    const { h, svc } = await thread();
    await svc.submit("wrap this up");
    await svc.declineConclusion();
    expect(svc.threadState()).toMatchObject({ state: "open", conclusion: null });
    await svc.submit("wrap it up");
    expect(svc.threadState()?.state).toBe("concluding");
    h.close();
  });

  it("is not wrapped up by anyone but you, and not before there is a conclusion", async () => {
    const { h, svc } = await thread();
    await expect(svc.confirmConclusion()).rejects.toThrow(/not allowed/);
    h.close();
  });

  it("can be ended as superseded or withdrawn, with a reason", async () => {
    const { h, svc } = await thread();
    await expect(svc.endThread("withdrawn", "  ")).rejects.toThrow(/needs a reason/);
    await svc.endThread("withdrawn", "the question went away");
    expect(svc.threadState()).toMatchObject({
      state: "withdrawn",
      endedReason: "the question went away",
    });
    const ended = h.events().find((e) => e.type === "thread.ended") as DraftEvent<"thread.ended">;
    expect(ended.actor).toEqual(USER);
    await expect(svc.submit("hello")).rejects.toThrow(/ended/);
    h.close();
  });

  it("only a thread has a conclusion", async () => {
    const { h } = await thread();
    await expect(h.ws.main.confirmConclusion()).rejects.toThrow(/not a thread/);
    h.close();
  });

  it("survives a restart from the log alone", async () => {
    const { h, svc, conversation } = await thread();
    await svc.submit("wrap this up");
    await svc.confirmConclusion();
    const lines = readFileSync(h.log.path, "utf8");
    expect(lines).toContain("thread.wrapped_up");
    const fresh = Projection.open();
    fresh.sync(h.log.events());
    expect(fresh.thread(conversation).state).toBe("wrapped-up");
    h.close();
  });
});
