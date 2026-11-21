import { context as otelContext, ROOT_CONTEXT, type Span, trace } from "@opentelemetry/api";
import { conversationKey, itemAddress } from "./address.ts";
import {
  type AgentDirectory,
  type AgentEvent,
  type AgentRuntime,
  type AgentUsage,
  type PermissionAnswer,
  singleAgent,
} from "./agent.ts";
import { buildAgentContext, contextDigest } from "./agent-context.ts";
import {
  type Actor,
  type AgentState,
  type Audience,
  type DraftEvent,
  type EdgeKind,
  type EventDraft,
  isUnknown,
  PEOPLE_AND_AGENT,
  PEOPLE_ONLY,
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
  /** Who the message is for. A message the agent can't read is an aside. */
  audience: Audience;
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
    }
  | {
      /**
       * Something that needs a person, derived from the log: a step that started but never
       * finished (draft stopped, or lost the result, while it ran, so it may or may not have
       * happened; it is never run again), or a call that ran without the agent asking first.
       */
      kind: "interrupt";
      cause: "unfinished-step" | "unasked-call";
      id: string;
      tool: string;
      input: unknown;
      /** The step's key; a call that ran unasked had no step. */
      idempotencyKey: string | null;
      at: string;
    }
  | {
      /** The log's last line was never completed; its bytes were moved aside when it opened. */
      kind: "notice";
      id: string;
      what: "log-recovered";
      sidecar: string;
      bytes: number;
      at: string;
    };

export interface UiState {
  context: string;
  conversation: string;
  /** The message this conversation branched off, or null for the main conversation. */
  parent: string | null;
  title: string;
  agent: { id: string; model: string; version: string; state: AgentState };
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
  | { type: "delta"; conversation: string; address: string; text: string };

/**
 * Span and log attributes for what an agent reported about a turn's use. Nothing is filled in for
 * what it didn't report, and `draft.usage.reported` says whether it reported anything.
 */
export function usageAttributes(
  usage: AgentUsage | null,
): Record<string, string | number | boolean> {
  const a: Record<string, string | number | boolean> = { "draft.usage.reported": usage !== null };
  if (usage === null) return a;
  if (usage.inputTokens !== undefined) a["gen_ai.usage.input_tokens"] = usage.inputTokens;
  if (usage.outputTokens !== undefined) a["gen_ai.usage.output_tokens"] = usage.outputTokens;
  if (usage.totalTokens !== undefined) a["draft.usage.total_tokens"] = usage.totalTokens;
  if (usage.contextUsedPercent !== undefined)
    a["draft.usage.context_used_percent"] = usage.contextUsedPercent;
  for (const c of usage.cost ?? []) {
    a[`draft.usage.cost.${c.unit}`] = c.amount;
  }
  return a;
}

export interface SubmitOptions {
  /** Post for people only: the agent never reads it, and no turn starts. */
  aside?: boolean;
}

/** `@agent` anywhere in a message, as a word of its own. */
export const AGENT_MENTION = /(?:^|[^\w@])@agent\b/i;

export interface ConversationOptions {
  log: LogStore;
  projection: Projection;
  /** The agent every conversation runs on, unless a person chose another one for a thread. */
  agent: AgentRuntime;
  /** The agents a thread can run on. Without it, every conversation runs on `agent`. */
  agents?: AgentDirectory;
  /** Shared by every conversation of one log, so the log and the projection advance in step. */
  writer?: SerialWriter;
  resolvers: readonly Resolver[];
  /** The person at this device. The agent and resolvers have their own actors. */
  user: UserActor;
  context?: string;
  title?: string;
  poller?: PollerOptions;
  newId?: () => string;
}

export type UserActor = Extract<Actor, { kind: "user" }>;

/**
 * Runs writes one after the other. Every conversation of a log shares one, so an event reaches the
 * log and the projection in the same order.
 */
export class SerialWriter {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f);
    this.chain = run.catch(() => {});
    return run;
  }
}

/** Something that needs a person in one conversation: one count, in one order, across all of them. */
export interface AttentionItem {
  id: string;
  conversation: string;
  cause: "permission" | "unfinished-step" | "unasked-call";
  at: string;
}

