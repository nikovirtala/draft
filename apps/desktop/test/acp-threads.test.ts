import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLogStore,
  KiroSessionResolver,
  knownEvents,
  Projection,
  Workspace,
} from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/main/acp/registry.ts";
import { AcpRuntime } from "../src/main/acp/runtime.ts";
import { fakeKiro, fakeSpec, RUNNING, recorded, type Script, USER } from "./acp-helpers.ts";

const reply = (text: string): Script["turns"][number]["steps"][number] => ({
  text,
  chunk: 4,
  delayMs: 0,
});

/** A workspace over real ACP runtimes: each agent id is its own scripted process on stdio. */
async function openThreads(scripts: Record<string, Script>) {
  const dir = mkdtempSync(join(tmpdir(), "draft-acp-threads-"));
  const kiro = await fakeKiro().start();
  const logs: Record<string, string> = {};
  const specs = Object.fromEntries(
    Object.entries(scripts).map(([id, script]) => {
      const sub = join(dir, id);
      mkdirSync(sub, { recursive: true });
      const { spec, logPath } = fakeSpec(sub, script);
      logs[id] = logPath;
      return [id, { ...spec, id, label: id }];
    }),
  );
  const ids = Object.keys(scripts);
  const registry = new AgentRegistry(
    {
      agent: ids[0] as string,
      agents: Object.fromEntries(
        Object.entries(specs).map(([id, s]) => [
          id,
          { command: s.command, args: s.args, env: s.env, passEnv: [] },
        ]),
      ),
    },
    (spec) =>
      new AcpRuntime({
        spec,
        cwd: join(dir, "agent-workspace"),
        env: { PATH: process.env.PATH ?? "" },
        dataDir: dir,
        clientInfo: { name: "draft", version: "0.0.0-test" },
        kiro: { url: kiro.mcpUrl, baseUrl: kiro.baseUrl, token: async () => "test-token-1" },
      }),
  );
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const workspace = await Workspace.open({
    log,
    projection,
    agent: registry.get(ids[0] as string),
    agents: registry,
    resolvers: [new KiroSessionResolver(kiro.asTools())],
    user: USER,
    poller: { baseMs: 0 },
  });
  return {
    workspace,
    log,
    logs,
    close: async () => {
      await workspace.close();
      await registry.close();
      log.close();
      projection.close();
      await kiro.stop();
    },
  };
}

