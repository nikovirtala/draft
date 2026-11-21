import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { toolIdentity } from "../src/main/acp/tools.ts";
import { modelFromConfig, TurnMapper } from "../src/main/acp/turn.ts";
import { recordingHooks } from "./acp-helpers.ts";

const OPTIONS: RequestPermissionRequest["options"] = [
  { optionId: "accept", name: "Allow", kind: "allow_once" },
  { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Deny", kind: "reject_once" },
  { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
];

const kiroMeta = (tool: string, server = "kiro-remote") => ({
  kiro: { mcpTool: { version: 1, identity: { serverName: server, toolName: tool } } },
});

function mapper(allow = true) {
  const events: AgentEvent[] = [];
  const r = recordingHooks(allow);
  const m = new TurnMapper(r.hooks, (e) => events.push(e));
  return { m, events, ...r };
}

const request = (
  toolCallId: string,
  tool: string,
  o: Partial<RequestPermissionRequest> = {},
): RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: {
    toolCallId,
    title: `@kiro-remote/${tool}`,
    rawInput: { a: 1 },
    _meta: kiroMeta(tool),
  },
  options: OPTIONS,
  ...o,
});

describe("a person's acts are refused whichever MCP server the agent has", () => {
  it.each([
    ["adr", "adr_accept"],
    ["adr", "adr_reject"],
    ["github", "merge_pull_request"],
    ["github", "approve_pull_request"],
    ["kiro-remote", "kiro_answer_permission"],
  ])("%s %s: refused with one-time reject, never asked, no step", async (server, tool) => {
    const t = mapper(true);
    const answer = await t.m.onPermissionRequest({
      sessionId: "s",
      toolCall: {
        toolCallId: "p1",
        title: `@${server}/${tool}`,
        rawInput: { id: "9p8jj6p5" },
        _meta: kiroMeta(tool, server),
      },
      options: OPTIONS,
    });
    expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(t.asked).toEqual([]);
    expect(t.steps).toEqual([]);
    expect(t.events).toEqual([
      expect.objectContaining({ type: "tool-call", decision: "denied-by-policy" }),
      expect.objectContaining({
        type: "tool-result",
        isError: true,
        text: expect.stringMatching(/person's act/),
      }),
    ]);
  });

  it("a server's other tools are still just not available", async () => {
    const t = mapper(true);
    await t.m.onPermissionRequest({
      sessionId: "s",
      toolCall: {
        toolCallId: "p2",
        title: "@adr/adr_propose",
        rawInput: {},
        _meta: kiroMeta("adr_propose", "adr"),
      },
      options: OPTIONS,
    });
    expect(t.events.at(-1)).toMatchObject({
      text: expect.stringMatching(/not available in draft/),
    });
  });
});

describe("permission requests to steps", () => {
  it("a call that changes something asks the person, begins its step, then answers allow_once", async () => {
    const t = mapper(true);
    t.m.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "@kiro-remote/kiro_launch_session",
      status: "pending",
      rawInput: { prompt: "x" },
      _meta: kiroMeta("kiro_launch_session"),
    });
    const answer = await t.m.onPermissionRequest(
      request("c1", "kiro_launch_session", {
        // Kiro's consent context sits beside the identity and must not hide it.
        _meta: { kiro: { consent: { capability: "mcp" } } },
        toolCall: { toolCallId: "c1", status: "pending" },
      }),
    );
    expect(t.asked).toEqual(["mcp__kiro-remote__kiro_launch_session"]);
    expect(t.steps).toEqual(["mcp__kiro-remote__kiro_launch_session"]);
    expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "accept" } });
    expect(t.events).toEqual([
      {
        type: "tool-call",
        toolUseId: "c1",
        name: "mcp__kiro-remote__kiro_launch_session",
        input: { prompt: "x" },
        decision: "approved-by-user",
      },
    ]);
    // The update that reports it done becomes the step's completion.
    t.m.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" });
    t.m.onUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: '{"sessionId":"S1"}' } }],
    });
    expect(t.events.at(-1)).toEqual({
      type: "tool-result",
      toolUseId: "c1",
      isError: false,
      text: '{"sessionId":"S1"}',
      structured: { sessionId: "S1" },
      decision: "approved-by-user",
    });
  });

  it("a failed update becomes a failed result", async () => {
    const t = mapper(true);
    await t.m.onPermissionRequest(request("c1", "kiro_send_prompt"));
    t.m.onUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
      rawOutput: { error: "no such session" },
    });
    expect(t.events.at(-1)).toMatchObject({
      type: "tool-result",
      isError: true,
      text: '{"error":"no such session"}',
    });
  });

  it("a declined call starts no step and answers reject_once", async () => {
    const t = mapper(false);
    const answer = await t.m.onPermissionRequest(request("c1", "kiro_delete_session"));
    expect(t.steps).toEqual([]);
    expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(t.events.map((e) => e.type)).toEqual(["tool-call", "tool-result"]);
    expect(t.events[0]).toMatchObject({ decision: "denied-by-user" });
  });

  it("a read-only Kiro Remote tool runs without asking the person", async () => {
    const t = mapper(true);
    const answer = await t.m.onPermissionRequest(request("c1", "kiro_list_sessions"));
    expect(t.asked).toEqual([]);
    expect(t.steps).toEqual([]);
    expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "accept" } });
    expect(t.events[0]).toMatchObject({ decision: "allowed-read-only" });
  });

  it("never picks an option that saves a rule, and refuses when there is no one-time allow", async () => {
    const t = mapper(true);
    const answer = await t.m.onPermissionRequest(
      request("c1", "kiro_launch_session", {
        options: OPTIONS.filter((o) => o.kind !== "allow_once"),
      }),
    );
    expect(t.asked).toEqual([]);
    expect(t.steps).toEqual([]);
    expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(t.events[0]).toMatchObject({ decision: "denied-by-policy" });
  });

  it("refuses a tool that isn't Kiro Remote's without asking, whatever its title says", async () => {
    for (const toolCall of [
      { toolCallId: "c1", title: "@kiro-remote/kiro_launch_session", kind: "execute" as const },
      { toolCallId: "c2", title: "x", _meta: kiroMeta("kiro_launch_session", "evil-server") },
      { toolCallId: "c3", title: "x", name: "kiro_launch_session" },
    ]) {
      const t = mapper(true);
      const answer = await t.m.onPermissionRequest({ sessionId: "s", toolCall, options: OPTIONS });
      expect(t.asked).toEqual([]);
      expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
      expect(t.events[0]).toMatchObject({ decision: "denied-by-policy" });
    }
  });

  it("does not ask twice when the agent asks again about the same call", async () => {
    const t = mapper(true);
    await t.m.onPermissionRequest(request("c1", "kiro_launch_session"));
    const again = await t.m.onPermissionRequest(request("c1", "kiro_launch_session"));
    expect(t.asked).toHaveLength(1);
    expect(t.steps).toHaveLength(1);
    expect(again).toEqual({ outcome: { outcome: "selected", optionId: "accept" } });
  });

  it("answers cancelled once the turn is cancelled", async () => {
    const t = mapper(true);
    t.m.cancelled = true;
    expect(await t.m.onPermissionRequest(request("c1", "kiro_launch_session"))).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(t.asked).toEqual([]);
  });

  it("refuses when the step can't be recorded, so the call never runs", async () => {
    const events: AgentEvent[] = [];
    const m = new TurnMapper(
      {
        confirmTool: async () => ({ allow: true }),
        beginStep: async () => {
          throw new Error("disk full");
        },
      },
      (e) => events.push(e),
    );
    const answer = await m.onPermissionRequest(request("c1", "kiro_launch_session"));
    expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(events[0]).toMatchObject({ decision: "denied-by-policy" });
  });
});

