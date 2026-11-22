import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";
import {
  type AgentEvent,
  type AgentTurnHooks,
  type AgentUsage,
  askAndBegin,
  decideTool,
  isPersonOnlyTool,
  type PermissionAnswer,
  personOnlyMessage,
} from "@nikovirtala/draft-core";
import { type CallPhase, TOO_LATE_TEXT } from "./call-policy.ts";
import type { ToolOutcome } from "./folder-tools.ts";
import { isKnownReadOnly, kiroUtilityCall, type ToolIdentity, toolIdentity } from "./tools.ts";

/**
 * Maps one turn of ACP traffic to draft's agent events, and answers the agent's permission
 * requests through draft's tool policy. It holds no connection: the runtime feeds it updates and
 * requests, and it pushes events. So it is tested on its own.
 *
 * The rules, which hold for every agent:
 * - A permission request goes through `decideTool`. A call that changes something that is allowed
 *   begins its durable step before the answer is sent, so before the agent proceeds.
 * - Only a one-time allow is ever chosen: draft never lets an agent save a rule of its own.
 * - A call that runs with no permission request is an anomaly, unless it is known to change
 *   nothing: no step was started before it.
 * - A call's result comes from `tool_call_update`: completed or failed.
 */

interface Call {
  id: string;
  title: string | null;
  kind: string | null;
  fields: { name?: string | null; _meta?: { [key: string]: unknown } | null };
  input: Record<string, unknown>;
  status: ToolCallStatus | null;
  /** How draft decided, once it has. */
  decision: Extract<AgentEvent, { type: "tool-call" }>["decision"] | null;
  /** A permission request arrived for this call. */
  asked: boolean;
  /** A `tool-call` event was sent for it. */
  announced: boolean;
  /** Reported as an anomaly, or answered with a refusal: nothing more is reported for it. */
  closed: boolean;
  text: string[];
  rawOutput: unknown;
}

const EXECUTING: ReadonlySet<string> = new Set(["in_progress", "completed", "failed"]);

export type Sink = (e: AgentEvent) => void;

export class TurnMapper {
  private readonly calls = new Map<string, Call>();
  private lastMessageId: string | null | undefined;
  private text = "";
  private sawToolSinceText = false;
  private usage: AgentUsage = {};
  private reported = false;
  /** Set when the turn is cancelled: later permission requests are answered "cancelled". */
  cancelled = false;
  /** Called with the model the agent reports, when a config update names one. */
  onModel: ((model: string) => void) | null = null;

  constructor(
    private readonly hooks: AgentTurnHooks,
    private readonly push: Sink,
    /** Which agent this is ("kiro", "claude", "generic"), for its known utility calls. */
    private readonly agentKind = "generic",
    /** The bare names of draft's own tools this session offers; none when it offers none. */
    private readonly draftTools: ReadonlySet<string> = new Set(),
  ) {}

  get fullText(): string {
    return this.text;
  }

  /** What the agent reported about this turn's use, or null when it reported nothing. */
  collectedUsage(): AgentUsage | null {
    return this.reported ? this.usage : null;
  }

  /** Usage the prompt response itself carried (the `usage` field, where an agent sends it). */
  addPromptUsage(response: unknown): void {
    const u = (response as { usage?: unknown } | null)?.usage;
    if (typeof u !== "object" || u === null) return;
    const r = u as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const input = num(r.inputTokens);
    const output = num(r.outputTokens);
    const total = num(r.totalTokens);
    if (input !== undefined) this.usage.inputTokens = input;
    if (output !== undefined) this.usage.outputTokens = output;
    if (total !== undefined) this.usage.totalTokens = total;
    if (input !== undefined || output !== undefined || total !== undefined) this.reported = true;
  }

  onUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text" || update.content.text === "") return;
        const id = update.messageId ?? null;
        // A new message (or text after a tool call) starts a new paragraph.
        const newMessage =
          this.text !== "" &&
          ((this.lastMessageId !== undefined && id !== this.lastMessageId && id !== null) ||
            (id === null && this.sawToolSinceText));
        const piece = (newMessage ? "\n\n" : "") + update.content.text;
        this.lastMessageId = id;
        this.sawToolSinceText = false;
        this.text += piece;
        this.push({ type: "text-delta", text: piece });
        return;
      }
      case "tool_call": {
        this.sawToolSinceText = true;
        const call = this.callFor(update.toolCallId);
        this.merge(call, update);
        this.afterUpdate(call);
        return;
      }
      case "tool_call_update": {
        this.sawToolSinceText = true;
        const call = this.callFor(update.toolCallId);
        this.merge(call, update);
        this.afterUpdate(call);
        return;
      }
      case "usage_update": {
        if (update.size > 0) {
          this.usage.contextUsedPercent = Math.round((update.used / update.size) * 1000) / 10;
          this.reported = true;
        }
        if (update.cost != null) {
          this.usage.cost = [
            ...(this.usage.cost ?? []).filter((c) => c.unit !== update.cost?.currency),
            { amount: update.cost.amount, unit: update.cost.currency },
          ];
          this.reported = true;
        }
        return;
      }
      case "session_info_update":
        this.onSessionInfo(update._meta);
        return;
      case "config_option_update":
        this.onConfig(update.configOptions);
        return;
      default:
        return;
    }
  }

  /** Kiro reports a turn's metering and the context window's fill as `session_info_update`s. */
  private onSessionInfo(meta: { [key: string]: unknown } | null | undefined): void {
    const kiro = meta?.kiro as Record<string, unknown> | undefined;
    if (kiro === undefined || typeof kiro !== "object") return;
    if (kiro.kind === "turn_completion" && Array.isArray(kiro.promptTurnSummaries)) {
      const cost: { amount: number; unit: string }[] = [];
      for (const s of kiro.promptTurnSummaries as Record<string, unknown>[]) {
        if (typeof s?.usage === "number" && typeof s.unit === "string")
          cost.push({ amount: s.usage, unit: s.unit });
      }
      if (cost.length > 0) {
        this.usage.cost = cost;
        this.reported = true;
      }
    } else if (kiro.kind === "context_usage" && typeof kiro.usagePercentage === "number") {
      this.usage.contextUsedPercent = Math.round(kiro.usagePercentage * 10) / 10;
      this.reported = true;
    }
  }

  private onConfig(options: unknown): void {
    const model = modelFromConfig(options);
    if (model !== null) this.onModel?.(model);
  }

  /**
   * The agent asks to run a tool. Applies draft's tool policy and answers with one of the options
   * the agent offered, never one it didn't.
   */
  async onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const call = this.callFor(req.toolCall.toolCallId);
    this.merge(call, req.toolCall, req._meta);
    call.asked = true;
    if (this.cancelled) return { outcome: { outcome: "cancelled" } };

    const identity = this.identityOf(call);
    const name = identity.name ?? call.title ?? "unknown";
    const allowOnce = pick(req.options, "allow_once");
    const rejectOnce = pick(req.options, "reject_once");

    let answer: PermissionAnswer;
    let decision: NonNullable<Call["decision"]>;
    if (call.decision === "approved-by-user") {
      // The same call asks again (Kiro asks once per resource): the person already allowed it,
      // and its step is already in the log.
      answer = { allow: true };
      decision = "approved-by-user";
    } else if (identity.source === "draft" && this.draftTools.has(identity.bare)) {
      // draft's own tool: draft's MCP server applies the policy and asks the person when the call
      // reaches it, whatever the agent's rules say. The agent's own request is answered yes, so
      // the person is asked once and by draft. The call's steps are reported by the server's side.
      call.closed = true;
      if (allowOnce === null)
        return rejectOnce === null
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId: rejectOnce.optionId } };
      return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
    } else if (identity.source !== "kiro-remote") {
      // Only Kiro Remote's tools are available in draft: a built-in tool, or a tool of a server
      // draft didn't give the agent, is refused without asking the person. One that accepts,
      // rejects or merges something is a person's act, and the agent is told so.
      answer = {
        allow: false,
        message: isPersonOnlyTool(name)
          ? personOnlyMessage(name)
          : `${name} is not available in draft`,
      };
      decision = "denied-by-policy";
    } else if (allowOnce === null) {
      // Without a one-time allow, the only way to say yes would be to let the agent save a rule.
      answer = { allow: false, message: "The agent offered no way to allow this one call." };
      decision = "denied-by-policy";
    } else {
      ({ answer, decision } = await decideTool(name, call.input, call.id, this.hooks));
    }
    call.decision = decision;
    if (!call.announced) {
      call.announced = true;
      this.push({ type: "tool-call", toolUseId: call.id, name, input: call.input, decision });
    }
    if (answer.allow && allowOnce !== null) {
      return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
    }
    // Refused: the agent is told, and the call is closed with the reason.
    const message = answer.allow ? "draft could not allow this call." : answer.message;
    call.closed = true;
    this.push({
      type: "tool-result",
      toolUseId: call.id,
      isError: true,
      text: message,
      structured: null,
      decision,
    });
    return rejectOnce === null
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: rejectOnce.optionId } };
  }

  /**
   * A call to one of draft's own tools, reached through draft's MCP server. The policy has said
   * what it is: a read runs and is logged, a change asks the person and begins a durable step
   * before it runs, and a refused call never runs. The step's result is the tool's settlement.
   * Returns what the agent is told.
   */
  async draftCall(c: {
    id: string;
    name: string;
    /** The input as logged and shown to the person: a file's content is a preview and a digest. */
    shown: Record<string, unknown>;
    verdict: { class: "read" | "change" | "refused"; reason?: string };
    run(o: { idempotencyKey?: string }): Promise<ToolOutcome>;
    /** Aborts when the call ends before it is over: the turn ended, or its time bound passed. */
    signal: AbortSignal;
    /**
     * Resolves when an agent request is waiting for this call, and throws once the call has ended.
     * A change begins its step only after it: a yes with nobody there to be told starts nothing.
     */
    admit(): Promise<void>;
    /** Says what the call is waiting for, for the agent's "call again" answer. */
    phase(p: CallPhase): void;
  }): Promise<{ text: string; isError: boolean }> {
    const finish = (
      decision: NonNullable<Call["decision"]>,
      text: string,
      structured: unknown = null,
      isError = true,
    ) => this.push({ type: "tool-result", toolUseId: c.id, isError, text, structured, decision });
    const announce = (decision: NonNullable<Call["decision"]>) =>
      this.push({
        type: "tool-call",
        toolUseId: c.id,
        name: c.name,
        input: c.shown,
        decision,
      });
    if (c.verdict.class === "refused") {
      const reason = c.verdict.reason ?? `${c.name} is not available in draft`;
      announce("denied-by-policy");
      finish("denied-by-policy", reason);
      return { text: reason, isError: true };
    }
    if (this.cancelled)
      return { text: "The turn was cancelled, so draft did not run it.", isError: true };
    if (c.verdict.class === "read") {
      announce("allowed-read-only");
      c.phase("running");
      const out = await runGuarded(c.run, {});
      this.push({
        type: "tool-result",
        toolUseId: c.id,
        isError: out.isError,
        text: out.summary,
        structured: out.structured,
      });
      return { text: out.text, isError: out.isError };
    }
    const r = await askAndBegin(c.name, c.shown, c.id, {
      confirmTool: (call) => this.hooks.confirmTool(call),
      // The step begins once the person said yes and a request is there to be told the result.
      beginStep: async (call) => {
        await c.admit();
        return this.hooks.beginStep(call);
      },
    });
    announce(r.decision);
    if (!r.answer.allow) {
      const text =
        r.decision === "denied-by-user"
          ? "The user declined this call, so draft did not run it."
          : c.signal.aborted
            ? TOO_LATE_TEXT
            : r.answer.message;
      finish(r.decision, text);
      return { text, isError: true };
    }
    if (c.signal.aborted || this.cancelled) {
      const text = "The turn ended before draft ran this call, so it did not run it.";
      finish("approved-by-user", text);
      return { text, isError: true };
    }
    c.phase("running");
    const out = await runGuarded(c.run, { idempotencyKey: r.idempotencyKey });
    this.push({
      type: "tool-result",
      toolUseId: c.id,
      isError: out.isError,
      text: out.summary,
      structured: out.structured,
      decision: "approved-by-user",
    });
    return { text: out.text, isError: out.isError };
  }

  private callFor(id: string): Call {
    let call = this.calls.get(id);
    if (call === undefined) {
      call = {
        id,
        title: null,
        kind: null,
        fields: {},
        input: {},
        status: null,
        decision: null,
        asked: false,
        announced: false,
        closed: false,
        text: [],
        rawOutput: undefined,
      };
      this.calls.set(id, call);
    }
    return call;
  }

  private merge(
    call: Call,
    u: {
      title?: string | null;
      kind?: string | null;
      status?: ToolCallStatus | null;
      name?: string | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: unknown;
      _meta?: { [key: string]: unknown } | null;
    },
    outerMeta?: { [key: string]: unknown } | null,
  ): void {
    if (typeof u.title === "string") call.title = u.title;
    if (typeof u.kind === "string") call.kind = u.kind;
    if (u.status != null) call.status = u.status;
    if (typeof u.name === "string") call.fields.name = u.name;
    // Merge `_meta` by namespace, one level deep, so a later update (or the request's own
    // `_meta`, which carries Kiro's consent) doesn't lose the identity an earlier one carried.
    for (const m of [u._meta, outerMeta]) {
      if (m == null) continue;
      const merged: { [key: string]: unknown } = { ...(call.fields._meta ?? {}) };
      for (const [k, v] of Object.entries(m)) {
        const before = merged[k];
        merged[k] = isPlain(before) && isPlain(v) ? { ...before, ...v } : v;
      }
      call.fields._meta = merged;
    }
    if (typeof u.rawInput === "object" && u.rawInput !== null && !Array.isArray(u.rawInput))
      call.input = u.rawInput as Record<string, unknown>;
    if (u.rawOutput !== undefined) call.rawOutput = u.rawOutput;
    if (Array.isArray(u.content)) {
      const parts: string[] = [];
      for (const c of u.content as {
        type?: string;
        content?: { type?: string; text?: string };
      }[]) {
        if (
          c?.type === "content" &&
          c.content?.type === "text" &&
          typeof c.content.text === "string"
        )
          parts.push(c.content.text);
      }
      if (parts.length > 0) call.text = parts;
    }
  }

  private identityOf(call: Call): ToolIdentity {
    return toolIdentity({ ...call.fields, title: call.title, kind: call.kind });
  }

  /** After any tool update: report a call that ran unasked, and the result of one that finished. */
  private afterUpdate(call: Call): void {
    if (call.closed || call.status === null || !EXECUTING.has(call.status)) return;
    const identity = this.identityOf(call);
    // draft's own tools are reported by the server that runs them, not by the agent's updates.
    if (identity.source === "draft" && this.draftTools.has(identity.bare)) {
      call.closed = true;
      return;
    }
    if (!call.asked && !call.announced) {
      const utility = kiroUtilityCall(this.agentKind, {
        kind: call.kind,
        title: call.title,
        input: call.input,
        meta: call.fields._meta,
      });
      if (utility !== null || isKnownReadOnly(identity, call.kind)) {
        call.decision = "allowed-read-only";
        call.announced = true;
        this.push({
          type: "tool-call",
          toolUseId: call.id,
          name: utility ?? identity.name ?? call.title ?? "unknown",
          input: call.input,
          decision: "allowed-read-only",
        });
      } else {
        // It ran, or is running, and was never asked about: no step was started before it.
        call.closed = true;
        this.push({
          type: "anomaly",
          toolUseId: call.id,
          name: identity.name ?? call.title ?? "unknown",
          input: call.input,
          status: call.status,
        });
        return;
      }
    }
    if (call.status === "completed" || call.status === "failed") {
      const text =
        call.text.length > 0
          ? call.text.join("\n")
          : call.rawOutput === undefined
            ? ""
            : typeof call.rawOutput === "string"
              ? call.rawOutput
              : JSON.stringify(call.rawOutput);
      call.closed = true;
      this.push({
        type: "tool-result",
        toolUseId: call.id,
        isError: call.status === "failed",
        text,
        structured: parseJson(text) ?? (typeof call.rawOutput === "object" ? call.rawOutput : null),
        ...(call.decision === null ? {} : { decision: call.decision }),
      });
    }
  }
}

async function runGuarded(
  run: (o: { idempotencyKey?: string | undefined }) => Promise<ToolOutcome>,
  o: { idempotencyKey?: string | undefined },
): Promise<ToolOutcome> {
  try {
    return await run(o);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, text: message, summary: message, structured: null };
  }
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(options: readonly PermissionOption[], kind: PermissionOption["kind"]) {
  return options.find((o) => o.kind === kind) ?? null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The model a session's `configOptions` name as current, or null when none is a model option. */
export function modelFromConfig(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  for (const o of options as Record<string, unknown>[]) {
    if (o?.id !== "model" && o?.category !== "model") continue;
    const current = o.currentValue;
    if (typeof current !== "string" || current === "") continue;
    const list = Array.isArray(o.options) ? (o.options as Record<string, unknown>[]) : [];
    const chosen = list.find((x) => x.value === current);
    // The Claude adapter's "default" is a label for whatever the account's default model is.
    if (current === "default" && typeof chosen?.description === "string")
      return `default (${chosen.description})`;
    return current;
  }
  return null;
}
