import { context as otelContext, ROOT_CONTEXT, type Span, trace } from "@opentelemetry/api";
import { conversationKey, itemAddress } from "./address.ts";
import type { AgentEvent, AgentRuntime, PermissionAnswer } from "./agent.ts";
import {
  type Actor,
  type DraftEvent,
  type EdgeKind,
  type EventDraft,
  isUnknown,
  type Target,
  targetKey,
} from "./events.ts";
import { newItemId } from "./ids.ts";
import { summarizeResult } from "./kiro.ts";
import type { LogStore } from "./log.ts";
import type { Projection } from "./projection.ts";
import { type PollerOptions, type Resolver, StubPoller, sameState } from "./resolver.ts";
import { draftMetrics, failSpan, logEvent, tracer } from "./telemetry.ts";
import { DRAFT_VERSION } from "./version.ts";
import { type MessageSegment, segmentMessage } from "./view.ts";

export interface UiReference {
  target: string;
  type: string;
  id: string;
  kind: string;
  source: string;
  /** The target's state when it was referenced. */
  snapshot: Record<string, unknown>;
}

export interface UiMessage {
  address: string;
  role: "user" | "agent";
  at: string;
  text: string;
  segments: MessageSegment[];
  references: UiReference[];
}

export interface UiStub {
  target: string;
  type: string;
  id: string;
  state: Record<string, unknown>;
  observedAt: string;
}

export interface UiPrompt {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** One block of the conversation, in log order. Messages are looked up in `messages`. */
export type UiBlock =
  | { kind: "message"; address: string }
  | {
      /** An event this version of draft doesn't understand, kept in the log as received. */
      kind: "unknown";
      id: string;
      type: string;
      schema: number;
      reason: "unknown-type" | "newer-schema";
      at: string | null;
    };

export interface UiState {
  context: string;
  conversation: string;
  title: string;
  agent: { model: string; version: string };
  messages: UiMessage[];
  timeline: UiBlock[];
  stubs: Record<string, UiStub>;
  streaming: { address: string; text: string } | null;
  prompts: UiPrompt[];
  busy: boolean;
  error: string | null;
}

export type UiChange =
  | { type: "state"; state: UiState }
  | { type: "delta"; address: string; text: string };

export interface ConversationOptions {
  log: LogStore;
  projection: Projection;
  agent: AgentRuntime;
  resolvers: readonly Resolver[];
  /** The person at this device. The agent and resolvers have their own actors. */
  user: UserActor;
  context?: string;
  title?: string;
  poller?: PollerOptions;
  newId?: () => string;
}

export type UserActor = Extract<Actor, { kind: "user" }>;

const SYSTEM: Actor = { kind: "system", id: "draft", version: DRAFT_VERSION };

/**
 * One conversation: the turn loop, references and live stubs, on top of the log. Everything it
 * shows is computed from the projection, which is computed from the log.
 */
export class ConversationService {
  readonly context: string;
  readonly conversation: string;
  private readonly log: LogStore;
  private readonly projection: Projection;
  private readonly agent: AgentRuntime;
  private readonly resolvers: Map<string, Resolver>;
  private readonly user: UserActor;
  private readonly newId: (() => string) | undefined;
  private readonly listeners = new Set<(c: UiChange) => void>();
  private readonly prompts = new Map<
    string,
    { prompt: UiPrompt; resolve: (a: PermissionAnswer) => void }
  >();
  private streaming: { address: string; text: string } | null = null;
  private busy = false;
  private error: string | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  readonly poller: StubPoller;

  private constructor(o: ConversationOptions, conversation: string) {
    this.log = o.log;
    this.projection = o.projection;
    this.agent = o.agent;
    this.resolvers = new Map(o.resolvers.map((r) => [r.type, r]));
    this.user = o.user;
    this.newId = o.newId;
    this.conversation = conversation;
    this.context = conversation.split("/")[0] as string;
    const m = draftMetrics();
    this.poller = new StubPoller(
      this.resolvers,
      (t) => this.projection.stub(targetKey(t))?.state ?? null,
      (t, state, resolver) => this.observe(t, state, resolver),
      (r) => {
        m.resolverPolls.add(1, {
          "draft.resolver": r.target.type,
          "draft.poll.outcome": r.outcome,
        });
        if (r.outcome === "failed") m.resolverFailures.add(1, { "draft.resolver": r.target.type });
        m.stepDuration.record(r.durationMs, { "draft.step": "resolver.poll" });
      },
      o.poller,
    );
  }

