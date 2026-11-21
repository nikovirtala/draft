import { describe, expect, it } from "vitest";
import { decideTool, FakeAgentRuntime } from "../src/agent.ts";
import {
  findSessionIds,
  isPersonOnlyTool,
  KIRO_MUTATING_TOOLS,
  KIRO_PERSON_ONLY_TOOLS,
  KIRO_READ_ONLY_TOOLS,
  sdkToolName,
  toolPermission,
} from "../src/kiro.ts";
import { FakeKiroRemote, KIRO_REMOTE_TOOLS } from "../src/testing/index.ts";

const ID_A = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
const ID_B = "01M7X6ZFTZR6RBES9HBJ2ARW8R";

describe("Kiro session id detection", () => {
  it("finds ULIDs in prose, JSON and markdown", () => {
    expect(findSessionIds(`Session ${ID_A} is running.`)).toEqual([ID_A]);
    expect(findSessionIds(JSON.stringify({ sessions: [{ id: ID_A }, { id: ID_B }] }))).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(findSessionIds(`\`${ID_B}\` and (${ID_A}), then ${ID_B} again`)).toEqual([ID_B, ID_A]);
    expect(findSessionIds(`kiro-remote/sessions/${ID_A}/events`)).toEqual([ID_A]);
  });

  it.each([
    ["lowercase (draft's own item ids)", ID_A.toLowerCase()],
    ["25 characters", ID_A.slice(0, 25)],
    ["27 characters", `${ID_A}0`],
    ["inside a longer token", `X${ID_A}`],
    ["followed by a letter", `${ID_A}a`],
    ["a letter outside Crockford base32 (I)", `01KAHX7Z1M2N3P4Q5R6S7T8VI9`],
    ["a letter outside Crockford base32 (U)", `01KAHX7Z1M2N3P4Q5R6S7T8VU9`],
    ["a timestamp past the ULID range", `8${ID_A.slice(1)}`],
    ["a UUID", "3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c"],
    ["a git SHA", "881b06d03c805f1a82b49eee4fb070bf3af3079d"],
    ["a hash in uppercase hex", "881B06D03C805F1A82B49EEE4FB070BF3AF3079D"],
  ])("does not match %s", (_name, text) => {
    expect(findSessionIds(text)).toEqual([]);
  });
});

