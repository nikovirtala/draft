import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentTurnHooks,
  DRAFT_TOOLS,
  type DraftEvent,
  knownEvents,
  type StepCall,
  toolsBriefing,
} from "@nikovirtala/draft-core";
import { describe, expect, it, vi } from "vitest";
import { callPolicy, stillWaitingText } from "../src/main/acp/call-policy.ts";
import { DraftSession } from "../src/main/acp/draft-session.ts";
import { TurnMapper } from "../src/main/acp/turn.ts";
import { type Opened, openAcp, recorded } from "./acp-helpers.ts";

/**
 * A person who answers after the agent's MCP client would have given up. The fake ACP agent
 * speaks to draft's MCP server over real HTTP with the MCP SDK's client, whose request timeout is
 * set short, the way Kiro's is 120 s. draft holds a request for `holdMs`, then says "call again";
 * the agent calls again (as a model does) until the person has answered.
 */

const FOLDER = () => realpathSync(mkdtempSync(join(tmpdir(), "draft-late-")));
const POLICY = { holdMs: 250, retainMs: 20_000, cancelGraceMs: 2000 };
const TRUST_ALL = { style: "kiro", starts: "asking", neverAsks: true } as const;

const events = (o: Opened) => knownEvents(o.log.events());
const ofType = <T extends DraftEvent["type"]>(o: Opened, type: T) =>
  events(o).filter((e) => e.type === type) as DraftEvent<T>[];
const attempts = (o: Opened) => recorded(o.logPath).filter((e) => e.event === "attempt");

async function using<T>(o: Opened, f: (o: Opened) => Promise<T>): Promise<T> {
  try {
    return await f(o);
  } finally {
    await o.close();
  }
}

/** The agent made `n` attempts and was told to wait each time. */
const toldToWait = (o: Opened, n: number) =>
  vi.waitFor(
    () => {
      const told = attempts(o).filter((a) => String(a.text).includes("has not answered yet"));
      expect(told.length).toBeGreaterThanOrEqual(n);
    },
    { timeout: 8000, interval: 20 },
  );