describe("a tool_call without a permission request", () => {
  it("that changes something is an anomaly as soon as it runs", () => {
    const t = mapper();
    t.m.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "@kiro-remote/kiro_delete_session",
      status: "pending",
      rawInput: { sessionId: "S" },
      _meta: kiroMeta("kiro_delete_session"),
    });
    // Pending isn't running: the agent may still ask.
    expect(t.events).toEqual([]);
    t.m.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" });
    expect(t.events).toEqual([
      {
        type: "anomaly",
        toolUseId: "c1",
        name: "mcp__kiro-remote__kiro_delete_session",
        input: { sessionId: "S" },
        status: "in_progress",
      },
    ]);
    // Its completion adds nothing: there is no step for it to complete.
    t.m.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
    expect(t.events).toHaveLength(1);
  });

  it("is an anomaly when it is first seen already completed", () => {
    const t = mapper();
    t.m.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Write file",
      kind: "edit",
      status: "completed",
    });
    expect(t.events).toEqual([
      expect.objectContaining({ type: "anomaly", name: "Write file", status: "completed" }),
    ]);
  });

  it("that only reads is logged as read-only, not as an anomaly", () => {
    const t = mapper();
    t.m.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "list",
      status: "in_progress",
      _meta: kiroMeta("kiro_list_sessions"),
    });
    t.m.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c2",
      title: "grep",
      kind: "search",
      status: "completed",
    });
    expect(t.events.map((e) => [e.type, "decision" in e ? e.decision : null])).toEqual([
      ["tool-call", "allowed-read-only"],
      ["tool-call", "allowed-read-only"],
      ["tool-result", "allowed-read-only"],
    ]);
  });

  it("of another server's MCP tool is an anomaly even if its kind says read", () => {
    const t = mapper();
    t.m.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "x",
      kind: "read",
      status: "in_progress",
      _meta: { claudeCode: { toolName: "mcp__other__wipe" } },
    });
    expect(t.events[0]).toMatchObject({ type: "anomaly", name: "mcp__other__wipe" });
  });
});

