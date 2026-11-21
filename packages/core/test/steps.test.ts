import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FakeScript } from "../src/agent.ts";
import type { ConversationService } from "../src/conversation.ts";
import { type DraftEvent, knownEvents } from "../src/events.ts";
import { KIRO_MUTATING_TOOLS, type KiroRemoteTools } from "../src/kiro.ts";
import type { FileLogStore } from "../src/log.ts";
import type { FakeKiroRemote } from "../src/testing/index.ts";
import { fakeKiro, openService, RUNNING } from "./fixtures.ts";

const LAUNCH = {
  prompt: "Fix the flaky test",
  repos: ["nikovirtala/draft"],
  title: "Fix the flaky test",
};

const script = (steps: FakeScript["turns"][number]["steps"]): FakeScript => ({
  turns: [{ match: "go", steps }],
  fallback: "Nothing scripted.",
});

/** Answers every confirm prompt with `allow`. */
function autoAnswer(service: ConversationService, allow = true): void {
  service.onChange((c) => {
    if (c.type !== "state") return;
    for (const p of c.state.prompts) queueMicrotask(() => service.answerPrompt(p.id, allow));
  });
}

const mutatingCalls = (kiro: FakeKiroRemote) =>
  kiro.calls.filter((c) => (KIRO_MUTATING_TOOLS as readonly string[]).includes(c.tool));