describe("a person who answers after the agent's client gave up", () => {
  it("runs the call once, through the agent calling again, when the person says yes late", async () => {
    const folder = FOLDER();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              {
                tool: "write_file",
                server: "draft",
                input: { path: "late.txt", content: "late\n" },
                timeoutMs: 5000,
                callAgain: 40,
              },
              { text: "Written.", chunk: 4, delayMs: 0 },
            ],
          },
        ],
      },
      { kind: "kiro", folder, callPolicy: POLICY },
    );
    await using(o, async () => {
      const done = o.service.submit("write the note");
      await vi.waitFor(() => expect(o.service.state().prompts).toHaveLength(1));
      await toldToWait(o, 3);
      // Several requests have come and gone, and the person was asked once and nothing ran.
      expect(o.service.state().prompts).toHaveLength(1);
      expect(existsSync(join(folder, "late.txt"))).toBe(false);
      expect(ofType(o, "step.started")).toHaveLength(0);

      o.service.answerPrompt(o.service.state().prompts[0]?.id ?? "", true);
      await done;

      expect(readFileSync(join(folder, "late.txt"), "utf8")).toBe("late\n");
      expect(ofType(o, "agent.permission_asked")).toHaveLength(1);
      expect(ofType(o, "step.started")).toHaveLength(1);
      expect(ofType(o, "step.completed")).toHaveLength(1);
      expect(ofType(o, "agent.anomaly")).toHaveLength(0);
      const told = attempts(o);
      expect(told.length).toBeGreaterThanOrEqual(4);
      for (const a of told.slice(0, -1)) {
        expect(a).toMatchObject({ isError: false });
        expect(a.text).toBe(stillWaitingText("write_file", "deciding"));
      }
      expect(told.at(-1)).toMatchObject({ isError: false });
      expect(told.at(-1)?.text).toMatch(/^Done: created late\.txt/);
      // The exchange, for the pull request.
      if (process.env.DRAFT_PRINT_EXCHANGE !== undefined) {
        console.log(
          [
            "",
            ...told.map((a) => JSON.stringify(a)),
            ...ofType(o, "step.started").map((e) =>
              JSON.stringify({ event: e.type, name: e.data.name, input: e.data.input }),
            ),
            ...ofType(o, "step.completed").map((e) =>
              JSON.stringify({ event: e.type, resultSummary: e.data.resultSummary }),
            ),
          ].join("\n"),
        );
      }
    });
  });

  it("runs it once when the client gave up first and sent a cancellation", async () => {
    const folder = FOLDER();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              {
                tool: "write_file",
                server: "draft",
                input: { path: "slow.txt", content: "slow\n" },
                // The client's timeout is shorter than draft's hold: draft is not the one to answer first.
                timeoutMs: 300,
                callAgain: 40,
              },
              { text: "Written.", chunk: 4, delayMs: 0 },
            ],
          },
        ],
      },
      {
        kind: "kiro",
        folder,
        callPolicy: { holdMs: 10_000, retainMs: 20_000, cancelGraceMs: 2000 },
      },
    );
    await using(o, async () => {
      const done = o.service.submit("write the note");
      await vi.waitFor(() => expect(o.service.state().prompts).toHaveLength(1));
      await vi.waitFor(
        () =>
          expect(
            attempts(o).filter((a) => /timed out/i.test(String(a.error))).length,
          ).toBeGreaterThanOrEqual(2),
        { timeout: 8000, interval: 20 },
      );
      expect(o.service.state().prompts).toHaveLength(1);
      o.service.answerPrompt(o.service.state().prompts[0]?.id ?? "", true);
      await done;
      expect(readFileSync(join(folder, "slow.txt"), "utf8")).toBe("slow\n");
      expect(ofType(o, "agent.permission_asked")).toHaveLength(1);
      expect(ofType(o, "step.started")).toHaveLength(1);
      expect(ofType(o, "step.completed")).toHaveLength(1);
      expect(attempts(o).at(-1)?.text).toMatch(/^Done: created slow\.txt/);
    });
  });

  it("runs nothing when the person says no late, and the agent is told when it calls again", async () => {
    const folder = FOLDER();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              {
                tool: "run_command",
                server: "draft",
                input: { command: "touch refused.txt" },
                timeoutMs: 5000,
                callAgain: 40,
              },
              { text: "Understood.", chunk: 4, delayMs: 0 },
            ],
          },
        ],
      },
      { kind: "kiro", folder, callPolicy: POLICY },
    );
    await using(o, async () => {
      const done = o.service.submit("touch it");
      await vi.waitFor(() => expect(o.service.state().prompts).toHaveLength(1));
      await toldToWait(o, 2);
      o.service.answerPrompt(o.service.state().prompts[0]?.id ?? "", false);
      await done;
      expect(existsSync(join(folder, "refused.txt"))).toBe(false);
      expect(ofType(o, "step.started")).toHaveLength(0);
      expect(ofType(o, "agent.permission_asked")).toHaveLength(1);
      expect(attempts(o).at(-1)).toMatchObject({
        isError: true,
        text: "The user declined this call, so draft did not run it.",
      });
      const [called] = ofType(o, "agent.tool_called");
      expect(called?.data).toMatchObject({ decision: "denied-by-user", isError: true });
    });
  });

  it("settles a call the agent never repeats: a yes after the turn ended starts no step and runs nothing", async () => {
    const folder = FOLDER();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              // Told to wait, the agent doesn't call again and ends its turn.
              {
                tool: "write_file",
                server: "draft",
                input: { path: "never.txt", content: "never\n" },
                timeoutMs: 5000,
              },
              { text: "I'll wait for your answer.", chunk: 8, delayMs: 0 },
            ],
          },
        ],
      },
      { kind: "kiro", folder, callPolicy: POLICY },
    );
    await using(o, async () => {
      await o.service.submit("write the note");
      expect(attempts(o)).toHaveLength(1);
      expect(attempts(o)[0]?.text).toBe(stillWaitingText("write_file", "deciding"));
      // The turn is over. The person's prompt is still there, and answering it is harmless.
      expect(o.service.state().prompts).toHaveLength(1);
      o.service.answerPrompt(o.service.state().prompts[0]?.id ?? "", true);
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(join(folder, "never.txt"))).toBe(false);
      expect(ofType(o, "step.started")).toHaveLength(0);
      expect(o.service.state().prompts).toHaveLength(0);
      expect(o.service.runningSteps()).toEqual([]);
    });
  });

  it("stops acting on a yes once the time bound has passed, with the turn still running", async () => {
    const folder = FOLDER();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              {
                tool: "write_file",
                server: "draft",
                input: { path: "bound.txt", content: "bound\n" },
                timeoutMs: 5000,
              },
              // The turn goes on while the person takes their time.
              { text: "Still here.", chunk: 1, delayMs: 100 },
            ],
          },
        ],
      },
      { kind: "kiro", folder, callPolicy: { holdMs: 100, retainMs: 400, cancelGraceMs: 100 } },
    );
    await using(o, async () => {
      const done = o.service.submit("write the note");
      await vi.waitFor(() => expect(o.service.state().prompts).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 600));
      o.service.answerPrompt(o.service.state().prompts[0]?.id ?? "", true);
      await done;
      expect(existsSync(join(folder, "bound.txt"))).toBe(false);
      expect(ofType(o, "step.started")).toHaveLength(0);
    });
  });

  it("tells the agent to call again with the same arguments, in the briefing and in the answer", () => {
    expect(toolsBriefing(DRAFT_TOOLS)).toContain("exactly the same arguments");
    expect(stillWaitingText("run_command", "running")).toContain("still running");
    // Each answers before the client's own timeout: Kiro's 120 s, and the shortest known, 60 s.
    expect(callPolicy("kiro").holdMs).toBeLessThan(120_000);
    expect(callPolicy("claude").holdMs).toBeLessThan(60_000);
    expect(callPolicy("generic").holdMs).toBeLessThan(60_000);
  });
});

