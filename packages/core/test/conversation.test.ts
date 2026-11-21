import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UiPrompt } from "../src/conversation.ts";
import { knownEvents } from "../src/events.ts";
import { fakeKiro, openService, RUNNING, WAITING } from "./fixtures.ts";

describe("a conversation", () => {
  it("runs a turn: streams the reply, logs tool calls, references the sessions it names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-conv-"));
    const kiro = fakeKiro();
    const { service, log, close } = await openService(dir, kiro);
    const deltas: string[] = [];
    service.onChange((c) => c.type === "delta" && deltas.push(c.text));

    await service.submit("Which sessions are open?");

    const state = service.state();
    expect(state.messages.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(deltas.join("")).toBe(state.messages[1]?.text);
    expect(state.messages[1]?.references.map((r) => r.id)).toEqual([RUNNING, WAITING]);
    expect(state.stubs[`kiro-session:${WAITING}`]?.state).toMatchObject({
      title: "Write the docs",
      status: "awaiting_permission",
      pendingPermissions: 1,
    });

    const events = knownEvents(log.events());
    expect(events.map((e) => e.type)).toEqual([
      "context.created",
      "conversation.created",
      "message.posted",
      "agent.tool_called",
      "message.posted",
      "reference.made",
      "reference.made",
    ]);
    const turn = events.slice(2);
    const traceIds = new Set(turn.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);
    expect([...traceIds][0]).toMatch(/^[0-9a-f]{32}$/);
    expect(turn[0]?.actor).toEqual({ kind: "user", id: "local-user" });
    expect(turn[2]?.actor).toMatchObject({ kind: "agent", model: "claude-opus-5-5" });
    expect(turn[1]?.data).toMatchObject({
      name: "mcp__kiro-remote__kiro_list_sessions",
      decision: "allowed-read-only",
    });
    expect(turn.every((e) => e.conversation === state.conversation)).toBe(true);
    close();
  });

  it("asks before a tool that changes things, inside the conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-conv-"));
    const kiro = fakeKiro();
    const { service, log, close } = await openService(dir, kiro);
    const prompts: UiPrompt[] = [];
    service.onChange((c) => {
      if (c.type === "state" && c.state.prompts.length > 0 && prompts.length === 0) {
        prompts.push(...c.state.prompts);
        queueMicrotask(() => service.answerPrompt(c.state.prompts[0]?.id as string, false));
      }
    });
    await service.submit("launch one");
    expect(prompts[0]?.tool).toBe("mcp__kiro-remote__kiro_launch_session");
    expect(kiro.calls.some((c) => c.tool === "kiro_launch_session")).toBe(false);
    const called = knownEvents(log.events()).find((e) => e.type === "agent.tool_called");
    expect(called?.data).toMatchObject({ decision: "denied-by-user", resultSummary: null });
    close();
  });

  it("comes back from the log alone after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-conv-"));
    const kiro = fakeKiro();
    const first = await openService(dir, kiro);
    await first.service.submit("Which sessions are open?");
    const before = first.service.state();
    first.close();

    // Delete the views: the log is the only source.
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "views.db"));
    const second = await openService(dir, kiro);
    const after = second.service.state();
    expect(after.conversation).toBe(before.conversation);
    expect(after.messages).toEqual(before.messages);
    expect(after.stubs).toEqual(before.stubs);
    second.close();
  });

  it("updates a stub on screen when the session changes, writing one status event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-conv-"));
    const kiro = fakeKiro();
    const { service, log, close } = await openService(dir, kiro);
    await service.submit("Which sessions are open?");
    service.setVisible([{ type: "kiro-session", id: RUNNING }]);
    await service.tick();
    expect(knownEvents(log.events()).filter((e) => e.type === "status.observed")).toHaveLength(0);

    kiro.update(RUNNING, { status: "awaiting_permission", pendingPermissions: 2 });
    await new Promise((r) => setTimeout(r, 5));
    await service.tick();
    await new Promise((r) => setTimeout(r, 5));
    await service.tick();
    const statuses = knownEvents(log.events()).filter((e) => e.type === "status.observed");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.actor).toEqual({ kind: "resolver", id: "kiro-session", version: "1" });
    expect(service.state().stubs[`kiro-session:${RUNNING}`]?.state).toMatchObject({
      status: "awaiting_permission",
      pendingPermissions: 2,
    });
    // The reference keeps the state it had when it was made.
    const ref = service.state().messages[1]?.references.find((r) => r.id === RUNNING);
    expect(ref?.snapshot).toMatchObject({ status: "running" });
    close();
  });
});