/**
 * A thread's own state. Only `open` exists so far; what closes a thread (a measurable sign of use
 * in production, a conclusion that returns to the main conversation) adds states here.
 */
export type ThreadState = "open";

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
  private readonly agents: AgentDirectory;
  private readonly writer: SerialWriter;
  private readonly resolvers: Map<string, Resolver>;
  private readonly user: UserActor;
  private readonly newId: (() => string) | undefined;
  private readonly listeners = new Set<(c: UiChange) => void>();
  private readonly prompts = new Map<
    string,
    { prompt: UiPrompt; at: string; resolve: (a: PermissionAnswer) => void }
  >();
  private streaming: { address: string; text: string } | null = null;
  private busy = false;
  /** The turn in progress, for pausing it. `addressed` means @agent started it in a paused conversation. */
  private turn: { abort: AbortController; addressed: boolean } | null = null;
  private error: string | null = null;
  /** Steps this process started and is waiting on, by tool use id. Every other open step is interrupted. */
  private readonly stepsInFlight = new Map<string, { started: string; idempotencyKey: string }>();
  readonly poller: StubPoller;

  private constructor(o: ConversationOptions, conversation: string) {
    this.log = o.log;
    this.projection = o.projection;
    this.agents = o.agents ?? singleAgent(o.agent);
    this.writer = o.writer ?? new SerialWriter();
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
    // Steps left open by an earlier run: shown as interrupts, never run again.
    const interrupted = o.projection
      .conversations()
      .flatMap((c) => o.projection.steps(c.conversation))
      .filter((s) => s.outcome === null).length;
    if (interrupted > 0) draftMetrics().interruptedSteps.add(interrupted);
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

  /** A service for a conversation that exists already, such as a thread. */
  static attach(o: ConversationOptions, conversation: string): ConversationService {
    if (!o.projection.conversations().some((c) => c.conversation === conversation))
      throw new Error(`no such conversation: ${conversation}`);
    return new ConversationService(o, conversation);
  }

  /** The agent this conversation runs on: the one a person chose for it, else the default. */
  runtime(): AgentRuntime {
    return this.agents.get(this.projection.agentOf(this.conversation) ?? this.agents.defaultId);
  }

  /** Whether this conversation is a thread: it branched off a message. */
  private isThread(): boolean {
    return (
      this.projection.conversations().find((c) => c.conversation === this.conversation)?.parent !==
      null
    );
  }

  /**
   * What needs a person here, computed from the log (steps that never finished, calls that ran
   * without asking) and from the permission requests waiting now. The workspace puts every
   * conversation's items in one order.
   */
  attention(): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const b of this.timeline(this.projection.messages(this.conversation))) {
      if (b.kind !== "interrupt") continue;
      items.push({
        id: b.id,
        conversation: this.conversation,
        cause: b.cause === "unasked-call" ? "unasked-call" : "unfinished-step",
        at: b.at,
      });
    }
    for (const p of this.prompts.values())
      items.push({
        id: p.prompt.id,
        conversation: this.conversation,
        cause: "permission",
        at: p.at,
      });
    return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
    let runtime: AgentRuntime | null = null;
    try {
      runtime = this.runtime();
    } catch {
      // The agent chosen for this thread is no longer configured; the turn says so.
    }
    return {
      context: this.context,
      conversation: this.conversation,
      parent: conv?.parent ?? null,
      title: conv?.title ?? "Conversation",
      agent: {
        id: runtime?.id ?? this.projection.agentOf(this.conversation) ?? this.agents.defaultId,
        model: runtime?.model ?? "unavailable",
        version: runtime?.version ?? "not configured",
        state: this.projection.agentState(this.conversation),
      },
      messages: messages.map((m) => ({
        address: m.address,
        role: m.role,
        at: m.at,
        text: m.text,
        segments: segmentMessage(m.text),
        references: refsByMessage.get(m.address) ?? [],
        audience: m.audience,
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
    const thread = this.isThread();
    for (const u of this.projection.unknownEvents(this.conversation)) {
      // An event of no known conversation might belong anywhere: the main conversation shows it.
      if (thread && u.conversation === null) continue;
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
    const running = new Set([...this.stepsInFlight.values()].map((s) => s.started));
    for (const s of this.projection.steps(this.conversation)) {
      if (s.outcome !== null || running.has(s.started)) continue;
      blocks.push({
        seq: s.startedSeq,
        block: {
          kind: "interrupt",
          cause: "unfinished-step",
          id: s.started,
          tool: s.name,
          input: s.input,
          idempotencyKey: s.idempotencyKey,
          at: s.startedAt,
        },
      });
    }
    for (const a of this.projection.anomalies(this.conversation)) {
      blocks.push({
        seq: a.seq,
        block: {
          kind: "interrupt",
          cause: "unasked-call",
          id: a.address,
          tool: a.name,
          input: a.input,
          idempotencyKey: null,
          at: a.at,
        },
      });
    }
    for (const r of thread ? [] : this.projection.recoveries()) {
      blocks.push({
        seq: r.seq,
        block: {
          kind: "notice",
          id: r.eventId,
          what: "log-recovered",
          sidecar: r.sidecar,
          bytes: r.bytes,
          at: r.at,
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

  /** Whether the agent is paused: it starts no turns and no steps until someone plays it. */
  agentState(): AgentState {
    return this.projection.agentState(this.conversation);
  }

  /**
   * Pauses or plays the agent. Pausing a turn that is running cancels it and refuses its steps;
   * a turn that @agent started in a paused conversation is left alone.
   */
  async setAgentState(state: AgentState): Promise<void> {
    if (this.agentState() === state) return;
    const traceId = this.systemTrace("draft.agent.state");
    await this.append(
      [
        {
          type: "agent.state_changed",
          address: itemAddress(this.conversation, newItemId(this.newId)),
          conversation: this.conversation,
          actor: this.user,
          traceId,
          data: { state },
        },
      ],
      "agent.state",
    );
    if (state === "paused" && this.turn !== null && !this.turn.addressed) {
      this.turn.abort.abort();
      for (const p of this.prompts.values())
        p.resolve({ allow: false, message: "The conversation was paused." });
      this.prompts.clear();
      this.emitState();
    }
  }

  /** A trace ID for something that isn't a turn, such as an aside or a change of state. */
  private systemTrace(name: string): string {
    const span = tracer().startSpan(
      name,
      { attributes: { "draft.conversation": this.conversation } },
      ROOT_CONTEXT,
    );
    span.end();
    return span.spanContext().traceId;
  }

  /** Posts a message only people read: the agent isn't started and never sees it. */
  private async postPeopleOnly(text: string): Promise<void> {
    const span = tracer().startSpan(
      "draft.message",
      { attributes: { "draft.conversation": this.conversation, "draft.audience.agent": false } },
      ROOT_CONTEXT,
    );
    const traceId = span.spanContext().traceId;
    try {
      const address = itemAddress(this.conversation, newItemId(this.newId));
      await this.append(
        [
          {
            type: "message.posted",
            address,
            conversation: this.conversation,
            actor: this.user,
            traceId,
            data: { role: "user", text, audience: PEOPLE_ONLY },
          },
        ],
        "user.message",
      );
      await otelContext.with(trace.setSpan(ROOT_CONTEXT, span), () =>
        this.makeReferences(address, [{ text, source: "text" }], "explicit", traceId),
      );
    } finally {
      span.end();
    }
  }

  /**
   * Posts a message. Its audience comes from the agent's state: to people and the agent while
   * the agent is active, to people only while it is paused. Only exceptions are marked: an aside
   * skips the agent in an active conversation, and @agent reaches it in a paused one, for that
   * message only. A message the agent may read runs one turn: the streamed answer, its tool
   * calls, references.
   */
  async submit(text: string, options: SubmitOptions = {}): Promise<void> {
    if (text.trim() === "") return;
    const state = this.agentState();
    const addressed = state === "paused" && AGENT_MENTION.test(text);
    const toAgent = options.aside !== true && (state === "active" || addressed);
    if (!toAgent) return this.postPeopleOnly(text);
    if (this.busy) throw new Error("a turn is already running");
    const agent = this.runtime();
    this.busy = true;
    this.error = null;
    const m = draftMetrics();
    const span = tracer().startSpan(
      "draft.turn",
      { attributes: { "draft.conversation": this.conversation, "draft.audience.agent": true } },
      ROOT_CONTEXT,
    );
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    const traceId = span.spanContext().traceId;
    const started = performance.now();
    const abort = new AbortController();
    this.turn = { abort, addressed };
    // Steps are allowed in an active conversation, and in a turn @agent started in a paused one.
    const stepsAllowed = () => addressed || this.agentState() === "active";
    let toolCount = 0;
    let usage = null as AgentUsage | null;
    try {
      await otelContext.with(ctx, async () => {
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
              data: { role: "user", text, audience: PEOPLE_AND_AGENT },
            },
          ],
          "user.message",
        );
        await this.makeReferences(userAddress, [{ text, source: "text" }], "explicit", traceId);
        // What a session that starts now starts from: one projection of the log, never a
        // people-only message.
        const context = buildAgentContext(this.projection, this.conversation, {
          exclude: [userAddress],
        });

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
        const turnSteps: string[] = [];
        let final = "";
        let failure: string | null = null;
        // Read when each event is written: a runtime may learn its model and version during the turn.
        const agentActor = (): Actor => ({
          kind: "agent",
          id: agent.id,
          model: agent.model,
          version: agent.version,
        });

        const agentSpan = tracer().startSpan("draft.agent.turn", {
          attributes: { "gen_ai.request.model": agent.model, "draft.agent": agent.id },
        });
        const agentCtx = trace.setSpan(ctx, agentSpan);
        const events = agent.runTurn(
          { conversation: this.conversation, text, context, signal: abort.signal },
          {
            confirmTool: (call) =>
              otelContext.with(agentCtx, async () => {
                if (!stepsAllowed())
                  return { allow: false, message: "The conversation is paused." };
                const ask = tracer().startSpan("draft.permission.ask", {
                  attributes: { "draft.tool.name": call.name, "draft.tool.use_id": call.toolUseId },
                });
                const answer = await new Promise<PermissionAnswer>((resolve) => {
                  this.prompts.set(call.toolUseId, {
                    prompt: { id: call.toolUseId, tool: call.name, input: call.input },
                    at: new Date().toISOString(),
                    resolve,
                  });
                  this.emitState();
                });
                ask.setAttribute("draft.permission.allowed", answer.allow);
                ask.end();
                return answer;
              }),
            beginStep: (call) =>
              otelContext.with(agentCtx, async () => {
                // A pause between the answer and the step still wins: no step starts while paused.
                if (!stepsAllowed()) throw new Error("the conversation is paused");
                const started = itemAddress(this.conversation, newItemId(this.newId));
                const idempotencyKey = newItemId(this.newId);
                await this.append(
                  [
                    {
                      type: "step.started",
                      address: started,
                      conversation: this.conversation,
                      actor: agentActor(),
                      traceId,
                      data: {
                        idempotencyKey,
                        toolUseId: call.toolUseId,
                        name: call.name,
                        input: call.input,
                        decision: "approved-by-user",
                      },
                    },
                  ],
                  "step.started",
                );
                this.stepsInFlight.set(call.toolUseId, { started, idempotencyKey });
                turnSteps.push(call.toolUseId);
                m.steps.add(1, { "draft.step.outcome": "started" });
                return { idempotencyKey };
              }),
          },
        );
        for await (const ev of events) {
          switch (ev.type) {
            case "session-started":
              await this.append(
                [
                  {
                    type: "agent.session_started",
                    address: itemAddress(this.conversation, newItemId(this.newId)),
                    conversation: this.conversation,
                    actor: agentActor(),
                    traceId,
                    data: {
                      agent: agent.id,
                      agentVersion: agent.version,
                      model: agent.model,
                      contextHash: contextDigest(context),
                      contextMessages: context.messages.length,
                      contextOpenItems: context.openItems.length,
                    },
                  },
                ],
                "agent.session",
              );
              break;
            case "anomaly":
              await this.append(
                [
                  {
                    type: "agent.anomaly",
                    address: itemAddress(this.conversation, newItemId(this.newId)),
                    conversation: this.conversation,
                    actor: agentActor(),
                    traceId,
                    data: {
                      kind: "call-without-permission",
                      toolUseId: ev.toolUseId,
                      name: ev.name,
                      input: ev.input,
                      status: ev.status,
                    },
                  },
                ],
                "agent.anomaly",
              );
              m.anomalies.add(1, { "draft.anomaly.kind": "call-without-permission" });
              agentSpan.addEvent("draft.anomaly", { "draft.tool.name": ev.name });
              break;
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
                this.emit({
                  type: "delta",
                  conversation: this.conversation,
                  address: agentAddress,
                  text: ev.text,
                });
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
              const step = this.stepsInFlight.get(ev.toolUseId);
              if (step !== undefined) {
                // The step's effect is done: complete it. Its result summary is the grounds of
                // whatever comes next.
                const outcome = ev.isError ? "failed" : "completed";
                await otelContext.with(
                  t === undefined ? agentCtx : trace.setSpan(agentCtx, t.span),
                  () =>
                    this.append(
                      [
                        {
                          type: ev.isError ? "step.failed" : "step.completed",
                          address: itemAddress(this.conversation, newItemId(this.newId)),
                          conversation: this.conversation,
                          actor: agentActor(),
                          traceId,
                          data: {
                            started: step.started,
                            idempotencyKey: step.idempotencyKey,
                            resultSummary: summarizeResult({
                              isError: ev.isError,
                              text: ev.text,
                              structured: ev.structured,
                            }),
                          },
                        },
                      ],
                      `step.${outcome}`,
                    ),
                );
                this.stepsInFlight.delete(ev.toolUseId);
                m.steps.add(1, { "draft.step.outcome": outcome });
                if (!ev.isError) {
                  toolTexts.push({
                    text: ev.text !== "" ? ev.text : JSON.stringify(ev.structured ?? null),
                    source: "tool-result",
                  });
                }
                m.toolCalls.add(1, {
                  "draft.tool.name": call?.name ?? "unknown",
                  "draft.tool.decision": "approved-by-user",
                  "draft.tool.outcome": ev.isError ? "error" : "ok",
                });
                if (t !== undefined) {
                  t.span.setAttribute("draft.tool.is_error", ev.isError);
                  t.span.end();
                  m.stepDuration.record(performance.now() - t.t0, { "draft.step": "tool.call" });
                }
                break;
              }
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
              usage = ev.usage;
              break;
            case "error":
              failure = ev.message;
              break;
          }
        }
        // A step whose result never came is not finished: it may or may not have happened, so it
        // stays open in the log and shows as an interrupt. It is never run again.
        for (const id of turnSteps) {
          if (this.stepsInFlight.delete(id))
            m.steps.add(1, { "draft.step.outcome": "interrupted" });
        }
        for (const s of modelSpans.values()) s.span.end();
        for (const t of toolSpans.values()) t.span.end();
        agentSpan.setAttributes({
          ...usageAttributes(usage),
          // The model the agent reported, which a runtime may only learn once its session starts.
          "gen_ai.response.model": agent.model,
          "draft.agent.version": agent.version,
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
              data: { role: "agent", text: replyText, audience: PEOPLE_AND_AGENT },
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
      // Only what the agent reported is recorded: a turn that reported nothing says so.
      if (usage?.inputTokens !== undefined)
        m.turnTokens.record(usage.inputTokens, { "gen_ai.token.type": "input" });
      if (usage?.outputTokens !== undefined)
        m.turnTokens.record(usage.outputTokens, { "gen_ai.token.type": "output" });
      span.setAttributes({ ...usageAttributes(usage), "draft.tool_calls": toolCount });
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
        ...usageAttributes(usage),
        "draft.duration_ms": Math.round(ms),
      });
      span.end();
      this.turn = null;
      this.streaming = null;
      this.stepsInFlight.clear();
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
      const sealed = await this.writer.run(async () => {
        const sealed = await this.log.append(drafts);
        for (const e of sealed) this.projection.apply(e);
        return sealed;
      });
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
    try {
      this.runtime().closeConversation(this.conversation);
    } catch {
      // Its agent is no longer configured: there is no session to end.
    }
  }
}
