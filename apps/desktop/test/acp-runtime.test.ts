import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DraftEvent, knownEvents } from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import {
  autoAnswer,
  fakeKiro,
  LAUNCH,
  type Opened,
  openAcp,
  RUNNING,
  recorded,
  runOnce,
  type Script,
  WAITING,
} from "./acp-helpers.ts";

const MARKER = "zanzibar-marker-7731";
const reply = (text: string): Script["turns"][number]["steps"][number] => ({
  text,
  chunk: 4,
  delayMs: 0,
});

async function using<T>(o: Opened, f: (o: Opened) => Promise<T>): Promise<T> {
  try {
    return await f(o);
  } finally {
    await o.close();
  }
}

const types = (o: Opened) => knownEvents(o.log.events()).map((e) => e.type);

describe("the ACP runtime, against a scripted agent over real stdio", () => {
  it("streams a turn, and the actor names the agent and the model it reports", async () => {
    const o = await openAcp({
      agent: { name: "fake-acp-agent", version: "1.2.3", model: "fake-model-9" },
      turns: [{ match: "hello", steps: [reply("Hello there, how can I help?")] }],
    });
    await using(o, async () => {
      const deltas: string[] = [];
      o.service.onChange((c) => c.type === "delta" && deltas.push(c.text));
      await o.service.submit("hello");
      const state = o.service.state();
      expect(state.messages.map((m) => m.text)).toEqual(["hello", "Hello there, how can I help?"]);
      expect(deltas.join("")).toBe("Hello there, how can I help?");
      expect(deltas.length).toBeGreaterThan(3);

      const events = knownEvents(o.log.events());
      const agentMessage = events.find(
        (e) => e.type === "message.posted" && e.data.role === "agent",
      ) as DraftEvent<"message.posted">;
      expect(agentMessage.actor).toEqual({
        kind: "agent",
        id: "fake",
        model: "fake-model-9",
        version: "fake-acp-agent 1.2.3",
      });
      expect(state.agent).toMatchObject({ id: "fake", model: "fake-model-9" });
      expect(types(o)).toContain("agent.session_started");
      const started = events.find(
        (e) => e.type === "agent.session_started",
      ) as DraftEvent<"agent.session_started">;
      expect(started.data).toMatchObject({ agent: "fake", model: "fake-model-9" });
    });
  });

  it("hands Kiro Remote to the agent over HTTP with the bearer header, and starts it in a dedicated directory with no tools of its own", async () => {
    const o = await openAcp({ turns: [{ steps: [reply("ok")] }] });
    await using(o, async () => {
      await o.service.submit("hi");
      const log = recorded(o.logPath);
      const init = log.find((e) => e.event === "initialize");
      expect(init?.params.clientCapabilities).toMatchObject({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
      expect(init?.params.clientInfo.name).toBe("draft");
      const created = log.find((e) => e.event === "session/new");
      expect(created?.params.cwd).toBe(join(o.dir, "agent-workspace"));
      expect(created?.params.mcpServers).toEqual([
        {
          type: "http",
          name: "kiro-remote",
          url: o.kiro.mcpUrl,
          headers: [{ name: "Authorization", value: "Bearer test-token-1" }],
        },
      ]);
    });
  });

  it("falls back to the kiro-remote stdio client when the agent can't take an HTTP server", async () => {
    const o = await openAcp({ agent: { http: false }, turns: [{ steps: [reply("ok")] }] });
    await using(o, async () => {
      await o.service.submit("hi");
      const created = recorded(o.logPath).find((e) => e.event === "session/new");
      expect(created?.params.mcpServers).toEqual([
        {
          name: "kiro-remote",
          command: "kiro-remote",
          args: ["mcp"],
          env: [{ name: "KIRO_REMOTE_URL", value: o.kiro.baseUrl }],
        },
      ]);
    });
  });

  it("logs a read-only call as one agent.tool_called, and references what it returns", async () => {
    const o = await openAcp({
      turns: [
        {
          match: "sessions",
          steps: [
            reply("Let me look."),
            { tool: "kiro_list_sessions", input: { limit: 20 } },
            reply(`${RUNNING} is running and ${WAITING} waits for you.`),
          ],
        },
      ],
    });
    await using(o, async () => {
      await o.service.submit("Which sessions are open?");
      const events = knownEvents(o.log.events());
      const call = events.find(
        (e) => e.type === "agent.tool_called",
      ) as DraftEvent<"agent.tool_called">;
      expect(call.data).toMatchObject({
        name: "mcp__kiro-remote__kiro_list_sessions",
        decision: "allowed-read-only",
        isError: false,
      });
      expect(events.some((e) => e.type.startsWith("step."))).toBe(false);
      expect(
        o.service
          .state()
          .messages.at(-1)
          ?.references.map((r) => r.id),
      ).toEqual([RUNNING, WAITING]);
      expect(o.service.state().prompts).toEqual([]);
    });
  });

  describe("permission requests", () => {
    it("begin a durable step before the agent proceeds, and the result completes it", async () => {
      const o = await openAcp({
        turns: [
          {
            match: "launch",
            steps: [{ tool: "kiro_launch_session", input: LAUNCH }, reply("Launched.")],
          },
        ],
      });
      await using(o, async () => {
        // When the call reaches Kiro Remote, the step is already in the log.
        let logAtCall: string[] = [];
        o.kiro.onCall = (c) => {
          if (c.tool === "kiro_launch_session") logAtCall = types(o);
        };
        let prompted = false;
        o.service.onChange((c) => {
          if (c.type !== "state" || c.state.prompts.length === 0 || prompted) return;
          prompted = true;
          // Nothing has run, and nothing is started, while the person decides.
          expect(o.kiro.calls.some((x) => x.tool === "kiro_launch_session")).toBe(false);
          expect(types(o)).not.toContain("step.started");
          expect(c.state.prompts[0]?.tool).toBe("mcp__kiro-remote__kiro_launch_session");
          queueMicrotask(() => o.service.answerPrompt(c.state.prompts[0]?.id as string, true));
        });
        await o.service.submit("launch a session");

        expect(prompted).toBe(true);
        expect(logAtCall.at(-1)).toBe("step.started");
        const events = knownEvents(o.log.events());
        const started = events.find((e) => e.type === "step.started") as DraftEvent<"step.started">;
        const completed = events.find(
          (e) => e.type === "step.completed",
        ) as DraftEvent<"step.completed">;
        expect(started.data).toMatchObject({
          name: "mcp__kiro-remote__kiro_launch_session",
          input: LAUNCH,
          decision: "approved-by-user",
        });
        expect(completed.data).toMatchObject({
          started: started.address,
          idempotencyKey: started.data.idempotencyKey,
        });
        expect(completed.data.resultSummary).toContain("sessionId");
        expect(events.some((e) => e.type === "agent.tool_called")).toBe(false);
        // Only a one-time allow is ever chosen: the agent never saves a rule of its own.
        const answer = recorded(o.logPath).find((e) => e.event === "permission");
        expect(answer?.outcome).toEqual({ outcome: "selected", optionId: "accept" });
        expect(o.service.state().timeline.some((b) => b.kind === "interrupt")).toBe(false);
      });
    });

    it("end a declined call without a step, and tell the agent it was declined", async () => {
      const o = await openAcp({
        turns: [
          {
            match: "launch",
            steps: [{ tool: "kiro_launch_session", input: LAUNCH }, reply("Understood.")],
          },
        ],
      });
      await using(o, async () => {
        autoAnswer(o.service, false);
        await o.service.submit("launch a session");
        expect(o.kiro.calls.filter((c) => c.tool === "kiro_launch_session")).toEqual([]);
        const events = knownEvents(o.log.events());
        expect(events.some((e) => e.type.startsWith("step."))).toBe(false);
        const call = events.find(
          (e) => e.type === "agent.tool_called",
        ) as DraftEvent<"agent.tool_called">;
        expect(call.data).toMatchObject({
          decision: "denied-by-user",
          resultSummary: null,
          isError: true,
        });
        const answer = recorded(o.logPath).find((e) => e.event === "permission");
        expect(answer?.outcome).toEqual({ outcome: "selected", optionId: "reject" });
      });
    });

    it("refuse a tool that isn't Kiro Remote's, without asking the person", async () => {
      const o = await openAcp({
        turns: [
          {
            steps: [
              { builtin: "shell", kind: "execute", input: { command: "rm -rf /" } },
              reply("ok"),
            ],
          },
        ],
      });
      await using(o, async () => {
        await o.service.submit("clean up");
        expect(o.service.state().prompts).toEqual([]);
        const call = knownEvents(o.log.events()).find(
          (e) => e.type === "agent.tool_called",
        ) as DraftEvent<"agent.tool_called">;
        expect(call.data).toMatchObject({ name: "shell", decision: "denied-by-policy" });
        expect(recorded(o.logPath).some((e) => e.event === "tool-ran")).toBe(false);
      });
    });

    it("work the same with the identity fields the Claude adapter sends", async () => {
      const o = await openAcp(
        {
          style: "claude",
          turns: [{ steps: [{ tool: "kiro_launch_session", input: LAUNCH }, reply("Done.")] }],
        },
        {},
      );
      await using(o, async () => {
        autoAnswer(o.service);
        await o.service.submit("go");
        expect(types(o)).toEqual(expect.arrayContaining(["step.started", "step.completed"]));
      });
    });
  });

  describe("a call that skips permission", () => {
    it("is an anomaly: logged, shown as an interrupt, with no step before it", async () => {
      const o = await openAcp({
        turns: [
          {
            steps: [
              { unasked: "kiro_delete_session", input: { sessionId: RUNNING } },
              reply("Deleted."),
            ],
          },
        ],
      });
      await using(o, async () => {
        await o.service.submit("clean up");
        const events = knownEvents(o.log.events());
        const anomaly = events.find(
          (e) => e.type === "agent.anomaly",
        ) as DraftEvent<"agent.anomaly">;
        expect(anomaly.data).toMatchObject({
          kind: "call-without-permission",
          name: "mcp__kiro-remote__kiro_delete_session",
          input: { sessionId: RUNNING },
        });
        expect(anomaly.data.status).toMatch(/in_progress|completed/);
        expect(events.some((e) => e.type.startsWith("step."))).toBe(false);
        expect(o.service.state().timeline.find((b) => b.kind === "interrupt")).toMatchObject({
          cause: "unasked-call",
          tool: "mcp__kiro-remote__kiro_delete_session",
        });
      });
    });

    it("is not one for a call that is known to change nothing", async () => {
      const o = await openAcp({
        turns: [
          {
            steps: [
              { unasked: "kiro_list_sessions", input: {}, kind: "read" },
              { builtin: "read_file", kind: "read", input: { path: "x" }, ask: false },
              reply("ok"),
            ],
          },
        ],
      });
      await using(o, async () => {
        await o.service.submit("look");
        expect(types(o)).not.toContain("agent.anomaly");
        const calls = knownEvents(o.log.events()).filter((e) => e.type === "agent.tool_called");
        expect(calls.map((c) => (c.data as { decision: string }).decision)).toEqual([
          "allowed-read-only",
          "allowed-read-only",
        ]);
      });
    });

    it("is what draft prevents by switching off the agents' own autopilot: Kiro starts with it on", async () => {
      const o = await openAcp(
        {
          starts: "kiro",
          agent: { model: "fake-kiro-model" },
          turns: [{ steps: [{ tool: "kiro_launch_session", input: LAUNCH }, reply("Launched.")] }],
        },
        { kind: "kiro" },
      );
      await using(o, async () => {
        autoAnswer(o.service);
        await o.service.submit("launch");
        const log = recorded(o.logPath);
        expect(log.find((e) => e.event === "session/set_config_option")).toMatchObject({
          configId: "autopilot",
          value: "off",
        });
        // With autopilot off the agent asks, so the call is a step and not an anomaly.
        expect(types(o)).toEqual(expect.arrayContaining(["step.started", "step.completed"]));
        expect(types(o)).not.toContain("agent.anomaly");
      });
    });

    it("is what draft prevents by leaving Claude's auto mode: it asks in the default mode", async () => {
      const o = await openAcp(
        {
          starts: "claude",
          style: "claude",
          turns: [{ steps: [{ tool: "kiro_launch_session", input: LAUNCH }, reply("Launched.")] }],
        },
        { kind: "claude" },
      );
      await using(o, async () => {
        autoAnswer(o.service);
        await o.service.submit("launch");
        const log = recorded(o.logPath);
        expect(log.find((e) => e.event === "session/new")?.params._meta).toEqual({
          claudeCode: { options: { settingSources: [], tools: [] } },
        });
        expect(log.find((e) => e.event === "session/set_config_option")).toMatchObject({
          configId: "mode",
          value: "default",
        });
        expect(types(o)).toContain("step.started");
      });
    });

    it("keeps draft from starting a session with an agent that won't ask", async () => {
      const o = await openAcp(
        {
          starts: "kiro",
          stubborn: true,
          turns: [{ steps: [{ unasked: "kiro_delete_session" }] }],
        },
        { kind: "kiro" },
      );
      await using(o, async () => {
        await o.service.submit("go");
        const state = o.service.state();
        expect(state.error).toMatch(/couldn't make Fake ask before it acts/);
        expect(recorded(o.logPath).some((e) => e.event === "session/prompt")).toBe(false);
        expect(recorded(o.logPath).some((e) => e.event === "tool-ran")).toBe(false);
        expect(types(o)).not.toContain("agent.session_started");
      });
    });
  });

  describe("usage", () => {
    it("is what the agent reports, and nothing is estimated when it reports none", async () => {
      const reported = await openAcp({
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        credits: 0.024,
        turns: [{ steps: [reply("ok")] }],
      });
      await using(reported, async (o) => {
        const done = (await runOnce(o, "hi")).find((e) => e.type === "done");
        expect(done).toMatchObject({
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            cost: [{ amount: 0.024, unit: "credit" }],
          },
        });
      });
      const silent = await openAcp({ turns: [{ steps: [reply("ok")] }] });
      await using(silent, async (o) => {
        const done = (await runOnce(o, "hi")).find((e) => e.type === "done");
        expect(done).toMatchObject({ type: "done", text: "ok", usage: null });
      });
    });
  });

  describe("a session starts from the log", () => {
    it("keys sessions by conversation, and starts a new one from the projection when the agent process dies", async () => {
      const o = await openAcp({
        crashAfterChunks: 6,
        turns: [
          { match: "first", steps: [reply("First answer that is long enough to be cut.")] },
          { match: "second", steps: [reply("Second answer.")] },
        ],
      });
      await using(o, async () => {
        await o.service.submit("first question");
        expect(o.service.state().error).toMatch(/Fake stopped with an error/);
        await o.service.submit("second question");
        expect(o.service.state().error).toBeNull();
        const log = recorded(o.logPath);
        const prompts = log.filter((e) => e.event === "session/prompt");
        expect(log.filter((e) => e.event === "session/new")).toHaveLength(2);
        // The new session was told what the log holds, as its first prompt.
        expect(prompts.at(-1)?.blocks).toHaveLength(2);
        expect(prompts.at(-1)?.blocks[0]).toContain("User: first question");
        expect(prompts.at(-1)?.blocks[1]).toBe("second question");
      });
    });

    it("tells a restarted session which steps were interrupted, and never runs them again", async () => {
      const dir = mkdtempSync(join(tmpdir(), "draft-acp-restart-"));
      const kiro = await fakeKiro().start();
      const first = await openAcp(
        { turns: [{ match: "launch", steps: [{ tool: "kiro_launch_session", input: LAUNCH }] }] },
        { dir, kiro },
      );
      autoAnswer(first.service);
      // Kiro Remote takes the launch, but its answer never comes back, and draft stops.
      kiro.hang.add("kiro_launch_session");
      void first.service.submit("launch a session please");
      for (let i = 0; i < 200 && !kiro.calls.some((c) => c.tool === "kiro_launch_session"); i++)
        await new Promise((r) => setTimeout(r, 25));
      await first.close();
      kiro.hang.clear();
      expect(kiro.calls.filter((c) => c.tool === "kiro_launch_session")).toHaveLength(1);

      const second = await openAcp(
        { turns: [{ steps: [reply("Checking before I do anything.")] }] },
        { dir, kiro },
      );
      try {
        expect(second.service.state().timeline.some((b) => b.kind === "interrupt")).toBe(true);
        await second.service.submit("what happened?");
        const prompt = recorded(second.logPath)
          .filter((e) => e.event === "session/prompt")
          .at(-1);
        expect(prompt?.blocks[0]).toContain("INTERRUPTED: mcp__kiro-remote__kiro_launch_session");
        expect(prompt?.blocks[0]).toContain("It may or may not have happened");
        expect(prompt?.blocks[0]).toContain("launch a session please");
        expect(kiro.calls.filter((c) => c.tool === "kiro_launch_session")).toHaveLength(1);
      } finally {
        await second.close();
        await kiro.stop();
      }
    });

    it("starts a new session when the token changes, so the agent's MCP headers are current", async () => {
      let n = 0;
      const o = await openAcp(
        {
          turns: [
            { steps: [reply("one")] },
            { steps: [reply("two")] },
            { steps: [reply("three")] },
          ],
        },
        { token: async () => (n++ < 2 ? "token-a" : "token-b") },
      );
      await using(o, async () => {
        await o.service.submit("a");
        await o.service.submit("b");
        await o.service.submit("c");
        const log = recorded(o.logPath);
        const created = log.filter((e) => e.event === "session/new");
        expect(created.map((e) => e.params.mcpServers[0].headers[0].value)).toEqual([
          "Bearer token-a",
          "Bearer token-b",
        ]);
        expect(log.filter((e) => e.event === "session/close")).toHaveLength(1);
      });
    });
  });

  describe("audience and pause", () => {
    it("never lets a people-only message reach the agent, in any prompt of any session", async () => {
      const o = await openAcp({
        turns: [
          { match: "first", steps: [reply("Sure.")] },
          { match: "second", steps: [reply("Again.")] },
        ],
      });
      await using(o, async () => {
        await o.service.submit("first question");
        await o.service.submit(`${MARKER} between us, ${RUNNING}?`, { aside: true });
        // A new session starts from the projection of the log, which must not hold the aside.
        o.runtime.closeConversation(o.service.conversation);
        await o.service.submit("second question");
        const log = readFileSync(o.logPath, "utf8");
        expect(log).not.toContain(MARKER);
        expect(log).not.toContain(RUNNING);
        expect(log).toContain("User: first question");
        expect(JSON.stringify([...o.log.events()])).toContain(MARKER);
      });
    });

    it("pausing a running turn sends the agent session/cancel and starts no step", async () => {
      const o = await openAcp({
        turns: [
          {
            match: "launch",
            steps: [{ tool: "kiro_launch_session", input: LAUNCH }, reply("Launched.")],
          },
        ],
      });
      await using(o, async () => {
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
        expect(types(o)).not.toContain("step.started");
        expect(o.kiro.calls.some((c) => c.tool === "kiro_launch_session")).toBe(false);
        expect(recorded(o.logPath).some((e) => e.event === "session/cancel")).toBe(true);
        expect(o.service.state().busy).toBe(false);
      });
    });

    it("lets @agent reach a paused conversation for that message only", async () => {
      const o = await openAcp({ turns: [{ match: "which", steps: [reply("Two.")] }] });
      await using(o, async () => {
        await o.service.setAgentState("paused");
        await o.service.submit("so, which sessions @agent?");
        await o.service.submit("thanks, let's talk it over");
        expect(recorded(o.logPath).filter((e) => e.event === "session/prompt")).toHaveLength(1);
        expect(o.service.state().agent.state).toBe("paused");
      });
    });
  });

  describe("when the agent can't be started", () => {
    it("says how to set ANTHROPIC_API_KEY when it is missing, without starting anything", async () => {
      const o = await openAcp(
        { turns: [] },
        {
          kind: "claude",
          requires: [
            {
              name: "ANTHROPIC_API_KEY",
              howToSet: "Set ANTHROPIC_API_KEY in the environment you start draft from.",
            },
          ],
        },
      );
      await using(o, async () => {
        await o.service.submit("hello");
        expect(o.service.state().error).toContain("Set ANTHROPIC_API_KEY");
        expect(recorded(o.logPath)).toEqual([]);
      });
    });

    it("names the command when it isn't installed", async () => {
      const o = await openAcp({ turns: [] }, { command: "draft-no-such-agent-cli" });
      await using(o, async () => {
        await o.service.submit("hello");
        expect(o.service.state().error).toMatch(/"draft-no-such-agent-cli" wasn't found/);
      });
    });
  });
});
