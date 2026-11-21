import type {
  CanUseTool,
  Options,
  SDKMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { type AgentEvent, sdkToolName } from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { ClaudeAgentRuntime, TurnMapper } from "../src/main/agent-sdk.ts";

const stream = (event: unknown): SDKMessage =>
  ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: "u",
    session_id: "s",
  }) as unknown as SDKMessage;

const result = (o: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "fallback",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    },
    ...o,
  }) as unknown as SDKMessage;

describe("the Agent SDK message mapping", () => {
  it("streams text, model calls and token usage", () => {
    const m = new TurnMapper(new Map());
    const events: AgentEvent[] = [
      { type: "system", subtype: "init", claude_code_version: "2.1.329" } as unknown as SDKMessage,
      stream({
        type: "message_start",
        message: { usage: { input_tokens: 5, cache_read_input_tokens: 2 } },
      }),
      stream({ type: "content_block_start", content_block: { type: "text" } }),
      stream({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }),
      stream({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }),
      stream({ type: "message_delta", usage: { output_tokens: 7 } }),
      stream({ type: "message_start", message: { usage: { input_tokens: 9 } } }),
      stream({ type: "content_block_start", content_block: { type: "text" } }),
      stream({ type: "content_block_delta", delta: { type: "text_delta", text: "Again" } }),
      result(),
    ].flatMap((x) => m.map(x));
    expect(m.claudeCodeVersion).toBe("2.1.329");
    expect(
      events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text),
    ).toEqual(["Hel", "lo", "\n\nAgain"]);
    expect(events.find((e) => e.type === "model-call-end")).toMatchObject({
      inputTokens: 7,
      outputTokens: 7,
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      text: "Hello\n\nAgain",
      inputTokens: 17,
      outputTokens: 20,
    });
  });

  it("maps tool calls and their results, with the permission decision", () => {
    const decisions = new Map([["toolu_2", "denied-by-user" as const]]);
    const m = new TurnMapper(decisions);
    const name = sdkToolName("kiro_launch_session");
    const events = [
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "toolu_2", name, input: { prompt: "x" } }] },
      } as unknown as SDKMessage,
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: true,
              content: [{ type: "text", text: "no" }],
            },
          ],
        },
      } as unknown as SDKMessage,
    ].flatMap((x) => m.map(x));
    expect(events).toEqual([
      {
        type: "tool-call",
        toolUseId: "toolu_2",
        name,
        input: { prompt: "x" },
        decision: "allowed-read-only",
      },
      {
        type: "tool-result",
        toolUseId: "toolu_2",
        isError: true,
        text: "no",
        structured: null,
        decision: "denied-by-user",
      },
    ]);
  });

  it("reports a failed result as an error", () => {
    const events = new TurnMapper(new Map()).map(
      result({ subtype: "error_during_execution", is_error: true }),
    );
    expect(events[0]).toEqual({ type: "error", message: "error_during_execution" });
  });
});

describe("the Agent SDK runtime", () => {
  /** A stand-in for query() that records options and asks canUseTool like Claude Code would. */
  function fakeQuery(asks: string[]) {
    let options: Options | undefined;
    const fn = ((params: { prompt: AsyncIterable<unknown>; options: Options }) => {
      options = params.options;
      const canUseTool = params.options.canUseTool as CanUseTool;
      async function* run(): AsyncGenerator<SDKMessage> {
        for await (const _ of params.prompt) {
          const answers: string[] = [];
          for (const [i, tool] of asks.entries()) {
            const r = await canUseTool(
              tool,
              {},
              { signal: new AbortController().signal, toolUseID: `t${i}`, requestId: `r${i}` },
            );
            answers.push(`${tool}=${r?.behavior}`);
          }
          yield result({ result: answers.join(","), usage: { input_tokens: 1, output_tokens: 1 } });
        }
      }
      const gen = run();
      return Object.assign(gen, { close: () => {} });
    }) as unknown as typeof sdkQuery;
    return { fn, options: () => options };
  }

  it("allows read-only Kiro tools without asking, asks for the rest, and denies everything else", async () => {
    const tools = [
      sdkToolName("kiro_get_session"),
      sdkToolName("kiro_launch_session"),
      sdkToolName("kiro_delete_session"),
      "Bash",
    ];
    const q = fakeQuery(tools);
    const runtime = new ClaudeAgentRuntime({
      model: "claude-opus-5-5",
      apiKey: "test-key-not-real",
      kiro: { url: "http://127.0.0.1:1/mcp", token: async () => "tok" },
      queryFn: q.fn,
    });
    const asked: string[] = [];
    const begun: string[] = [];
    const events: AgentEvent[] = [];
    for await (const e of runtime.runTurn(
      { conversation: "local/c1", text: "hi", history: [] },
      {
        confirmTool: async (c) => {
          asked.push(c.name);
          return c.name.endsWith("delete_session")
            ? { allow: false, message: "no" }
            : { allow: true };
        },
        beginStep: async (c) => {
          begun.push(c.name);
          return { idempotencyKey: "k" };
        },
      },
    )) {
      events.push(e);
    }
    expect(asked).toEqual([sdkToolName("kiro_launch_session"), sdkToolName("kiro_delete_session")]);
    // The approved call that changes something begins its step before Claude Code runs it.
    expect(begun).toEqual([sdkToolName("kiro_launch_session")]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      text: tools.map((t, i) => `${t}=${["allow", "allow", "deny", "deny"][i]}`).join(","),
    });

    const o = q.options() as Options;
    expect(o.model).toBe("claude-opus-5-5");
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toContain(sdkToolName("kiro_list_sessions"));
    expect(o.allowedTools).not.toContain(sdkToolName("kiro_launch_session"));
    expect(o.mcpServers?.["kiro-remote"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    // The key goes to the Claude Code process environment only.
    expect(o.env?.ANTHROPIC_API_KEY).toBe("test-key-not-real");
    expect(runtime.version).toMatch(/^agent-sdk 0\.3\.\d+/);
    await runtime.close();
  });
});
