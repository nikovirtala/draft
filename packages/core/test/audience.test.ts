import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeScript } from "../src/agent.ts";
import { buildAgentContext, renderAgentContext } from "../src/agent-context.ts";
import type { ConversationService } from "../src/conversation.ts";
import {
  type DraftEvent,
  knownEvents,
  PEOPLE_AND_AGENT,
  PEOPLE_ONLY,
  sealEvent,
} from "../src/events.ts";
import { Projection } from "../src/projection.ts";
import { appendRawLines } from "../src/testing/index.ts";
import { fakeKiro, openService, RUNNING } from "./fixtures.ts";
import { CONV, genesisDrafts, SYSTEM, testClock } from "./helpers.ts";

const MARKER = "zanzibar-marker-7731";

const script = (turns: FakeScript["turns"]): FakeScript => ({
  turns,
  fallback: "Nothing scripted.",
});
const LAUNCH = { prompt: "Fix the flaky test", repos: ["nikovirtala/draft"], title: "Fix it" };

function autoAnswer(service: ConversationService, allow = true): void {
  service.onChange((c) => {
    if (c.type !== "state") return;
    for (const p of c.state.prompts) queueMicrotask(() => service.answerPrompt(p.id, allow));
  });
}

const messages = (events: readonly ReturnType<typeof knownEvents>[number][]) =>
  events.filter((e): e is DraftEvent<"message.posted"> => e.type === "message.posted");

async function open(turns: FakeScript["turns"] = []) {
  const dir = mkdtempSync(join(tmpdir(), "draft-audience-"));
  const opened = await openService(dir, fakeKiro(), script(turns));
  return { dir, ...opened };
}

describe("audience", () => {
  it("is data on every message: people and the agent while the agent is active", async () => {
    const o = await open();
    await o.service.submit("hello");
    const posted = messages(knownEvents(o.log.events()));
    expect(posted.map((e) => [e.data.role, "audience" in e.data ? e.data.audience : null])).toEqual(
      [
        ["user", PEOPLE_AND_AGENT],
        ["agent", PEOPLE_AND_AGENT],
      ],
    );
    expect(posted.every((e) => e.schema === 2)).toBe(true);
    o.close();
  });

  it("keeps an aside from the agent: no turn, and its words reach the agent in no later turn either", async () => {
    const o = await open([
      { match: "sessions", steps: [{ text: "Here you go.", delayMs: 0 }] },
      { match: "more", steps: [{ text: "Sure.", delayMs: 0 }] },
    ]);
    await o.service.submit("Which sessions are open?");
    expect(o.agent.received).toHaveLength(1);

    // The aside mentions a session, so it also makes a reference, which must not reach the agent.
    await o.service.submit(`${MARKER} should we ask about ${RUNNING}?`, { aside: true });
    expect(o.agent.received).toHaveLength(1);
    const state = o.service.state();
    const aside = state.messages.find((m) => m.text.includes(MARKER));
    expect(aside?.audience).toEqual(PEOPLE_ONLY);
    expect(aside?.references.map((r) => r.id)).toEqual([RUNNING]);

    await o.service.submit("tell me more");
    expect(o.agent.received).toHaveLength(2);
    const seen = JSON.stringify(o.agent.received);
    expect(seen).not.toContain(MARKER);
    const second = o.agent.received[1];
    expect(second?.context.messages.map((m) => m.text)).toEqual([
      "Which sessions are open?",
      "Here you go.",
    ]);
    // The reference came from the aside alone, so it isn't in play for the agent.
    expect(second?.context.references).toEqual([]);
    expect(renderAgentContext(second?.context as never)).not.toContain(MARKER);
    // Everything is in the log all the same.
    expect(JSON.stringify([...o.log.events()])).toContain(MARKER);
    o.close();
  });

  it("is enforced where the context is built, whatever wrote the message", async () => {
    // A people-only message with the agent's role, and one written by an older build.
    const o = await open();
    const projection = Projection.open();
    const clock = testClock();
    const events = [
      ...genesisDrafts(),
      {
        type: "message.posted" as const,
        address: `${CONV}/a1@1`,
        conversation: CONV,
        actor: SYSTEM,
        traceId: null,
        data: { role: "agent" as const, text: `${MARKER} agent aside`, audience: PEOPLE_ONLY },
      },
      {
        type: "message.posted" as const,
        address: `${CONV}/a2@1`,
        conversation: CONV,
        actor: SYSTEM,
        traceId: null,
        data: { role: "user" as const, text: "visible", audience: PEOPLE_AND_AGENT },
      },
    ].map((d, i) =>
      sealEvent(d, {
        id: clock.newId(),
        at: new Date(clock.now() + i).toISOString(),
        prevHash: "0".repeat(64),
      }),
    );
    // sealEvent chains to whatever prevHash it is given; the projection doesn't verify chains.
    projection.applyAll(events);
    const context = buildAgentContext(projection, CONV);
    expect(context.messages.map((m) => m.text)).toEqual(["visible"]);
    expect(context.omittedMessages).toBe(0);
    expect(JSON.stringify(context)).not.toContain(MARKER);
    o.close();
  });

  it("reads a message from before audiences existed as one for people and the agent", async () => {
    const o = await open();
    const conversation = o.service.conversation;
    o.close();
    const path = join(o.dir, "log.jsonl");
    const raw = {
      id: "01M8000000000000000000000A",
      at: "2026-11-21T09:00:00.000Z",
      address: `${conversation}/01m8000000000000000000000a@1`,
      conversation,
      type: "message.posted",
      schema: 1,
      actor: { kind: "user", id: "01kahx0000000000000000user", name: "Test User" },
      traceId: null,
      data: { role: "user", text: "from an older build" },
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, appendRawLines(readFileSync(path, "utf8"), [raw]));
    const again = await openService(o.dir, fakeKiro(), script([]));
    const m = again.service.state().messages[0];
    expect(m?.text).toBe("from an older build");
    expect(m?.audience).toEqual(PEOPLE_AND_AGENT);
    expect(buildAgentContext(again.projection, conversation).messages).toHaveLength(1);
    again.close();
  });
});