describe("steps: calls that change something", () => {
  it("log intent before effect, then the completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-steps-"));
    const kiro = fakeKiro();
    const inner = kiro.asTools();
    let logAtCall: string[] = [];
    let log: FileLogStore | null = null;
    const tools: KiroRemoteTools = {
      call: async (tool, args) => {
        if (tool === "kiro_launch_session")
          logAtCall = knownEvents(log?.events() ?? []).map((e) => e.type);
        return inner.call(tool, args);
      },
    };
    const opened = await openService(
      dir,
      kiro,
      script([{ tool: "kiro_launch_session", input: LAUNCH }]),
      tools,
    );
    log = opened.log;
    autoAnswer(opened.service);
    await opened.service.submit("go");

    // When the tool ran, its step was already in the log.
    expect(logAtCall.at(-1)).toBe("step.started");
    const events = knownEvents(opened.log.events());
    const started = events.find((e) => e.type === "step.started") as DraftEvent<"step.started">;
    const completed = events.find(
      (e) => e.type === "step.completed",
    ) as DraftEvent<"step.completed">;
    expect(started.data).toMatchObject({
      name: "mcp__kiro-remote__kiro_launch_session",
      input: LAUNCH,
      decision: "approved-by-user",
    });
    expect(started.data.idempotencyKey).toMatch(/^[0-9a-z]{26}$/);
    expect(completed.data).toMatchObject({
      started: started.address,
      idempotencyKey: started.data.idempotencyKey,
    });
    expect(completed.data.resultSummary).toContain("sessionId");
    expect(events.indexOf(started)).toBeLessThan(events.indexOf(completed));
    // A step isn't also logged as a plain tool call.
    expect(events.some((e) => e.type === "agent.tool_called")).toBe(false);
    expect(opened.service.state().timeline.some((b) => b.kind === "interrupt")).toBe(false);
    opened.close();
  });

  it("record a tool error as a failed step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-steps-"));
    const kiro = fakeKiro();
    const opened = await openService(
      dir,
      kiro,
      script([
        {
          tool: "kiro_send_prompt",
          input: { sessionId: "01KAHXZZZZZZZZZZZZZZZZZZZZ", prompt: "hi" },
        },
      ]),
    );
    autoAnswer(opened.service);
    await opened.service.submit("go");
    const events = knownEvents(opened.log.events()).map((e) => e.type);
    expect(events.filter((t) => t.startsWith("step."))).toEqual(["step.started", "step.failed"]);
    opened.close();
  });

  it("are never run again after a crash between started and completed: they restore as an interrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-steps-"));
    const before = fakeKiro();
    const inner = before.asTools();
    // The call reaches Kiro Remote, then draft dies before the result comes back.
    let reached = 0;
    const hanging: KiroRemoteTools = {
      call: (tool, args) => {
        if (tool !== "kiro_launch_session") return inner.call(tool, args);
        reached++;
        void inner.call(tool, args);
        return new Promise(() => {});
      },
    };
    const first = await openService(
      dir,
      before,
      script([{ tool: "kiro_launch_session", input: LAUNCH }]),
      hanging,
    );
    autoAnswer(first.service);
    void first.service.submit("go");
    await expect.poll(() => reached).toBe(1);
    first.close(); // the crash: nothing after step.started reaches the log

    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1) as string).type).toBe("step.started");

    const after = fakeKiro();
    const second = await openService(
      dir,
      after,
      script([{ tool: "kiro_list_sessions", input: {} }]),
    );
    const interrupt = second.service
      .state()
      .timeline.find((b) => b.kind === "interrupt" && b.cause === "unfinished-step");
    expect(interrupt).toMatchObject({
      kind: "interrupt",
      tool: "mcp__kiro-remote__kiro_launch_session",
      input: LAUNCH,
    });
    // Restoring, polling and another turn never make the call again.
    second.service.setVisible([{ type: "kiro-session", id: RUNNING }]);
    await second.service.tick();
    await second.service.submit("go");
    expect(mutatingCalls(after)).toEqual([]);
    expect(mutatingCalls(before)).toHaveLength(1);
    // The interrupt stays until the step is resolved some other way: the log holds no completion.
    expect(
      second.service
        .state()
        .timeline.filter(
          (b) => b.kind === "interrupt" && b.state === "open" && b.cause === "unfinished-step",
        ),
    ).toHaveLength(1);
    second.close();
  });

  it("restoring any prefix of a log never repeats a step", async () => {
    const turn = fc.record({
      tool: fc.constantFrom(
        "kiro_launch_session",
        "kiro_cancel_turn",
        "kiro_list_sessions",
        "kiro_get_session",
      ),
      allow: fc.boolean(),
    });
    const inputs: Record<string, Record<string, unknown>> = {
      kiro_launch_session: LAUNCH,
      kiro_cancel_turn: { sessionId: RUNNING },
      kiro_list_sessions: { limit: 5 },
      kiro_get_session: { sessionId: RUNNING },
    };
    await fc.assert(
      fc.asyncProperty(fc.array(turn, { minLength: 1, maxLength: 4 }), async (turns) => {
        // Write a log: each turn is one tool call, allowed or not.
        const dir = mkdtempSync(join(tmpdir(), "draft-prefix-"));
        const kiro = fakeKiro();
        const opened = await openService(dir, kiro, {
          turns: turns.map((t, i) => ({
            match: `^turn ${i}$`,
            steps: [{ tool: t.tool, input: inputs[t.tool] ?? {} }],
          })),
          fallback: "Nothing scripted.",
        });
        let i = 0;
        opened.service.onChange((c) => {
          if (c.type !== "state") return;
          for (const p of c.state.prompts) {
            const allow = turns[i]?.allow ?? false;
            queueMicrotask(() => opened.service.answerPrompt(p.id, allow));
          }
        });
        for (; i < turns.length; i++) await opened.service.submit(`turn ${i}`);
        const completed = mutatingCalls(kiro).length;
        opened.close();
        const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n");

        // Restore from every prefix, as a crash after any write would leave it.
        for (let k = 0; k <= lines.length; k++) {
          const at = mkdtempSync(join(tmpdir(), "draft-prefix-k-"));
          writeFileSync(
            join(at, "log.jsonl"),
            lines
              .slice(0, k)
              .map((l) => `${l}\n`)
              .join(""),
          );
          const replayKiro = fakeKiro();
          const r = await openService(at, replayKiro, { turns: [], fallback: "Nothing scripted." });
          await r.service.tick();
          expect(mutatingCalls(replayKiro)).toEqual([]);
          // Every step in the prefix is either finished or an interrupt, never pending a rerun.
          const events = knownEvents(r.log.events()).slice(0, k);
          const started = events.filter((e) => e.type === "step.started").length;
          const finished = events.filter(
            (e) => e.type === "step.completed" || e.type === "step.failed",
          ).length;
          const interrupts = r.service
            .state()
            .timeline.filter((b) => b.kind === "interrupt" && b.cause === "unfinished-step").length;
          expect(interrupts).toBe(started - finished);
          r.close();
        }
        expect(completed).toBe(
          turns.filter((t) => t.allow && t.tool === "kiro_launch_session").length +
            turns.filter((t) => t.allow && t.tool === "kiro_cancel_turn").length,
        );
      }),
      { numRuns: 30 },
    );
  }, 120_000);
});