  /**
   * Opens the conversation: brings the projection up to date with the log and, on first run,
   * writes the context and its first conversation. One context, one conversation in this slice.
   */
  static async open(o: ConversationOptions): Promise<ConversationService> {
    o.projection.sync(o.log.events());
    const unknown = new Map<string, number>();
    for (const r of o.log.events()) {
      if (isUnknown(r)) unknown.set(r.reason, (unknown.get(r.reason) ?? 0) + 1);
    }
    for (const [reason, n] of unknown) {
      draftMetrics().unknownEvents.add(n, { "draft.log.unknown_reason": reason });
    }
    let conv = o.projection.conversations()[0]?.conversation;
    if (conv === undefined) {
      const ctx = o.context ?? "local";
      conv = conversationKey(ctx, newItemId(o.newId));
      const drafts: EventDraft[] = [];
      if (!o.log.events().some((e) => e.type === "context.created")) {
        drafts.push({
          type: "context.created",
          address: `${ctx}@1`,
          conversation: null,
          actor: SYSTEM,
          traceId: null,
          data: { context: ctx, title: "Local" },
        });
      }
      drafts.push({
        type: "conversation.created",
        address: `${conv}@1`,
        conversation: conv,
        actor: SYSTEM,
        traceId: null,
        data: { conversation: conv, title: o.title ?? "Conversation", parent: null },
      });
      const sealed = await o.log.append(drafts);
      o.projection.applyAll(sealed);
    }
    return new ConversationService(o, conv);
  }