describe("threads over ACP, against scripted agents over real stdio", () => {
  it("runs two threads as two ACP sessions on one agent process, each from its own log", async () => {
    const o = await openThreads({
      alpha: {
        agent: { name: "alpha", version: "1.0.0", model: "alpha-model" },
        turns: [
          { match: "start", steps: [reply("Ready.")] },
          { match: "one", steps: [reply("Answer for thread one.")] },
          { match: "two", steps: [reply("Answer for thread two.")] },
        ],
      },
    });
    try {
      await o.workspace.main.submit("start here");
      const parent = o.workspace.main.state().messages[1]?.address as string;
      const one = await o.workspace.branch(parent, USER, { title: "One" });
      const two = await o.workspace.branch(parent, USER, { title: "Two" });
      await o.workspace.conversation(one).submit("question one");
      await o.workspace.conversation(two).submit("question two");

      const log = recorded(o.logs.alpha as string);
      // One agent process, three sessions: the main conversation and each thread.
      expect(log.filter((e) => e.event === "initialize")).toHaveLength(1);
      const sessions = log.filter((e) => e.event === "session/new").map((e) => e.sessionId);
      expect(new Set(sessions).size).toBe(3);
      const prompts = log.filter((e) => e.event === "session/prompt");
      expect(new Set(prompts.map((p) => p.sessionId)).size).toBe(3);
      // A thread's session was started from the thread's own log, never the other's.
      const forTwo = ((prompts.at(-1)?.blocks ?? []) as string[]).join("\n");
      expect(forTwo).toContain("question two");
      expect(forTwo).not.toContain("question one");
      expect(
        o.workspace
          .conversation(one)
          .state()
          .messages.map((m) => m.text),
      ).toEqual(["question one", "Answer for thread one."]);
      expect(
        o.workspace
          .conversation(two)
          .state()
          .messages.map((m) => m.text),
      ).toEqual(["question two", "Answer for thread two."]);
      const started = knownEvents(o.log.events()).filter((e) => e.type === "agent.session_started");
      expect(started.map((e) => e.conversation)).toEqual([o.workspace.mainConversation, one, two]);
    } finally {
      await o.close();
    }
  });

  it("logs a switch, ends the old session and starts the new one from the projection", async () => {
    const o = await openThreads({
      alpha: {
        agent: { name: "alpha", version: "1.0.0", model: "alpha-model" },
        turns: [
          { match: "start", steps: [reply("Ready.")] },
          { match: "marker", steps: [reply("Noted.")] },
        ],
      },
      beta: {
        agent: { name: "beta", version: "2.0.0", model: "beta-model" },
        turns: [{ match: "continue", steps: [reply("Beta carries on.")] }],
      },
    });
    try {
      await o.workspace.main.submit("start here");
      const parent = o.workspace.main.state().messages[1]?.address as string;
      const thread = await o.workspace.branch(parent, USER);
      await o.workspace.conversation(thread).submit("remember marker zanzibar-7731");

      const preview = o.workspace.previewSwitch(thread, "beta");
      expect(preview.size.messages).toBe(2);
      expect(preview.size.characters).toBeGreaterThan(500);
      await o.workspace.switchAgent(thread, "beta", USER);
      await o.workspace.conversation(thread).submit("continue please");

      const events = knownEvents(o.log.events());
      const selected = events.filter((e) => e.type === "agent.selected");
      expect(selected.map((e) => [e.data.agent, e.data.reason])).toEqual([
        ["alpha", "thread-start"],
        ["beta", "switch"],
      ]);
      const alpha = recorded(o.logs.alpha as string);
      const beta = recorded(o.logs.beta as string);
      // The old agent's session for the thread ended; the new agent never knew the old one's.
      const alphaThread = alpha.filter((e) => e.event === "session/new").at(-1)?.sessionId;
      expect(alpha.some((e) => e.event === "session/close" && e.sessionId === alphaThread)).toBe(
        true,
      );
      expect(beta.filter((e) => e.event === "session/new")).toHaveLength(1);
      // The new session starts from the log's projection: what was said in the thread so far.
      const first = beta.find((e) => e.event === "session/prompt")?.blocks[0] as string;
      expect(first).toContain("zanzibar-7731");
      expect(first).toContain("User: remember marker");
      expect(first).toContain("You: Noted.");
      const started = events.flatMap((e) =>
        e.type === "agent.session_started" && e.conversation === thread ? [e.data.agent] : [],
      );
      expect(started).toEqual(["alpha", "beta"]);
      // And the actor of the thread's later messages names the new agent.
      const last = events
        .filter((e) => e.type === "message.posted" && e.conversation === thread)
        .at(-1);
      expect(last?.actor).toMatchObject({ kind: "agent", id: "beta", model: "beta-model" });
    } finally {
      await o.close();
    }
  });

  it("shows an interrupt in the thread it belongs to, and the attention count follows", async () => {
    const o = await openThreads({
      alpha: {
        turns: [
          { match: "start", steps: [reply("Ready.")] },
          {
            match: "clean up",
            steps: [
              { unasked: "kiro_delete_session", input: { sessionId: RUNNING } },
              reply("Done."),
            ],
          },
        ],
        starts: "kiro",
      },
    });
    try {
      await o.workspace.main.submit("start here");
      const parent = o.workspace.main.state().messages[1]?.address as string;
      const thread = await o.workspace.branch(parent, USER);
      await o.workspace.conversation(thread).submit("clean up the old session");
      const interrupts = (c: string) =>
        o.workspace
          .conversation(c)
          .state()
          .timeline.filter((b) => b.kind === "interrupt");
      expect(interrupts(thread)).toHaveLength(1);
      expect(interrupts(o.workspace.mainConversation)).toHaveLength(0);
      expect(o.workspace.attention().map((a) => [a.conversation, a.cause])).toEqual([
        [thread, "unasked-call"],
      ]);
      const anomaly = knownEvents(o.log.events()).find((e) => e.type === "agent.anomaly");
      expect(anomaly?.conversation).toBe(thread);
    } finally {
      await o.close();
    }
  });
});