describe("pause and play", () => {
  it("is an event; a paused conversation starts no turn, and posts for people only", async () => {
    const o = await open([{ match: "hello", steps: [{ text: "Hi.", delayMs: 0 }] }]);
    expect(o.service.state().agent.state).toBe("active");
    await o.service.setAgentState("paused");
    expect(o.service.state().agent.state).toBe("paused");
    const changed = knownEvents(o.log.events()).filter((e) => e.type === "agent.state_changed");
    expect(changed.map((e) => e.data)).toEqual([{ state: "paused" }]);
    expect(changed[0]?.actor.kind).toBe("user");

    await o.service.submit(`${MARKER} among ourselves`);
    expect(o.agent.received).toHaveLength(0);
    const state = o.service.state();
    expect(state.messages.map((m) => [m.role, m.audience])).toEqual([["user", PEOPLE_ONLY]]);
    expect(state.busy).toBe(false);

    // Playing again restores the default, and the paused chatter still doesn't reach the agent.
    await o.service.setAgentState("active");
    await o.service.submit("hello");
    expect(o.agent.received).toHaveLength(1);
    expect(JSON.stringify(o.agent.received)).not.toContain(MARKER);
    o.close();
  });

  it("is kept across a restart", async () => {
    const o = await open();
    await o.service.setAgentState("paused");
    o.close();
    const again = await openService(o.dir, fakeKiro(), script([]));
    expect(again.service.state().agent.state).toBe("paused");
    await again.service.submit("anyone there?");
    expect(again.agent.received).toHaveLength(0);
    again.close();
  });

  it("lets @agent through for that one message, and for its turn", async () => {
    const o = await open([{ match: "which", steps: [{ text: "Two.", delayMs: 0 }] }]);
    await o.service.setAgentState("paused");
    await o.service.submit("so which sessions are open @agent?");
    expect(o.agent.received).toHaveLength(1);
    expect(o.service.state().agent.state).toBe("paused");
    // The next message is back to people only.
    await o.service.submit("thanks, now let's talk it over");
    expect(o.agent.received).toHaveLength(1);
    const audiences = o.service.state().messages.map((m) => [m.role, m.audience.agent]);
    expect(audiences).toEqual([
      ["user", true],
      ["agent", true],
      ["user", false],
    ]);
    // An aside beats a mention.
    await o.service.submit("@agent never mind", { aside: true });
    expect(o.agent.received).toHaveLength(1);
    // @agent as part of an address or a longer word doesn't count.
    await o.service.submit("mail me at x@agentless.dev");
    await o.service.submit("see @agents");
    expect(o.agent.received).toHaveLength(1);
    o.close();
  });

  it("starts no step in a paused conversation, except for a turn @agent started", async () => {
    const o = await open([
      {
        match: "launch",
        steps: [
          { tool: "kiro_launch_session", input: LAUNCH },
          { text: "Done.", delayMs: 0 },
        ],
      },
    ]);
    await o.service.setAgentState("paused");
    autoAnswer(o.service);
    await o.service.submit("launch a session @agent");
    // The addressed turn may ask, and the person's answer begins the step.
    const types = knownEvents(o.log.events()).map((e) => e.type);
    expect(types).toContain("step.started");
    expect(types).toContain("step.completed");
    o.close();
  });

  it("pausing a running turn cancels it and refuses its step", async () => {
    const o = await open([
      {
        match: "launch",
        steps: [
          { tool: "kiro_launch_session", input: LAUNCH },
          { text: "Done.", delayMs: 0 },
        ],
      },
    ]);
    const turn = o.service.submit("launch a session");
    await new Promise<void>((resolve) => {
      const off = o.service.onChange((c) => {
        if (c.type === "state" && c.state.prompts.length > 0) {
          off();
          resolve();
        }
      });
    });
    await o.service.setAgentState("paused");
    await turn;
    const types = knownEvents(o.log.events()).map((e) => e.type);
    expect(types).not.toContain("step.started");
    expect(o.service.state().prompts).toEqual([]);
    expect(o.service.state().busy).toBe(false);
    o.close();
  });
});