  onChange(cb: (c: UiChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  state(): UiState {
    const edges = this.projection.edges(this.conversation);
    const refsByMessage = new Map<string, UiReference[]>();
    for (const e of edges) {
      const [type, ...rest] = e.target.split(":");
      const list = refsByMessage.get(e.from) ?? [];
      if (!list.some((r) => r.target === e.target)) {
        list.push({
          target: e.target,
          type: type as string,
          id: rest.join(":"),
          kind: e.kind,
          source: e.source,
          snapshot: e.snapshot,
        });
      }
      refsByMessage.set(e.from, list);
    }
    const stubs: Record<string, UiStub> = {};
    for (const s of this.projection.stubs()) stubs[s.target] = s;
    const conv = this.projection.conversations().find((c) => c.conversation === this.conversation);
    const messages = this.projection.messages(this.conversation);
    return {
      context: this.context,
      conversation: this.conversation,
      title: conv?.title ?? "Conversation",
      agent: { model: this.agent.model, version: this.agent.version },
      messages: messages.map((m) => ({
        address: m.address,
        role: m.role,
        at: m.at,
        text: m.text,
        segments: segmentMessage(m.text),
        references: refsByMessage.get(m.address) ?? [],
      })),
      timeline: this.timeline(messages),
      stubs,
      streaming: this.streaming,
      prompts: [...this.prompts.values()].map((p) => p.prompt),
      busy: this.busy,
      error: this.error,
    };
  }

  /** Messages and the blocks between them, in log order. */
  private timeline(messages: readonly { address: string; seq: number }[]): UiBlock[] {
    const blocks: { seq: number; block: UiBlock }[] = messages.map((m) => ({
      seq: m.seq,
      block: { kind: "message", address: m.address },
    }));
    for (const u of this.projection.unknownEvents(this.conversation)) {
      blocks.push({
        seq: u.seq,
        block: {
          kind: "unknown",
          id: u.eventId,
          type: u.type,
          schema: u.schema,
          reason: u.reason,
          at: u.at,
        },
      });
    }
    return blocks.sort((a, b) => a.seq - b.seq).map((b) => b.block);
  }

  /** The stubs' targets on screen; only these are polled. */
  setVisible(targets: readonly Target[]): void {
    this.poller.setVisible(targets.filter((t) => this.resolvers.has(t.type)));
  }

  /** Polls the visible stubs that are due. The host calls this on a timer. */
  async tick(): Promise<void> {
    await this.poller.runDue();
  }

  answerPrompt(id: string, allow: boolean): void {
    const p = this.prompts.get(id);
    if (p === undefined) return;
    this.prompts.delete(id);
    p.resolve(
      allow ? { allow: true } : { allow: false, message: "The user declined this action." },
    );
    this.emitState();
  }

  reportInvalidView(reason: "not-json" | "schema"): void {
    draftMetrics().invalidViews.add(1, { "draft.view.invalid_reason": reason });
  }

  /** Runs one turn: the user's message, the agent's streamed answer, its tool calls, references. */
  async submit(text: string): Promise<void> {
    if (this.busy) throw new Error("a turn is already running");
    if (text.trim() === "") return;
    this.busy = true;
    this.error = null;
    const m = draftMetrics();
    const span = tracer().startSpan(
      "draft.turn",
      { attributes: { "draft.conversation": this.conversation } },
      ROOT_CONTEXT,
    );
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    const traceId = span.spanContext().traceId;
    const started = performance.now();
    let toolCount = 0;
    let tokens = { input: 0, output: 0 };
    try {
      await otelContext.with(ctx, async () => {
        const history = this.projection
          .messages(this.conversation)
          .map((msg) => ({ role: msg.role, text: msg.text }));
        const userAddress = itemAddress(this.conversation, newItemId(this.newId));
        span.setAttribute("draft.message.user", userAddress);
        await this.append(
          [
            {
              type: "message.posted",
              address: userAddress,
              conversation: this.conversation,
              actor: this.user,
              traceId,
              data: { role: "user", text },
            },
          ],
          "user.message",
        );
        await this.makeReferences(userAddress, [{ text, source: "text" }], "explicit", traceId);

        const agentAddress = itemAddress(this.conversation, newItemId(this.newId));
        span.setAttribute("draft.message.agent", agentAddress);
        this.streaming = { address: agentAddress, text: "" };
        this.emitState();

        const modelSpans = new Map<string, { span: Span; t0: number }>();
        const toolSpans = new Map<
          string,
          { span: Span; t0: number; call: Extract<AgentEvent, { type: "tool-call" }> }
        >();
        const toolTexts: { text: string; source: "tool-result" }[] = [];
        let final = "";
        let failure: string | null = null;
        // Read when each event is written: a runtime may learn its version during the turn.
        const agentActor = (): Actor => ({
          kind: "agent",
          id: "draft-agent",
          model: this.agent.model,
          version: this.agent.version,
        });

        const agentSpan = tracer().startSpan("draft.agent.turn", {
          attributes: { "gen_ai.request.model": this.agent.model },
        });
        const agentCtx = trace.setSpan(ctx, agentSpan);
        const events = this.agent.runTurn(
          { conversation: this.conversation, text, history },
          {
            confirmTool: (call) =>
              otelContext.with(agentCtx, async () => {
                const ask = tracer().startSpan("draft.permission.ask", {
                  attributes: { "draft.tool.name": call.name, "draft.tool.use_id": call.toolUseId },
                });
                const answer = await new Promise<PermissionAnswer>((resolve) => {
                  this.prompts.set(call.toolUseId, {
                    prompt: { id: call.toolUseId, tool: call.name, input: call.input },
                    resolve,
                  });
                  this.emitState();
                });
                ask.setAttribute("draft.permission.allowed", answer.allow);
                ask.end();
                return answer;
              }),
          },
        );
        for await (const ev of events) {
          switch (ev.type) {
            case "model-call-start": {
              const s = tracer().startSpan("draft.model.call", {}, agentCtx);
              modelSpans.set(ev.callId, { span: s, t0: performance.now() });
              break;
            }
            case "model-call-end": {
              const s = modelSpans.get(ev.callId);
              if (s !== undefined) {
                s.span.setAttributes({
                  "gen_ai.usage.input_tokens": ev.inputTokens,
                  "gen_ai.usage.output_tokens": ev.outputTokens,
                });
                s.span.end();
                m.stepDuration.record(performance.now() - s.t0, { "draft.step": "model.call" });
                modelSpans.delete(ev.callId);
              }
              break;
            }
            case "text-delta":
              if (this.streaming !== null) {
                this.streaming.text += ev.text;
                this.emit({ type: "delta", address: agentAddress, text: ev.text });
              }
              break;
            case "tool-call": {
              const s = tracer().startSpan(
                "draft.tool.call",
                {
                  attributes: {
                    "draft.tool.name": ev.name,
                    "draft.tool.use_id": ev.toolUseId,
                    "draft.tool.decision": ev.decision,
                  },
                },
                agentCtx,
              );
              toolSpans.set(ev.toolUseId, { span: s, t0: performance.now(), call: ev });
              break;
            }
            case "tool-result": {
              const t = toolSpans.get(ev.toolUseId);
              const call =
                t?.call === undefined
                  ? undefined
                  : { ...t.call, decision: ev.decision ?? t.call.decision };
              toolSpans.delete(ev.toolUseId);
              toolCount++;
              const ran =
                call === undefined ||
                call.decision === "allowed-read-only" ||
                call.decision === "approved-by-user";
              await otelContext.with(
                t === undefined ? agentCtx : trace.setSpan(agentCtx, t.span),
                () =>
                  this.append(
                    [
                      {
                        type: "agent.tool_called",
                        address: itemAddress(this.conversation, newItemId(this.newId)),
                        conversation: this.conversation,
                        actor: agentActor(),
                        traceId,
                        data: {
                          toolUseId: ev.toolUseId,
                          name: call?.name ?? "unknown",
                          input: call?.input ?? {},
                          decision: call?.decision ?? "allowed-read-only",
                          resultSummary: ran
                            ? summarizeResult({
                                isError: ev.isError,
                                text: ev.text,
                                structured: ev.structured,
                              })
                            : null,
                          isError: ev.isError,
                        },
                      },
                    ],
                    "tool.log",
                  ),
              );
              if (ran && !ev.isError) {
                toolTexts.push({
                  text: ev.text !== "" ? ev.text : JSON.stringify(ev.structured ?? null),
                  source: "tool-result",
                });
              }
              m.toolCalls.add(1, {
                "draft.tool.name": call?.name ?? "unknown",
                "draft.tool.decision": call?.decision ?? "unknown",
                "draft.tool.outcome": ev.isError ? "error" : "ok",
              });
              if (t !== undefined) {
                t.span.setAttribute("draft.tool.is_error", ev.isError);
                t.span.end();
                m.stepDuration.record(performance.now() - t.t0, { "draft.step": "tool.call" });
              }
              break;
            }
            case "done":
              final = ev.text;
              tokens = { input: ev.inputTokens, output: ev.outputTokens };
              break;
            case "error":
              failure = ev.message;
              break;
          }
        }
        for (const s of modelSpans.values()) s.span.end();
        for (const t of toolSpans.values()) t.span.end();
        agentSpan.setAttributes({
          "gen_ai.usage.input_tokens": tokens.input,
          "gen_ai.usage.output_tokens": tokens.output,
          "draft.tool_calls": toolCount,
        });
        if (failure !== null) failSpan(agentSpan, new Error("agent"));
        agentSpan.end();

        const replyText =
          final !== ""
            ? final
            : failure !== null
              ? `I couldn't answer: ${failure}`
              : (this.streaming?.text ?? "");
        this.streaming = null;
        if (failure !== null) this.error = failure;
        await this.append(
          [
            {
              type: "message.posted",
              address: agentAddress,
              conversation: this.conversation,
              actor: agentActor(),
              traceId,
              data: { role: "agent", text: replyText },
            },
          ],
          "agent.message",
        );
        await this.makeReferences(
          agentAddress,
          [{ text: replyText, source: "text" }, ...toolTexts],
          "structural",
          traceId,
        );
      });
      m.turns.add(1, { "draft.turn.outcome": this.error === null ? "ok" : "error" });
      m.turnTokens.record(tokens.input, { "gen_ai.token.type": "input" });
      m.turnTokens.record(tokens.output, { "gen_ai.token.type": "output" });
      span.setAttributes({
        "gen_ai.usage.input_tokens": tokens.input,
        "gen_ai.usage.output_tokens": tokens.output,
        "draft.tool_calls": toolCount,
      });
    } catch (err) {
      failSpan(span, err);
      this.error = err instanceof Error ? err.name : "error";
      m.turns.add(1, { "draft.turn.outcome": "error" });
      throw err;
    } finally {
      const ms = performance.now() - started;
      m.stepDuration.record(ms, { "draft.step": "turn" });
      logEvent("draft.turn.completed", {
        "draft.conversation": this.conversation,
        "draft.trace_id": traceId,
        "draft.tool_calls": toolCount,
        "gen_ai.usage.input_tokens": tokens.input,
        "gen_ai.usage.output_tokens": tokens.output,
        "draft.duration_ms": Math.round(ms),
      });
      span.end();
      this.streaming = null;
      this.busy = false;
      this.emitState();
    }
  }

  /** Detects mentions, confirms each with its resolver, and records a reference with a snapshot. */
  private async makeReferences(
    from: string,
    texts: readonly { text: string; source: "text" | "tool-result" }[],
    kind: EdgeKind,
    traceId: string,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const { text, source } of texts) {
      for (const resolver of this.resolvers.values()) {
        for (const id of resolver.detect(text)) {
          const target = { type: resolver.type, id };
          const key = targetKey(target);
          if (seen.has(key)) continue;
          seen.add(key);
          const span = tracer().startSpan("draft.resolver.snapshot", {
            attributes: { "draft.resolver": resolver.type },
          });
          const t0 = performance.now();
          let snapshot: Record<string, unknown> | null;
          try {
            snapshot = await resolver.fetch(id);
          } catch (err) {
            failSpan(span, err);
            span.end();
            draftMetrics().resolverFailures.add(1, { "draft.resolver": resolver.type });
            continue;
          }
          draftMetrics().resolverPolls.add(1, {
            "draft.resolver": resolver.type,
            "draft.poll.outcome": snapshot === null ? "missing" : "snapshot",
          });
          draftMetrics().stepDuration.record(performance.now() - t0, {
            "draft.step": "resolver.snapshot",
          });
          span.setAttribute("draft.resolver.found", snapshot !== null);
          span.end();
          if (snapshot === null) continue;
          const known = this.projection.stub(key)?.state;
          const drafts: EventDraft[] = [
            {
              type: "reference.made",
              address: itemAddress(this.conversation, newItemId(this.newId)),
              conversation: this.conversation,
              actor: kind === "explicit" ? this.user : SYSTEM,
              traceId,
              data: { from, target, kind, relation: "mentions", source, snapshot },
            },
          ];
          if (known !== undefined && !sameState(known, snapshot)) {
            drafts.push(this.statusDraft(target, snapshot, resolver, traceId));
          }
          await this.append(drafts, "reference");
        }
      }
    }
  }

  private statusDraft(
    target: Target,
    state: Record<string, unknown>,
    resolver: Resolver,
    traceId: string | null,
  ): EventDraft {
    return {
      type: "status.observed",
      address: itemAddress(this.conversation, newItemId(this.newId)),
      conversation: this.conversation,
      actor: { kind: "resolver", id: resolver.type, version: resolver.version },
      traceId,
      data: { target, state },
    };
  }

  private async observe(
    target: Target,
    state: Record<string, unknown>,
    resolver: Resolver,
  ): Promise<void> {
    const span = tracer().startSpan(
      "draft.resolver.observed",
      { attributes: { "draft.resolver": resolver.type } },
      ROOT_CONTEXT,
    );
    try {
      await otelContext.with(trace.setSpan(ROOT_CONTEXT, span), () =>
        this.append(
          [this.statusDraft(target, state, resolver, span.spanContext().traceId)],
          "status",
        ),
      );
    } finally {
      span.end();
    }
    this.emitState();
  }

  private async append(drafts: EventDraft[], step: string): Promise<DraftEvent[]> {
    const span = tracer().startSpan("draft.log.append", {
      attributes: { "draft.log.events": drafts.length, "draft.log.step": step },
    });
    const t0 = performance.now();
    try {
      // The log and the projection advance together, one batch at a time.
      const run = this.writes.then(async () => {
        const sealed = await this.log.append(drafts);
        for (const e of sealed) this.projection.apply(e);
        return sealed;
      });
      this.writes = run.catch(() => {});
      const sealed = await run;
      span.setAttribute(
        "draft.event.ids",
        sealed.map((e) => e.id),
      );
      this.emitState();
      return sealed;
    } catch (err) {
      failSpan(span, err);
      throw err;
    } finally {
      draftMetrics().stepDuration.record(performance.now() - t0, { "draft.step": "log.append" });
      span.end();
    }
  }

  private emitState(): void {
    if (this.listeners.size === 0) return;
    this.emit({ type: "state", state: this.state() });
  }

  private emit(c: UiChange): void {
    for (const l of this.listeners) l(c);
  }

  async close(): Promise<void> {
    for (const p of this.prompts.values())
      p.resolve({ allow: false, message: "draft is closing." });
    this.prompts.clear();
    this.agent.closeConversation(this.conversation);
  }
}