describe("the same call across requests", () => {
  /** A session on a real turn mapper, with a person who answers when the test says. */
  function session(policy = { holdMs: 60, retainMs: 5000, cancelGraceMs: 1000 }) {
    const folder = FOLDER();
    const asked: StepCall[] = [];
    const begun: StepCall[] = [];
    let answer: (allow: boolean) => void = () => {};
    const hooks: AgentTurnHooks = {
      confirmTool: (call) => {
        asked.push(call);
        return new Promise((resolve) => {
          answer = (allow) =>
            resolve(allow ? { allow: true } : { allow: false, message: "The user declined." });
        });
      },
      beginStep: async (call) => {
        begun.push(call);
        return { idempotencyKey: `key-${begun.length}` };
      },
    };
    const turn = new TurnMapper(hooks, () => {}, "kiro", new Set(DRAFT_TOOLS.map((t) => t.name)));
    const s = new DraftSession({
      id: "t",
      tools: DRAFT_TOOLS,
      ctx: { folder },
      env: { PATH: process.env.PATH ?? "" },
      turn: () => turn,
      policy,
    });
    return { s, folder, asked, begun, answer: (a: boolean) => answer(a), turn };
  }

  const never = () => new AbortController().signal;

  it("joins a request with other ids and the keys in another order, and asks once", async () => {
    const { s, folder, asked, begun, answer } = session();
    const first = await s.call("write_file", { path: "a.txt", content: "x" }, 1, never());
    expect(first).toEqual({ text: stillWaitingText("write_file", "deciding"), isError: false });
    // Another id, the keys in another order: the same call.
    const second = s.call("write_file", { content: "x", path: "a.txt" }, 2, never());
    answer(true);
    expect(await second).toMatchObject({
      isError: false,
      text: expect.stringMatching(/^Done: created a\.txt/),
    });
    expect(asked).toHaveLength(1);
    expect(begun).toHaveLength(1);
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("x");
  });

  it("does not run until a request is waiting, then runs once for it", async () => {
    const { s, folder, asked, begun, answer } = session();
    await s.call("write_file", { path: "b.txt", content: "x" }, 1, never());
    // The person says yes while no request is waiting: the decision is kept, nothing runs.
    answer(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(begun).toHaveLength(0);
    expect(existsSync(join(folder, "b.txt"))).toBe(false);
    const again = await s.call("write_file", { path: "b.txt", content: "x" }, 2, never());
    expect(again.text).toMatch(/^Done: created b\.txt/);
    expect(asked).toHaveLength(1);
    expect(begun).toHaveLength(1);
  });

  it("is another call when the input differs", async () => {
    const { s, asked } = session();
    await s.call("write_file", { path: "c.txt", content: "1" }, 1, never());
    await s.call("write_file", { path: "c.txt", content: "2" }, 2, never());
    expect(asked).toHaveLength(2);
  });

  it("is another call once its result has been collected", async () => {
    const { s, asked, answer } = session();
    await s.call("write_file", { path: "d.txt", content: "1" }, 1, never());
    const collected = s.call("write_file", { path: "d.txt", content: "1" }, 2, never());
    answer(true);
    expect((await collected).text).toMatch(/^Done: created d\.txt/);
    await s.call("write_file", { path: "d.txt", content: "1" }, 3, never());
    expect(asked).toHaveLength(2);
  });

  it("gives the result back when the client cancels the request that collected it", async () => {
    const { s, asked, answer } = session();
    await s.call("write_file", { path: "f.txt", content: "x" }, 1, never());
    const sent = s.call("write_file", { path: "f.txt", content: "x" }, 2, never());
    answer(true);
    const result = await sent;
    expect(result.text).toMatch(/^Done: created f\.txt/);
    // The client had given up a moment before the result was written, and says so.
    s.cancelled(2);
    const again = await s.call("write_file", { path: "f.txt", content: "x" }, 3, never());
    expect(again).toEqual(result);
    expect(asked).toHaveLength(1);
  });

  it("does not give a result back once the cancel grace has passed", async () => {
    const { s, asked, answer } = session({ holdMs: 60, retainMs: 5000, cancelGraceMs: 30 });
    await s.call("write_file", { path: "g.txt", content: "x" }, 1, never());
    const sent = s.call("write_file", { path: "g.txt", content: "x" }, 2, never());
    answer(true);
    await sent;
    await new Promise((r) => setTimeout(r, 80));
    s.cancelled(2);
    // Too late: the same arguments are a new call, and the person is asked again.
    await s.call("write_file", { path: "g.txt", content: "x" }, 3, never());
    expect(asked).toHaveLength(2);
  });

  it("ends the wait, and not the call, when the request is gone", async () => {
    const { s, asked, begun, answer, folder } = session({
      holdMs: 5000,
      retainMs: 5000,
      cancelGraceMs: 1000,
    });
    const gone = new AbortController();
    const waiting = s.call("write_file", { path: "e.txt", content: "x" }, 1, gone.signal);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    gone.abort();
    expect((await waiting).text).toContain("Call write_file again");
    answer(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(begun).toHaveLength(0);
    const again = await s.call("write_file", { path: "e.txt", content: "x" }, 2, never());
    expect(again.text).toMatch(/^Done: created e\.txt/);
    expect(asked).toHaveLength(1);
    expect(existsSync(join(folder, "e.txt"))).toBe(true);
  });

  it("says a running command is still running, and gives its result to the repeated call", async () => {
    const { s, answer } = session({ holdMs: 100, retainMs: 5000, cancelGraceMs: 1000 });
    const first = s.call("run_command", { command: "sleep 0.4; echo finished" }, 1, never());
    await new Promise((r) => setTimeout(r, 20));
    answer(true);
    expect(await first).toEqual({
      text: stillWaitingText("run_command", "running"),
      isError: false,
    });
    let last = await s.call("run_command", { command: "sleep 0.4; echo finished" }, 2, never());
    for (let i = 3; last.text.includes("again with exactly") && i < 20; i++)
      last = await s.call("run_command", { command: "sleep 0.4; echo finished" }, i, never());
    expect(last).toMatchObject({ isError: false, text: expect.stringContaining("finished") });
  });

  it("ends what the turn left pending: a yes after that starts no step", async () => {
    const { s, turn, answer, begun } = session({
      holdMs: 100,
      retainMs: 5000,
      cancelGraceMs: 1000,
    });
    await s.call("run_command", { command: "sleep 30" }, 1, never());
    answer(true);
    await new Promise((r) => setTimeout(r, 20));
    s.turnEnded(turn);
    await new Promise((r) => setTimeout(r, 50));
    // The turn ended before a request came back for the yes: the step never began.
    expect(begun).toHaveLength(0);
  });
});