describe("the projection a session starts from", () => {
  it("names the steps that were interrupted, so the agent doesn't repeat them blindly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-restart-"));
    const before = fakeKiro();
    const inner = before.asTools();
    const hanging = {
      call: (tool: string, args: Record<string, unknown>) => {
        if (tool !== "kiro_launch_session") return inner.call(tool, args);
        void inner.call(tool, args);
        return new Promise<never>(() => {});
      },
    };
    const first = await openService(
      dir,
      before,
      script([{ match: "launch", steps: [{ tool: "kiro_launch_session", input: LAUNCH }] }]),
      hanging,
    );
    autoAnswer(first.service);
    void first.service.submit("launch please");
    await new Promise((r) => setTimeout(r, 200));
    first.close(); // the crash

    const second = await openService(
      dir,
      fakeKiro(),
      script([{ match: "again", steps: [{ text: "Checking first.", delayMs: 0 }] }]),
    );
    await second.service.submit("do it again");
    const context = second.agent.received[0]?.context;
    expect(context?.openItems).toEqual([
      expect.objectContaining({
        kind: "interrupted-step",
        tool: "mcp__kiro-remote__kiro_launch_session",
        input: LAUNCH,
      }),
    ]);
    expect(context?.decisions).toEqual([
      expect.objectContaining({ decision: "approved-by-user", outcome: "interrupted" }),
    ]);
    const text = renderAgentContext(context as never);
    expect(text).toContain("INTERRUPTED: mcp__kiro-remote__kiro_launch_session");
    expect(text).toContain("It may or may not have happened");
    // The earlier user message is there; the message being sent is not repeated in the context.
    expect(context?.messages.map((m) => m.text)).toEqual(["launch please"]);
    second.close();
  });

  it("is one function: the same log gives the same context, for a restart or another agent", async () => {
    const o = await open([{ match: "sessions", steps: [{ text: `See ${RUNNING}.`, delayMs: 0 }] }]);
    await o.service.submit("Which sessions?");
    const a = buildAgentContext(o.projection, o.service.conversation);
    const rebuilt = Projection.open();
    rebuilt.rebuild(o.log.events());
    expect(buildAgentContext(rebuilt, o.service.conversation)).toEqual(a);
    expect(a.references.map((r) => r.target)).toEqual([`kiro-session:${RUNNING}`]);
    o.close();
  });

  it("is compact: old messages are left out and counted, long ones are cut", async () => {
    const o = await open([{ match: ".", steps: [{ text: "ok", delayMs: 0 }] }]);
    for (let i = 0; i < 4; i++) await o.service.submit(`message number ${i} ${"x".repeat(50)}`);
    const c = buildAgentContext(o.projection, o.service.conversation, {
      limits: { maxMessages: 3, maxMessageChars: 20 },
    });
    expect(c.messages).toHaveLength(3);
    expect(c.omittedMessages).toBe(5);
    expect(c.messages.every((m) => m.text.length <= 20 + 40)).toBe(true);
    expect(renderAgentContext(c)).toContain("5 earlier ones left out");
    o.close();
  });
});

describe("a call that ran without asking", () => {
  it("is logged as an anomaly and shows as an interrupt, with no step before it", async () => {
    const o = await open([
      {
        match: "go",
        steps: [
          { unasked: "kiro_delete_session", input: { sessionId: RUNNING } },
          { text: "Done.", delayMs: 0 },
        ],
      },
    ]);
    await o.service.submit("go");
    const events = knownEvents(o.log.events());
    const anomaly = events.find((e) => e.type === "agent.anomaly") as DraftEvent<"agent.anomaly">;
    expect(anomaly.data).toMatchObject({
      kind: "call-without-permission",
      name: "mcp__kiro-remote__kiro_delete_session",
      input: { sessionId: RUNNING },
      status: "in_progress",
    });
    expect(anomaly.actor.kind).toBe("agent");
    expect(events.some((e) => e.type === "step.started")).toBe(false);
    const block = o.service.state().timeline.find((b) => b.kind === "interrupt");
    expect(block).toMatchObject({
      kind: "interrupt",
      cause: "unasked-call",
      tool: "mcp__kiro-remote__kiro_delete_session",
      idempotencyKey: null,
    });
    o.close();
    // It is derived from the log, so it is still there after a restart, and it reaches the agent.
    const again = await openService(
      o.dir,
      fakeKiro(),
      script([{ match: "x", steps: [{ text: "ok", delayMs: 0 }] }]),
    );
    expect(again.service.state().timeline.filter((b) => b.kind === "interrupt")).toHaveLength(1);
    await again.service.submit("x");
    expect(again.agent.received[0]?.context.openItems).toEqual([
      expect.objectContaining({ kind: "call-without-permission" }),
    ]);
    again.close();
  });
});
