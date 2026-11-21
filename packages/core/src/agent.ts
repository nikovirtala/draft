import { z } from "zod";
import type { AgentContext } from "./agent-context.ts";
import { type KiroRemoteTools, sdkToolName, toolPermission } from "./kiro.ts";

/**
 * The agent behind a conversation. One runtime serves many conversations and keeps one agent
 * session per conversation address. The real one speaks ACP to a local agent process in the
 * desktop app; the scripted fake below runs the same protocol for tests.
 */

export interface AgentIdentity {
  /** Which agent this is, as configured: "kiro", "claude", "fake". */
  readonly id: string;
  /** The model the agent reports, or "unreported" until it does. */
  readonly model: string;
  /** The agent's own name and version, as far as it reports them. */
  readonly version: string;
}

export type PermissionAnswer = { allow: true } | { allow: false; message: string };

/** A tool call about to change something, as the step that records it sees it. */
export interface StepCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentTurnInput {
  conversation: string;
  text: string;
  /**
   * What a session that starts with this turn starts from: the projection of the log for this
   * conversation. Only messages that reach the agent are in it. A runtime that keeps a session
   * across turns uses it for the first turn only.
   */
  context: AgentContext;
  signal?: AbortSignal;
}

/**
 * What an agent reports about a turn's use. Absent fields were not reported; draft never
 * estimates them.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cost the agent reports, such as Kiro's credits. */
  cost?: { amount: number; unit: string }[];
  /** How full the context window is, 0 to 100. */
  contextUsedPercent?: number;
}

export interface AgentTurnHooks {
  /** Asked before a tool that needs the user's approval runs. */
  confirmTool(call: StepCall): Promise<PermissionAnswer>;
  /**
   * Called once a call that changes something is allowed and before it runs: it durably records
   * the step's intent and returns its idempotency key. If it fails, the call is refused.
   */
  beginStep(call: StepCall): Promise<{ idempotencyKey: string }>;
}

export type AgentEvent =
  | {
      /** The runtime started an agent session for the conversation, from the turn's context. */
      type: "session-started";
    }
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
  | {
      /**
       * A call that changes something, or that draft can't tell from one, ran without a
       * permission request: no step was started before it.
       */
      type: "anomaly";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      status: string;
    }
  | { type: "done"; text: string; usage: AgentUsage | null; model: string }
  | { type: "error"; message: string };

export interface AgentRuntime extends AgentIdentity {
  runTurn(input: AgentTurnInput, hooks: AgentTurnHooks): AsyncIterable<AgentEvent>;
  /** Ends the agent session of one conversation. */
  closeConversation(conversation: string): void;
  close(): Promise<void>;
}

/**
 * The agents a conversation can run on. A thread runs on the default agent unless a person chose
 * another configured one when it started or switched it later.
 */
export interface AgentDirectory {
  readonly defaultId: string;
  /** Every configured agent, for choosing one. */
  list(): { id: string; label: string }[];
  /** The runtime of a configured agent; throws for one that isn't. */
  get(id: string): AgentRuntime;
}

/** A directory of one agent: every conversation runs on it. */
export function singleAgent(runtime: AgentRuntime): AgentDirectory {
  return {
    defaultId: runtime.id,
    list: () => [{ id: runtime.id, label: runtime.id }],
    get: (id) => {
      if (id !== runtime.id) throw new Error(`the agent "${id}" isn't configured`);
      return runtime;
    },
  };
}

/**
 * Applies the tool policy: read-only tools run, tools that change things ask through `hooks` and,
 * once allowed, begin a durable step before they run, and everything else is refused. Shared by
 * the ACP runtime's permission handler and the fake.
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
      if (!answer.allow) return { answer, decision: "denied-by-user" };
      // Intent before effect: the step is in the log before the tool runs, or the tool doesn't run.
      try {
        await hooks.beginStep({ toolUseId, name, input });
      } catch {
        return {
          answer: {
            allow: false,
            message: "draft could not record this action, so it did not run it.",
          },
          decision: "denied-by-policy",
        };
      }
      return { answer, decision: "approved-by-user" };
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
  /** A call that changes something and runs without asking, as a misbehaving agent would. */
  z.object({ unasked: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
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
  readonly id: string;
  readonly model: string;
  readonly version = "fake-1";
  /** Every turn this agent was given, so tests can check what reached it. */
  readonly received: AgentTurnInput[] = [];
  private readonly used = new Set<number>();
  private calls = 0;

  constructor(
    private readonly script: FakeScript,
    private readonly tools: KiroRemoteTools,
    o: { model?: string; id?: string } = {},
  ) {
    this.id = o.id ?? "fake";
    this.model = o.model ?? "fake-model";
  }

  async *runTurn(input: AgentTurnInput, hooks: AgentTurnHooks): AsyncIterable<AgentEvent> {
    this.received.push(input);
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
      } else if ("unasked" in step) {
        yield { type: "model-call-end", callId, inputTokens: promptTokens, outputTokens: 20 };
        yield {
          type: "anomaly",
          toolUseId: `toolu_fake_${this.calls}`,
          name: sdkToolName(step.unasked),
          input: step.input,
          status: "in_progress",
        };
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
    yield {
      type: "done",
      text,
      usage: { inputTokens: inTokens, outputTokens: outTokens },
      model: this.model,
    };
  }

  closeConversation(): void {}
  async close(): Promise<void> {}
}
