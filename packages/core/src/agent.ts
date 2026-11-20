import { z } from "zod";
import { type KiroRemoteTools, sdkToolName, toolPermission } from "./kiro.ts";

/**
 * The agent behind a conversation. One runtime serves many conversations and keeps one agent
 * session per conversation. The real one runs on the Claude Agent SDK in the desktop app; the
 * scripted fake below runs the same protocol for tests.
 */

export interface AgentIdentity {
  /** The model id, e.g. claude-opus-5-5. */
  readonly model: string;
  /** The runtime's version: the Agent SDK and Claude Code versions, or the fake's. */
  readonly version: string;
}

export type PermissionAnswer = { allow: true } | { allow: false; message: string };

export interface AgentTurnInput {
  conversation: string;
  text: string;
  /** Earlier messages of the conversation, from the log, for a session that starts after a restart. */
  history: readonly { role: "user" | "agent"; text: string }[];
  signal?: AbortSignal;
}

export interface AgentTurnHooks {
  /** Asked before a tool that needs the user's approval runs. */
  confirmTool(call: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  }): Promise<PermissionAnswer>;
}

export type AgentEvent =
  | { type: "model-call-start"; callId: string }
  | { type: "model-call-end"; callId: string; inputTokens: number; outputTokens: number }
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      decision: "allowed-read-only" | "approved-by-user" | "denied-by-user" | "denied-by-policy";
    }
  | {
      type: "tool-result";
      toolUseId: string;
      isError: boolean;
      text: string;
      structured: unknown;
      /** The permission decision, when it was made after the call was announced. */
      decision?: "allowed-read-only" | "approved-by-user" | "denied-by-user" | "denied-by-policy";
    }
  | { type: "done"; text: string; inputTokens: number; outputTokens: number; model: string }
  | { type: "error"; message: string };

export interface AgentRuntime extends AgentIdentity {
  runTurn(input: AgentTurnInput, hooks: AgentTurnHooks): AsyncIterable<AgentEvent>;
  /** Ends the agent session of one conversation. */
  closeConversation(conversation: string): void;
  close(): Promise<void>;
}

/**
 * Applies the tool policy: read-only tools run, tools that change things ask through `hooks`, and
 * everything else is refused. Shared by the SDK runtime's permission callback and the fake.
 */
export async function decideTool(
  name: string,
  input: Record<string, unknown>,
  toolUseId: string,
  hooks: AgentTurnHooks,
): Promise<{
  answer: PermissionAnswer;
  decision: Extract<AgentEvent, { type: "tool-call" }>["decision"];
}> {
  switch (toolPermission(name)) {
    case "allow":
      return { answer: { allow: true }, decision: "allowed-read-only" };
    case "ask": {
      const answer = await hooks.confirmTool({ toolUseId, name, input });
      return { answer, decision: answer.allow ? "approved-by-user" : "denied-by-user" };
    }
    default:
      return {
        answer: { allow: false, message: `${name} is not available in draft` },
        decision: "denied-by-policy",
      };
  }
}

/* ----------------------------------------------------------------------------------------------- */
/* The scripted fake                                                                                */
/* ----------------------------------------------------------------------------------------------- */

const StepSchema = z.union([
  z.object({
    text: z.string(),
    chunk: z.number().int().min(1).optional(),
    delayMs: z.number().min(0).optional(),
  }),
  z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
]);

export const FakeScriptSchema = z.object({
  turns: z.array(
    z.object({
      /** A regular expression the user's text must match; the first unused matching turn runs. */
      match: z.string().optional(),
      steps: z.array(StepSchema),
    }),
  ),
  /** What the fake says when no scripted turn matches. */
  fallback: z.string().default("I have nothing scripted for that."),
});
export type FakeScript = z.infer<typeof FakeScriptSchema>;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/** A scripted agent: streams scripted text and calls real tools through the same policy. */
export class FakeAgentRuntime implements AgentRuntime {
  readonly model: string;
  readonly version = "fake-1";
  private readonly used = new Set<number>();
  private calls = 0;

  constructor(
    private readonly script: FakeScript,
    private readonly tools: KiroRemoteTools,
    o: { model?: string } = {},
  ) {
    this.model = o.model ?? "fake-model";
  }

  async *runTurn(input: AgentTurnInput, hooks: AgentTurnHooks): AsyncIterable<AgentEvent> {
    const index = this.script.turns.findIndex(
      (t, i) =>
        !this.used.has(i) && (t.match === undefined || new RegExp(t.match, "i").test(input.text)),
    );
    const steps =
      index === -1 ? [{ text: this.script.fallback }] : (this.script.turns[index]?.steps ?? []);
    if (index !== -1) this.used.add(index);
    let text = "";
    let inTokens = 0;
    let outTokens = 0;
    for (const step of steps) {
      if (input.signal?.aborted) break;
      const callId = `fake-call-${++this.calls}`;
      yield { type: "model-call-start", callId };
      const promptTokens = 100 + Math.ceil(input.text.length / 4);
      if ("text" in step) {
        const piece = text === "" ? step.text : `\n\n${step.text}`;
        const size = step.chunk ?? 6;
        for (let i = 0; i < piece.length; i += size) {
          await sleep(step.delayMs ?? 15, input.signal);
          yield { type: "text-delta", text: piece.slice(i, i + size) };
        }
        text += piece;
        const out = Math.ceil(step.text.length / 4);
        inTokens += promptTokens;
        outTokens += out;
        yield { type: "model-call-end", callId, inputTokens: promptTokens, outputTokens: out };
      } else {
        inTokens += promptTokens;
        outTokens += 20;
        yield { type: "model-call-end", callId, inputTokens: promptTokens, outputTokens: 20 };
        const toolUseId = `toolu_fake_${this.calls}`;
        const name = sdkToolName(step.tool);
        const { answer, decision } = await decideTool(name, step.input, toolUseId, hooks);
        yield { type: "tool-call", toolUseId, name, input: step.input, decision };
        if (!answer.allow) {
          yield {
            type: "tool-result",
            toolUseId,
            isError: true,
            text: answer.message,
            structured: null,
          };
          continue;
        }
        try {
          const r = await this.tools.call(step.tool, step.input);
          yield {
            type: "tool-result",
            toolUseId,
            isError: r.isError,
            text: r.text,
            structured: r.structured,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "tool-result", toolUseId, isError: true, text: message, structured: null };
        }
      }
    }
    yield { type: "done", text, inputTokens: inTokens, outputTokens: outTokens, model: this.model };
  }

  closeConversation(): void {}
  async close(): Promise<void> {}
}