describe("Kiro's own tool loading", () => {
  const load = (
    title = "Tool Load",
    input: Record<string, unknown> = { id: "tool::kiro-remote::kiro_list_sessions" },
  ) => ({
    sessionUpdate: "tool_call" as const,
    toolCallId: "c1",
    title,
    kind: "other" as const,
    status: "in_progress" as const,
    rawInput: input,
    _meta: { kiro: { toolOrigin: "default" } },
  });

  it("is read-only for Kiro, recognized by its shape", () => {
    const events: AgentEvent[] = [];
    const m = new TurnMapper(recordingHooks().hooks, (e) => events.push(e), "kiro");
    m.onUpdate(load());
    expect(events[0]).toMatchObject({
      type: "tool-call",
      name: "kiro:tool_load",
      decision: "allowed-read-only",
    });
  });

  it("is still an anomaly with another input, another title, or another agent", () => {
    for (const [kind, update] of [
      ["kiro", load("Tool Load", { id: "tool::kiro-remote::kiro_list_sessions", extra: 1 })],
      ["kiro", load("Write", { id: "tool::kiro-remote::kiro_list_sessions" })],
      ["generic", load()],
    ] as const) {
      const events: AgentEvent[] = [];
      const m = new TurnMapper(recordingHooks().hooks, (e) => events.push(e), kind);
      m.onUpdate(update);
      expect(events[0]?.type).toBe("anomaly");
    }
  });
});

describe("streamed text and usage", () => {
  it("streams chunks, and starts a new paragraph for a new message", () => {
    const t = mapper();
    const chunk = (text: string, messageId: string) =>
      t.m.onUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      });
    chunk("Let me ", "m1");
    chunk("look.", "m1");
    chunk("Found it.", "m2");
    expect(t.m.fullText).toBe("Let me look.\n\nFound it.");
    expect(t.events.map((e) => (e.type === "text-delta" ? e.text : ""))).toEqual([
      "Let me ",
      "look.",
      "\n\nFound it.",
    ]);
  });

  it("records only what the agent reports", () => {
    const t = mapper();
    expect(t.m.collectedUsage()).toBeNull();
    t.m.onUpdate({
      sessionUpdate: "session_info_update",
      _meta: {
        kiro: { kind: "turn_completion", promptTurnSummaries: [{ unit: "credit", usage: 0.02 }] },
      },
    });
    t.m.onUpdate({
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "context_usage", usagePercentage: 0.72 } },
    });
    expect(t.m.collectedUsage()).toEqual({
      cost: [{ amount: 0.02, unit: "credit" }],
      contextUsedPercent: 0.7,
    });
    t.m.addPromptUsage({
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    });
    expect(t.m.collectedUsage()).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
  });
});

describe("tool identity", () => {
  it("comes from structured fields, never from the title", () => {
    expect(toolIdentity({ title: "@kiro-remote/kiro_delete_session" })).toEqual({
      source: "other",
      name: null,
    });
    expect(toolIdentity({ _meta: kiroMeta("kiro_get_session") })).toEqual({
      source: "kiro-remote",
      bare: "kiro_get_session",
      name: "mcp__kiro-remote__kiro_get_session",
    });
    expect(
      toolIdentity({ _meta: { claudeCode: { toolName: "mcp__kiro-remote__kiro_get_session" } } }),
    ).toMatchObject({
      source: "kiro-remote",
    });
    expect(toolIdentity({ name: "Bash" })).toEqual({ source: "other", name: "Bash" });
  });
});

describe("the model an agent reports", () => {
  it("is the current value of its model option", () => {
    expect(modelFromConfig([{ id: "model", currentValue: "claude-sonnet-5" }])).toBe(
      "claude-sonnet-5",
    );
    expect(
      modelFromConfig([
        {
          id: "model",
          currentValue: "default",
          options: [{ value: "default", description: "Opus" }],
        },
      ]),
    ).toBe("default (Opus)");
    expect(modelFromConfig([{ id: "mode", currentValue: "vibe" }])).toBeNull();
  });
});