describe("the tool permission policy", () => {
  it("covers every Kiro Remote tool exactly once", () => {
    const names = KIRO_REMOTE_TOOLS.map((t) => t.name).sort();
    expect(
      [...KIRO_READ_ONLY_TOOLS, ...KIRO_MUTATING_TOOLS, ...KIRO_PERSON_ONLY_TOOLS].sort(),
    ).toEqual(names);
  });

  it("allows exactly the tools kiro-remote marks read-only", () => {
    for (const t of KIRO_REMOTE_TOOLS) {
      const person = (KIRO_PERSON_ONLY_TOOLS as readonly string[]).includes(t.name);
      expect(toolPermission(sdkToolName(t.name))).toBe(
        t.annotations.readOnlyHint === true ? "allow" : person ? "deny" : "ask",
      );
    }
  });

  it.each([
    ["kiro_list_sessions", "allow"],
    ["kiro_get_session", "allow"],
    ["kiro_wait_for_events", "allow"],
    ["kiro_get_transcript", "allow"],
    ["kiro_list_permissions", "allow"],
    ["kiro_launch_session", "ask"],
    ["kiro_send_prompt", "ask"],
    // Only a person answers a permission request, through draft's interrupts.
    ["kiro_answer_permission", "deny"],
    ["kiro_cancel_turn", "ask"],
    ["kiro_delete_session", "ask"],
  ])("%s: %s", (tool, expected) => {
    expect(toolPermission(sdkToolName(tool))).toBe(expected);
    expect(toolPermission(tool)).toBe(expected);
  });

  it.each([
    "Bash",
    "Write",
    "WebFetch",
    "mcp__github__create_issue",
    "mcp__kiro-remote__kiro_unknown",
    "mcp__other__kiro_get_session",
  ])("denies %s", (name) => {
    expect(toolPermission(name)).toBe("deny");
  });

  it("asks through the hook only for tools that change things", async () => {
    const asked: string[] = [];
    const begun: string[] = [];
    const hooks = {
      confirmTool: async (c: { name: string }) => {
        asked.push(c.name);
        return c.name.endsWith("cancel_turn")
          ? ({ allow: false, message: "no" } as const)
          : ({ allow: true } as const);
      },
      beginStep: async (c: { name: string }) => {
        begun.push(c.name);
        return { idempotencyKey: `key-${begun.length}` };
      },
    };
    const get = await decideTool(sdkToolName("kiro_get_session"), {}, "t1", hooks);
    const launch = await decideTool(sdkToolName("kiro_launch_session"), {}, "t2", hooks);
    const cancel = await decideTool(sdkToolName("kiro_cancel_turn"), {}, "t3", hooks);
    const bash = await decideTool("Bash", {}, "t4", hooks);
    expect([get.decision, launch.decision, cancel.decision, bash.decision]).toEqual([
      "allowed-read-only",
      "approved-by-user",
      "denied-by-user",
      "denied-by-policy",
    ]);
    expect(asked).toEqual([sdkToolName("kiro_launch_session"), sdkToolName("kiro_cancel_turn")]);
    // Only the allowed call that changes something begins a step, and before it runs.
    expect(begun).toEqual([sdkToolName("kiro_launch_session")]);
  });

  it("refuses a call whose step can't be recorded", async () => {
    const r = await decideTool(sdkToolName("kiro_delete_session"), {}, "t5", {
      confirmTool: async () => ({ allow: true }),
      beginStep: async () => {
        throw new Error("disk full");
      },
    });
    expect(r).toMatchObject({ answer: { allow: false }, decision: "denied-by-policy" });
  });

  describe("the person's acts: accepting, rejecting and merging", () => {
    const hooks = (log: string[]) => ({
      confirmTool: async (c: { name: string }) => {
        log.push(`asked ${c.name}`);
        return { allow: true } as const;
      },
      beginStep: async (c: { name: string }) => {
        log.push(`began ${c.name}`);
        return { idempotencyKey: "k" };
      },
    });

    it.each([
      // ark's adr and issues tools
      "mcp__adr__adr_accept",
      "mcp__adr__adr_reject",
      "mcp__ark__adr_accept",
      "adr_accept",
      "mcp__adr__accept",
      // GitHub servers
      "mcp__github__merge_pull_request",
      "mcp__github__mergePullRequest",
      "mcp__github-mcp__enable_auto_merge",
      "mcp__github__approve_pull_request",
      "github/merge_pull_request",
      "mcp__gh__pull_request_review_write_approve",
      // Kiro Remote's person-only tool, and a hypothetical one
      "mcp__kiro-remote__kiro_answer_permission",
      "kiro_answer_permission",
      "mcp__kiro-remote__kiro_merge_session",
    ])("%s is refused without asking, whichever server it comes from", async (name) => {
      expect(isPersonOnlyTool(name)).toBe(true);
      expect(toolPermission(name)).toBe("deny");
      const log: string[] = [];
      const r = await decideTool(name, { id: "x" }, "t1", hooks(log));
      expect(r).toMatchObject({ answer: { allow: false }, decision: "denied-by-policy" });
      expect((r.answer as { message: string }).message).toMatch(/person's act/);
      // Nothing was asked of the person and no step began.
      expect(log).toEqual([]);
    });

    it.each([
      "mcp__adr__adr_propose",
      "mcp__adr__adr_withdraw",
      "mcp__issues__issues_open",
      "mcp__kiro-remote__kiro_launch_session",
      "mcp__kiro-remote__kiro_get_session",
      "mcp__github__get_pull_request",
      "Bash",
    ])("%s is not a person's act", (name) => {
      expect(isPersonOnlyTool(name)).toBe(false);
    });

    it("is refused from the scripted agent as well, with the step never started", async () => {
      const kiro = new FakeKiroRemote({ sessions: [] });
      const events: string[] = [];
      const agent = new FakeAgentRuntime(
        {
          turns: [{ match: "go", steps: [{ tool: "adr_accept", input: { id: "9p8jj6p5" } }] }],
          fallback: "",
        },
        kiro.asTools(),
      );
      const log: string[] = [];
      for await (const e of agent.runTurn(
        {
          conversation: "local/c1",
          text: "go",
          context: { messages: [], openItems: [], decisions: [], references: [] } as never,
        },
        hooks(log),
      ))
        if (e.type === "tool-call" || e.type === "tool-result")
          events.push(`${e.type}:${e.type === "tool-call" ? e.decision : e.isError}`);
      expect(events).toEqual(["tool-call:denied-by-policy", "tool-result:true"]);
      expect(log).toEqual([]);
      expect(kiro.calls).toEqual([]);
    });
  });
});
