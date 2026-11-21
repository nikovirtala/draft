import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentDirectory,
  FakeAgentRuntime,
  type FakeScript,
  FakeScriptSchema,
} from "../src/agent.ts";
import { knownEvents } from "../src/events.ts";
import { FileLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { KiroSessionResolver } from "../src/resolver.ts";
import { Workspace as W, type Workspace } from "../src/workspace.ts";
import { fakeKiro, RUNNING } from "./fixtures.ts";
import { USER } from "./helpers.ts";

const reply = (text: string) => ({ text, delayMs: 0 });

async function open(dir: string, scripts: Record<string, Pick<FakeScript, "turns">>) {
  const kiro = fakeKiro();
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const runtimes = new Map(
    Object.entries(scripts).map(([id, script]) => [
      id,
      new FakeAgentRuntime(FakeScriptSchema.parse(script), kiro.asTools(), {
        id,
        model: `${id}-model`,
      }),
    ]),
  );
  const defaultId = Object.keys(scripts)[0] as string;
  const agents: AgentDirectory = {
    defaultId,
    list: () => [...runtimes.keys()].map((id) => ({ id, label: id })),
    get: (id) => {
      const r = runtimes.get(id);
      if (r === undefined) throw new Error(`the agent "${id}" isn't configured`);
      return r;
    },
  };
  const workspace = await W.open({
    log,
    projection,
    agent: agents.get(defaultId),
    agents,
    resolvers: [new KiroSessionResolver(kiro.asTools())],
    user: USER,
    poller: { baseMs: 0 },
  });
  return {
    workspace,
    log,
    projection,
    runtimes,
    close: () => {
      log.close();
      projection.close();
    },
  };
}

async function firstMessage(w: Workspace): Promise<string> {
  await w.main.submit("Which sessions are open?");
  return w.main.state().messages[1]?.address as string;
}

describe("threads", () => {
  it("branch off a message: a conversation with that message as parent, on the default agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const { workspace, log, close } = await open(dir, {
      alpha: { turns: [{ match: "sessions", steps: [reply("Two are open.")] }] },
    });
    const parent = await firstMessage(workspace);
    const thread = await workspace.branch(parent, USER, { title: "The PR thread" });
    const created = knownEvents(log.events()).filter((e) => e.type === "conversation.created");
    expect(created).toHaveLength(2);
    expect(created[1]?.data).toMatchObject({ conversation: thread, parent });
    const [t] = workspace.threads();
    expect(t).toMatchObject({
      conversation: thread,
      parent,
      parentConversation: workspace.mainConversation,
      title: "The PR thread",
      state: "open",
      depth: 1,
      agent: "alpha",
      messages: 0,
      waiting: 0,
    });
    // The main conversation's own messages are untouched.
    expect(workspace.main.state().messages).toHaveLength(2);
    close();
  });

  it("two threads run two sessions on the agent, each started from its own log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const { workspace, runtimes, log, close } = await open(dir, {
      alpha: {
        turns: [
          { match: "sessions", steps: [reply("Two are open.")] },
          { match: "first", steps: [reply("Thread one answers.")] },
          { match: "second", steps: [reply("Thread two answers.")] },
        ],
      },
    });
    const parent = await firstMessage(workspace);
    const one = await workspace.branch(parent, USER, { title: "One" });
    const two = await workspace.branch(parent, USER, { title: "Two" });
    await workspace.conversation(one).submit("first question");
    await workspace.conversation(two).submit("second question");

    const alpha = runtimes.get("alpha") as FakeAgentRuntime;
    const turns = alpha.received.filter((r) => r.conversation !== workspace.mainConversation);
    expect(turns.map((r) => r.conversation)).toEqual([one, two]);
    // A session starts from the projection of its own conversation, not the main one's.
    expect(turns[0]?.context.conversation).toBe(one);
    expect(turns[1]?.context.conversation).toBe(two);
    expect(turns[1]?.context.messages.map((m) => m.text)).not.toContain("first question");
    expect(
      workspace
        .conversation(one)
        .state()
        .messages.map((m) => m.text),
    ).toEqual(["first question", "Thread one answers."]);
    expect(
      workspace
        .conversation(two)
        .state()
        .messages.map((m) => m.text),
    ).toEqual(["second question", "Thread two answers."]);
    const started = knownEvents(log.events()).filter((e) => e.conversation === one);
    expect(started.map((e) => e.type)).toContain("message.posted");
    close();
  });

  it("starts a thread on another configured agent, and refuses one that isn't configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const { workspace, runtimes, close } = await open(dir, {
      alpha: { turns: [{ match: "sessions", steps: [reply("Two are open.")] }] },
      beta: { turns: [{ match: "ask", steps: [reply("Beta here.")] }] },
    });
    const parent = await firstMessage(workspace);
    await expect(workspace.branch(parent, USER, { agent: "nope" })).rejects.toThrow(
      /isn't configured/,
    );
    const thread = await workspace.branch(parent, USER, { agent: "beta" });
    await workspace.conversation(thread).submit("ask beta");
    expect((runtimes.get("beta") as FakeAgentRuntime).received).toHaveLength(1);
    expect((runtimes.get("alpha") as FakeAgentRuntime).received).toHaveLength(1);
    expect(workspace.conversation(thread).state().agent.id).toBe("beta");
    close();
  });

  it("logs a switch of agent, and the new session starts from the projection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const { workspace, runtimes, log, projection, close } = await open(dir, {
      alpha: {
        turns: [
          { match: "sessions", steps: [reply("Two are open.")] },
          { match: "remember", steps: [reply("Noted the marker.")] },
        ],
      },
      beta: { turns: [{ match: "again", steps: [reply("Beta continues.")] }] },
    });
    const parent = await firstMessage(workspace);
    const thread = await workspace.branch(parent, USER);
    await workspace.conversation(thread).submit("remember the marker zanzibar-7731");

    const preview = workspace.previewSwitch(thread, "beta");
    expect(preview).toMatchObject({ from: "alpha", to: "beta" });
    expect(preview.size.messages).toBe(2);
    expect(preview.size.characters).toBeGreaterThan(0);

    await workspace.switchAgent(thread, "beta", USER);
    const selected = knownEvents(log.events()).filter((e) => e.type === "agent.selected");
    expect(selected.map((e) => [e.data.agent, e.data.previous, e.data.reason])).toEqual([
      ["alpha", null, "thread-start"],
      ["beta", "alpha", "switch"],
    ]);
    expect(selected[1]?.actor).toEqual(USER);
    expect(projection.agentOf(thread)).toBe("beta");

    await workspace.conversation(thread).submit("again please");
    const beta = runtimes.get("beta") as FakeAgentRuntime;
    expect(beta.received).toHaveLength(1);
    const context = beta.received[0]?.context;
    expect(context?.messages.map((m) => m.text).join("\n")).toContain("zanzibar-7731");
    expect(context?.messages.map((m) => m.text)).toContain("Noted the marker.");
    expect(workspace.conversation(thread).state().agent.id).toBe("beta");
    await expect(workspace.switchAgent(thread, "beta", USER)).rejects.toThrow(/already runs/);
    close();
  });

  it("puts an interrupt in the thread it belongs to, and counts it per conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const { workspace, close } = await open(dir, {
      alpha: {
        turns: [
          { match: "sessions", steps: [reply("Two are open.")] },
          {
            match: "clean up",
            steps: [
              { unasked: "kiro_delete_session", input: { sessionId: RUNNING } },
              reply("Deleted."),
            ],
          },
        ],
      },
    });
    const parent = await firstMessage(workspace);
    const thread = await workspace.branch(parent, USER);
    await workspace.conversation(thread).submit("clean up the old session");

    const inThread = workspace
      .conversation(thread)
      .state()
      .timeline.filter((b) => b.kind === "interrupt");
    const inMain = workspace.main.state().timeline.filter((b) => b.kind === "interrupt");
    expect(inThread).toHaveLength(1);
    expect(inMain).toHaveLength(0);
    const attention = workspace.attention();
    expect(attention.map((a) => [a.conversation, a.cause])).toEqual([[thread, "unasked-call"]]);
    expect(workspace.threads()[0]?.waiting).toBe(1);
    close();
  });

  it("shows a pending permission request in its own thread only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const { workspace, close } = await open(dir, {
      alpha: {
        turns: [
          { match: "sessions", steps: [reply("Two are open.")] },
          {
            match: "launch",
            steps: [
              {
                tool: "kiro_launch_session",
                input: { prompt: "Fix it", repos: ["nikovirtala/draft"] },
              },
              reply("Launched."),
            ],
          },
        ],
      },
    });
    const parent = await firstMessage(workspace);
    const thread = await workspace.branch(parent, USER);
    const svc = workspace.conversation(thread);
    const turn = svc.submit("launch a session");
    await new Promise<void>((resolve) => {
      const off = svc.onChange((c) => {
        if (c.type === "state" && c.state.prompts.length > 0) {
          off();
          resolve();
        }
      });
    });
    expect(workspace.main.state().prompts).toHaveLength(0);
    expect(svc.state().prompts).toHaveLength(1);
    expect(workspace.attention().map((a) => [a.conversation, a.cause])).toEqual([
      [thread, "permission"],
    ]);
    const id = svc.state().prompts[0]?.id as string;
    svc.answerPrompt(id, true);
    await turn;
    expect(workspace.attention()).toEqual([]);
    close();
  });

  it("keeps its threads and their agent after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-ws-"));
    const scripts = {
      alpha: { turns: [{ match: "sessions", steps: [reply("Two are open.")] }] },
      beta: { turns: [] },
    };
    const first = await open(dir, scripts);
    const parent = await firstMessage(first.workspace);
    const thread = await first.workspace.branch(parent, USER, { agent: "beta" });
    first.close();
    const second = await open(dir, scripts);
    expect(second.workspace.threads().map((t) => [t.conversation, t.agent])).toEqual([
      [thread, "beta"],
    ]);
    expect(second.workspace.conversation(thread).state().parent).toBe(parent);
    second.close();
  });
});
