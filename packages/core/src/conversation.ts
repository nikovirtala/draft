import { context as otelContext, ROOT_CONTEXT, type Span, trace } from "@opentelemetry/api";
import {
  ACCEPTANCE_OUTCOMES as ACCEPTANCE_ANSWERS,
  type AcceptanceActions,
  type AcceptanceEffect,
  type AcceptanceOutcome,
  ANSWERS,
  acceptanceKind,
  acceptanceMachine,
  evidenceGreen,
} from "./acceptance.ts";
import { conversationKey, itemAddress, parseAddress } from "./address.ts";
import {
  type AgentDirectory,
  type AgentEvent,
  type AgentRuntime,
  type AgentUsage,
  type PermissionAnswer,
  singleAgent,
} from "./agent.ts";
import { buildAgentNote } from "./agent-changes.ts";
import { buildAgentContext, contextDigest } from "./agent-context.ts";
import { CONTEXT_ITEM, type ContextItemSnapshot, contextItemKey } from "./cross-context.ts";
import {
  type Actor,
  type AgentEnvironmentReport,
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
import {
  type AttentionItem,
  INTERRUPT_KINDS,
  type InterruptKind,
  interruptMachine,
  orderAttention,
} from "./interrupts.ts";
import {
  bareToolName,
  chooseOption,
  type KiroPendingPermission,
  type KiroRemoteTools,
  summarizeResult,
  toolPermission,
} from "./kiro.ts";
import type { LogStore } from "./log.ts";
import { isMapRequest } from "./map.ts";
import type { Projection } from "./projection.ts";
import { type PollerOptions, type Resolver, StubPoller, sameState } from "./resolver.ts";
import { draftMetrics, failSpan, logEvent, tracer } from "./telemetry.ts";
import {
  type Citations,
  isEnded,
  type ThreadFold,
  type ThreadState,
  threadMachine,
} from "./thread.ts";
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
  /** For an item of another context: a person pulled it into this conversation's agent context. */
  pulled: boolean;
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
       * happened; it is never run again), a step that failed, a call that ran without the agent
       * asking first, or something a resolver saw outside: a permission request, a failed check.
       * It stays in the conversation once settled, with who settled it and how.
       */
      kind: "interrupt";
      cause: InterruptKind;
      /** The interrupt's key: what a settlement names. */
      id: string;
      state: "open" | "settled" | "cleared";
      /** The tool of a step or call; empty for what a resolver raised. */
      tool: string;
      input: unknown;
      /** The step's key; a call that ran unasked had no step. */
      idempotencyKey: string | null;
      at: string;
      /** One line saying what it is, for what a resolver raised. */
      summary: string;
      detail: Record<string, unknown>;
      target: Target | null;
      /** What a person can settle it as, while it is open. */
      outcomes: string[];
      settled: { outcome: string; at: string; by: string; via: string | null } | null;
      cleared: { reason: string; at: string } | null;
    }
  | {
      /** The log's last line was never completed; its bytes were moved aside when it opened. */
      kind: "notice";
      id: string;
      what: "log-recovered";
      sidecar: string;
      bytes: number;
      at: string;
    }
  | {
      /**
       * The map, asked for by a sentence ("show the map"). It is derived from that message, so it
       * stays where it was asked after a restart; its content is the map's own projection, and
       * where it is placed is view state of the device.
       */
      kind: "map";
      /** The message that asked for it. */
      id: string;
      at: string;
    }
  | {
      /** A note from draft itself, such as how it reaches GitHub. */
      kind: "note";
      id: string;
      what: string;
      text: string;
      at: string;
    };

/**
 * A sentence that asks to open or make a context, as draft recognized it. The person confirms it
 * with one action; the agent has no way to open anything (ADR 17gtag9n).
 */
export type ContextIntent = { kind: "open"; name: string } | { kind: "new"; folder: string };

/** What a proposal asks a person to confirm. */
export interface UiProposal {
  id: string;
  intent: ContextIntent;
  /** The message that asked for it. */
  message: string;
}

/** Opens contexts for a conversation; the desktop app supplies it. */
export interface ContextLauncher {
  /** The intent in a sentence, or null when the sentence is for the agent. */
  recognise(text: string): ContextIntent | null;
  /** Opens the context an intent names (making it first for "new"); returns its name. */
  open(intent: ContextIntent): Promise<{ context: string }>;
}

/** Reads items of other contexts for references; the desktop app supplies it. */
export interface CrossContext {
  /** Addresses in a text that name an item of another context on this device. */
  detect(text: string): string[];
  /** The snapshot of such an item, taken from its context's log; null when it isn't there. */
  snapshot(address: string): Promise<ContextItemSnapshot | null>;
}

/** A thread's own state and conclusion, for the conversation that shows it. */
export interface UiThreadState {
  state: ThreadState;
  /** The latest proposal while concluding, or the conclusion that wrapped the thread up. */
  conclusion: ThreadFold["conclusion"];
  endedReason: string | null;
}

export interface UiState {
  context: string;
  conversation: string;
  /** Null for the main conversation. */
  thread: UiThreadState | null;
  /** The message this conversation branched off, or null for the main conversation. */
  parent: string | null;
  title: string;
  agent: {
    id: string;
    model: string;
    version: string;
    state: AgentState;
    /** What the agent's process doesn't get of the person's environment; null when it has none. */
    environment: AgentEnvironmentReport | null;
  };
  messages: UiMessage[];
  timeline: UiBlock[];
  stubs: Record<string, UiStub>;
  streaming: { address: string; text: string } | null;
  prompts: UiPrompt[];
  /** Sentences that asked to open a context and wait for a person to confirm. */
  proposals: UiProposal[];
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
  /** The turn drafts the thread's conclusion. A thread also starts one when asked to "wrap up". */
  wrapUp?: boolean;
}

/** "Wrap this up", "wrap it up", "wrap up": a request for the thread's conclusion. */
export const WRAP_UP_REQUEST = /\bwrap(?:\s+(?:this|it|the\s+thread))?\s+up\b/i;

/** What the agent is told on top of a wrap-up request; the user's message is logged as typed. */
export const WRAP_UP_INSTRUCTION =
  "\n\n[draft] Write this thread's conclusion for the main conversation: what was decided, what was made, and what is still open, in a few plain sentences. Reply with the conclusion only; draft shows it to the user to confirm.";

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
  /**
   * Kiro Remote as the person: what answering a permission request and retrying a step call. It
   * is draft acting for the person, never the agent's tools. Without it, those can't be settled.
   */
  actions?: KiroRemoteTools;
  /**
   * The person's own tools, per kind of record: what accepting an ADR or merging a pull request
   * runs, as the person (git with their identity and signing key, gh, adr). Reached only from a
   * person's answer to an acceptance request. Without it, those can't be answered.
   */
  acceptance?: AcceptanceActions;
  /** Told when another conversation of the log changed, so it can show it. */
  touched?: (conversation: string) => void;
  /** Opens contexts when a person asks in a sentence and confirms. Without it, nothing opens. */
  launcher?: ContextLauncher;
  /** Takes snapshots of other contexts' items for references. Without it, none are made. */
  crossContext?: CrossContext;
  context?: string;
  /** The context's title, written once with `context.created`; "Local" by default. */
  contextTitle?: string;
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
  private readonly actions: KiroRemoteTools | null;
  private readonly acceptance: AcceptanceActions | null;
  private readonly touched: ((conversation: string) => void) | undefined;
  private readonly launcher: ContextLauncher | null;
  private readonly crossContext: CrossContext | null;
  private readonly proposals = new Map<string, UiProposal>();
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
  /** Steps of the person's own (answers, retries) waiting on Kiro Remote. */
  private readonly userSteps = new Set<string>();
  readonly poller: StubPoller;

  private constructor(o: ConversationOptions, conversation: string) {
    this.log = o.log;
    this.projection = o.projection;
    this.agents = o.agents ?? singleAgent(o.agent);
    this.writer = o.writer ?? new SerialWriter();
    this.resolvers = new Map(o.resolvers.map((r) => [r.type, r]));
    this.user = o.user;
    this.newId = o.newId;
    this.actions = o.actions ?? null;
    this.acceptance = o.acceptance ?? null;
    this.touched = o.touched;
    this.launcher = o.launcher ?? null;
    this.crossContext = o.crossContext ?? null;
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
      .filter((s) => s.outcome === null && s.resolution === null).length;
    if (interrupted > 0) draftMetrics().interruptedSteps.add(interrupted);
    // Replaying every thread's events through its machine is the conformance test.
    const violations = o.projection
      .conversations()
      .filter((c) => c.parent !== null)
      .reduce((n, c) => n + o.projection.thread(c.conversation).rejected, 0);
    if (violations > 0)
      draftMetrics().machineViolations.add(violations, { "draft.machine": "thread" });
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
          data: { context: ctx, title: o.contextTitle ?? "Local" },
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
   * What needs a person here, computed from the log (steps that never finished or failed, calls
   * that ran without asking, what resolvers raised, a conclusion waiting for a yes) and from the
   * permission requests waiting now. The workspace puts every conversation's items in one order.
   */
  attention(): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const { seq, block: b } of this.interruptEntries()) {
      if (b.state !== "open") continue;
      items.push({ id: b.id, conversation: this.conversation, cause: b.cause, at: b.at, seq });
    }
    const thread = this.threadFold();
    if (thread?.state === "concluding" && thread.conclusion !== null)
      items.push({
        id: thread.conclusion.address,
        conversation: this.conversation,
        cause: "conclusion",
        at: thread.conclusion.proposedAt,
      });
    for (const p of this.prompts.values())
      items.push({
        id: p.prompt.id,
        conversation: this.conversation,
        cause: "permission",
        at: p.at,
      });
    return orderAttention(items);
  }

  /** The steps this conversation is running now, by their `step.started` address. */
  runningSteps(): string[] {
    return [...[...this.stepsInFlight.values()].map((s) => s.started), ...this.userSteps];
  }

  /** This conversation's own thread state, or null for the main conversation. */
  private threadFold(): ThreadFold | null {
    return this.isThread() ? this.projection.thread(this.conversation) : null;
  }

  private interruptBlocks(): Extract<UiBlock, { kind: "interrupt" }>[] {
    return this.interruptEntries().map((e) => e.block);
  }

  /** Every interrupt of this conversation, open or not, in log order, with its place in the log. */
  private interruptEntries(): { seq: number; block: Extract<UiBlock, { kind: "interrupt" }> }[] {
    const running = new Set([
      ...[...this.stepsInFlight.values()].map((s) => s.started),
      ...this.userSteps,
    ]);
    const out: { seq: number; block: Extract<UiBlock, { kind: "interrupt" }> }[] = [];
    const base = { summary: "", detail: {}, target: null, cleared: null };
    const settledOf = (key: string, since = -1) => {
      const x = this.projection.settlementOf(key);
      return x !== null && x.seq > since
        ? {
            outcome: x.outcome,
            at: x.at,
            by: x.actor.name ?? x.actor.id,
            via: x.via,
          }
        : null;
    };
    for (const s of this.projection.steps(this.conversation)) {
      // Answering a permission is shown on the permission it answers, not as a step of its own.
      if (bareToolName(s.name) === "kiro_answer_permission") continue;
      if (running.has(s.started)) continue;
      const failed = s.outcome === "failed";
      if (s.outcome === "completed") continue;
      const cause: InterruptKind = failed ? "failed-step" : "unfinished-step";
      const key = failed ? `failed:${s.started}` : s.started;
      const settled =
        s.resolution === null
          ? null
          : {
              outcome: s.resolution,
              at: s.resolvedAt ?? s.startedAt,
              by: this.settlementActor(key, s.resolution),
              via: this.projection.settlementOf(key)?.via ?? null,
            };
      out.push({
        seq: s.startedSeq,
        block: {
          ...base,
          kind: "interrupt",
          cause,
          id: key,
          state: settled === null ? "open" : "settled",
          tool: s.name,
          input: s.input,
          detail: failed ? { result: s.resultSummary } : {},
          idempotencyKey: s.idempotencyKey,
          at: failed ? (s.finishedAt ?? s.startedAt) : s.startedAt,
          outcomes: settled === null ? [...INTERRUPT_KINDS[cause].outcomes] : [],
          settled,
        },
      });
    }
    for (const a of this.projection.anomalies(this.conversation)) {
      const settled = settledOf(a.address);
      out.push({
        seq: a.seq,
        block: {
          ...base,
          kind: "interrupt",
          cause: "unasked-call",
          id: a.address,
          state: settled === null ? "open" : "settled",
          tool: a.name,
          input: a.input,
          idempotencyKey: null,
          at: a.at,
          outcomes: settled === null ? [...INTERRUPT_KINDS["unasked-call"].outcomes] : [],
          settled,
        },
      });
    }
    for (const r of this.projection.raised(this.conversation)) {
      const [type, ...rest] = (r.target ?? "").split(":");
      out.push({
        seq: r.seq,
        block: {
          kind: "interrupt",
          cause: r.kind,
          id: r.key,
          state: r.state,
          tool: "",
          input: null,
          idempotencyKey: null,
          at: r.at,
          summary: r.summary,
          detail: r.detail,
          target: r.target === null ? null : { type: type as string, id: rest.join(":") },
          outcomes: r.state === "open" ? [...INTERRUPT_KINDS[r.kind].outcomes] : [],
          settled:
            r.settlement === null
              ? null
              : {
                  outcome: r.settlement.outcome,
                  at: r.settlement.at,
                  by: r.settlement.actor.name ?? r.settlement.actor.id,
                  via: r.settlement.via,
                },
          cleared:
            r.state === "cleared" && r.clearedAt !== null
              ? { reason: r.clearedReason ?? "", at: r.clearedAt }
              : null,
        },
      });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  private settlementActor(key: string, outcome: string): string {
    const x = this.projection.settlementOf(key);
    return x !== null && x.outcome === outcome ? (x.actor.name ?? x.actor.id) : "you";
  }

  onChange(cb: (c: UiChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  state(): UiState {
    const edges = this.projection.edges(this.conversation);
    const pulled = this.projection.pulledTargets(this.conversation);
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
          pulled: type === CONTEXT_ITEM && pulled.has(rest.join(":")),
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
    const fold = this.threadFold();
    return {
      context: this.context,
      conversation: this.conversation,
      thread:
        fold === null
          ? null
          : { state: fold.state, conclusion: fold.conclusion, endedReason: fold.endedReason },
      parent: conv?.parent ?? null,
      title: conv?.title ?? "Conversation",
      agent: {
        id: runtime?.id ?? this.projection.agentOf(this.conversation) ?? this.agents.defaultId,
        model: runtime?.model ?? "unavailable",
        version: runtime?.version ?? "not configured",
        state: this.projection.agentState(this.conversation),
        environment: runtime?.environment ?? null,
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
      proposals: [...this.proposals.values()],
      busy: this.busy,
      error: this.error,
    };
  }

  /** Messages and the blocks between them, in log order. */
  private timeline(
    messages: readonly { address: string; seq: number; role: string; text: string; at: string }[],
  ): UiBlock[] {
    const blocks: { seq: number; block: UiBlock }[] = messages.map((m) => ({
      seq: m.seq,
      block: { kind: "message", address: m.address },
    }));
    for (const m of messages)
      if (m.role === "user" && isMapRequest(m.text))
        blocks.push({ seq: m.seq + 0.5, block: { kind: "map", id: m.address, at: m.at } });
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
    // Interrupts keep the place in the log where they arose.
    const seqOf = new Map<string, number>();
    for (const st of this.projection.steps(this.conversation)) {
      seqOf.set(st.started, st.startedSeq);
      seqOf.set(`failed:${st.started}`, st.startedSeq);
    }
    for (const an of this.projection.anomalies(this.conversation)) seqOf.set(an.address, an.seq);
    for (const r of this.projection.raised(this.conversation)) seqOf.set(r.key, r.seq);
    for (const b of this.interruptBlocks()) blocks.push({ seq: seqOf.get(b.id) ?? 0, block: b });
    if (!thread)
      for (const n of this.projection.notices())
        blocks.push({
          seq: n.seq,
          block: { kind: "note", id: n.eventId, what: n.what, text: n.text, at: n.at },
        });
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

  /* ------------------------------------------------------------------------------------------ */
  /* Interrupts                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  /** Shows another conversation's change: this one's own state, or through the workspace. */
  private touch(conversation: string): void {
    if (conversation === this.conversation) this.emitState();
    else this.touched?.(conversation);
  }

  /**
   * Raises what a resolver says needs a person, in the conversation it belongs to, and clears what
   * it no longer says. A key that is open or settled is left alone; a cleared one that applies
   * again is a new episode.
   */
  private async reconcile(
    target: Target,
    state: Record<string, unknown>,
    resolver: Resolver,
    traceId: string | null,
  ): Promise<void> {
    if (resolver.interrupts === undefined) return;
    const wanted = resolver.interrupts(target, state);
    const key = targetKey(target);
    const actor: Actor = { kind: "resolver", id: resolver.type, version: resolver.version };
    const touched = new Set<string>();
    await this.writer.run(async () => {
      const owner = this.projection.ownerOf(target);
      const drafts: EventDraft[] = [];
      for (const w of wanted) {
        const latest = this.projection.latestRaised(w.key);
        if (latest !== null && latest.state !== "cleared") continue;
        drafts.push({
          type: "interrupt.raised",
          address: itemAddress(owner, newItemId(this.newId)),
          conversation: owner,
          actor,
          traceId,
          data: { key: w.key, kind: w.kind, target, summary: w.summary, detail: w.detail },
        });
        touched.add(owner);
      }
      for (const open of this.projection.openRaisedFor(key)) {
        if (wanted.some((w) => w.key === open.key)) continue;
        drafts.push({
          type: "interrupt.cleared",
          address: itemAddress(open.conversation, newItemId(this.newId)),
          conversation: open.conversation,
          actor,
          traceId,
          data: {
            key: open.key,
            kind: open.kind,
            reason:
              resolver.clearedBecause?.(open, target, state) ?? "the source no longer reports it",
          },
        });
        touched.add(open.conversation);
      }
      if (drafts.length === 0) return;
      const sealed = await this.log.append(drafts);
      for (const e of sealed) {
        this.projection.apply(e);
        if (e.type === "interrupt.raised" || e.type === "interrupt.cleared")
          draftMetrics().interrupts.add(1, {
            "draft.interrupt.kind": e.data.kind,
            "draft.interrupt.event": e.type === "interrupt.raised" ? "raised" : "cleared",
          });
      }
    });
    for (const c of touched) this.touch(c);
  }

  /** Looks at a target once more, as after an answer, instead of waiting for the next poll. */
  private async refresh(target: Target): Promise<void> {
    const resolver = this.resolvers.get(target.type);
    if (resolver === undefined) return;
    try {
      const state = await resolver.fetch(target.id);
      if (state !== null && !sameState(this.projection.stub(targetKey(target))?.state, state))
        await this.observe(target, state, resolver);
    } catch {
      draftMetrics().resolverFailures.add(1, { "draft.resolver": target.type });
    }
  }

  private settledDraft(d: {
    key: string;
    kind: InterruptKind;
    outcome: string;
    started: string | null;
    via: string | null;
    detail?: Record<string, unknown>;
    traceId: string | null;
  }): EventDraft {
    return {
      type: "interrupt.settled",
      address: itemAddress(this.conversation, newItemId(this.newId)),
      conversation: this.conversation,
      actor: this.user,
      traceId: d.traceId,
      data: {
        key: d.key,
        kind: d.kind,
        outcome: d.outcome,
        started: d.started,
        via: d.via,
        detail: d.detail ?? {},
      },
    };
  }

  /**
   * Settles one of this conversation's interrupts, as the person at this device. Only a person
   * can: the machine of every kind lets nobody else fire a settlement, and the agent's tool policy
   * refuses `kiro_answer_permission`. An answer to a hosted session's permission request goes to
   * Kiro Remote as the person, and is logged as a step of theirs and then as the settlement. Retry
   * starts a new step with a new key, and the old one is never run again.
   */
  async settleInterrupt(
    key: string,
    outcome: string,
    input: { note?: string; reason?: string } = {},
  ): Promise<void> {
    // A key that was cleared and applies again is a new episode with the same key: the open one.
    const blocks = this.interruptBlocks().filter((b) => b.id === key);
    const block = blocks.find((b) => b.state === "open") ?? blocks[0];
    if (block === undefined) throw new Error(`no such interrupt: ${key}`);
    if (block.state !== "open") throw new Error("this interrupt is already settled");
    if (block.cause === "acceptance") return this.answerAcceptance(block, outcome, input);
    const step = interruptMachine(block.cause).next("open", `settle:${outcome}`, "user");
    if (!step.ok) throw new Error(step.message);
    const traceId = this.systemTrace("draft.interrupt.settle");
    const settle = async (extra: {
      started: string | null;
      via: string | null;
      detail?: Record<string, unknown>;
    }) => {
      await this.append(
        [this.settledDraft({ key, kind: block.cause, outcome, traceId, ...extra })],
        "interrupt.settled",
      );
      draftMetrics().interrupts.add(1, {
        "draft.interrupt.kind": block.cause,
        "draft.interrupt.event": "settled",
        "draft.interrupt.outcome": outcome,
      });
    };
    if (block.cause === "permission") {
      const d = block.detail as {
        sessionId: string;
        requestId: string;
        title: string;
        kind: string | null;
        options: KiroPendingPermission["options"];
      };
      const optionId = chooseOption(d, outcome === "allowed");
      if (optionId === null) throw new Error("the request offers no option for that answer");
      const r = await this.userStep(
        `mcp__kiro-remote__kiro_answer_permission`,
        { sessionId: d.sessionId, requestId: d.requestId, optionId },
        traceId,
      );
      if (!r.ok) throw new Error(`Kiro Remote didn't take the answer: ${r.summary}`);
      await settle({ started: null, via: r.started, detail: { optionId } });
      if (block.target !== null) await this.refresh(block.target);
      return;
    }
    if (block.cause === "unfinished-step" || block.cause === "failed-step") {
      const started = block.cause === "failed-step" ? key.slice("failed:".length) : key;
      if (outcome !== "retry") return settle({ started, via: null });
      const orig = this.projection.steps(this.conversation).find((s) => s.started === started);
      if (orig === undefined) throw new Error("the step is not in this conversation");
      if (toolPermission(orig.name) !== "ask")
        throw new Error(`draft won't run ${orig.name} again for you`);
      // The settlement and the new step's start are written together, so a retry can't be
      // started twice and the new step's intent is in the log before its effect.
      await this.userStep(orig.name, orig.input as Record<string, unknown>, traceId, {
        retryOf: started,
        before: (via) => [
          this.settledDraft({ key, kind: block.cause, outcome, started, via, traceId }),
        ],
      });
      draftMetrics().interrupts.add(1, {
        "draft.interrupt.kind": block.cause,
        "draft.interrupt.event": "settled",
        "draft.interrupt.outcome": outcome,
      });
      return;
    }
    await settle({ started: null, via: null });
  }

  /**
   * Runs something as the person: its start is in the log before it runs, and its result after.
   * By default it calls a Kiro Remote tool; an acceptance's answer passes `exec`, which carries it
   * out with the person's own tools. A call that throws leaves the step open, because it may have
   * happened.
   */
  private async userStep(
    name: string,
    input: Record<string, unknown>,
    traceId: string | null,
    o: {
      retryOf?: string;
      before?: (started: string) => EventDraft[];
      exec?: () => Promise<{
        isError: boolean;
        text: string;
        structured: unknown;
        effect?: AcceptanceEffect;
      }>;
    } = {},
  ): Promise<{ started: string; idempotencyKey: string; ok: boolean; summary: string }> {
    const tool = bareToolName(name);
    const actions = this.actions;
    if (o.exec === undefined && (actions === null || tool === null))
      throw new Error("draft has no connection to Kiro Remote to act with");
    const m = draftMetrics();
    const started = itemAddress(this.conversation, newItemId(this.newId));
    const idempotencyKey = newItemId(this.newId);
    await this.append(
      [
        ...(o.before?.(started) ?? []),
        {
          type: "step.started",
          address: started,
          conversation: this.conversation,
          actor: this.user,
          traceId,
          data: {
            idempotencyKey,
            toolUseId: `user-${newItemId(this.newId)}`,
            name,
            input,
            decision: "approved-by-user",
            ...(o.retryOf === undefined ? {} : { retryOf: o.retryOf }),
          },
        },
      ],
      "step.started",
    );
    m.steps.add(1, { "draft.step.outcome": "started" });
    this.userSteps.add(started);
    let result: {
      isError: boolean;
      text: string;
      structured: unknown;
      effect?: AcceptanceEffect;
    };
    try {
      result =
        o.exec !== undefined
          ? await o.exec()
          : await (actions as KiroRemoteTools).call(tool as string, input, { idempotencyKey });
    } catch (err) {
      m.steps.add(1, { "draft.step.outcome": "interrupted" });
      throw err;
    } finally {
      this.userSteps.delete(started);
    }
    const ok = !result.isError;
    const summary = summarizeResult(result);
    await this.append(
      [
        {
          type: ok ? "step.completed" : "step.failed",
          address: itemAddress(this.conversation, newItemId(this.newId)),
          conversation: this.conversation,
          actor: this.user,
          traceId,
          data: {
            started,
            idempotencyKey,
            resultSummary: summary,
            ...(ok && result.effect !== undefined ? { effect: result.effect } : {}),
          },
        },
      ],
      ok ? "step.completed" : "step.failed",
    );
    m.steps.add(1, { "draft.step.outcome": ok ? "completed" : "failed" });
    return { started, idempotencyKey, ok, summary };
  }

  /**
   * A person's answer to an acceptance request: accept, request changes, or reject. Each is a
   * transition of the kind's machine that only a person can fire (the agent has no way in, and the
   * tool policy refuses every accept, reject and merge tool it might try).
   *
   * - Request changes puts the person's note into this conversation as a message to the agent,
   *   and settles the request. It waits for new evidence: a new push is a new request.
   * - Accept and reject look at the target again first and refuse if the evidence is no longer the
   *   green evidence the request showed, then carry the answer out with the person's tools as a
   *   step of theirs. The step's completion records the commit or merge it made, the evidence as
   *   it was, and the declared inverse.
   */
  private async answerAcceptance(
    block: Extract<UiBlock, { kind: "interrupt" }>,
    outcome: string,
    input: { note?: string; reason?: string },
  ): Promise<void> {
    if (!(ACCEPTANCE_ANSWERS as readonly string[]).includes(outcome))
      throw new Error(`${outcome} is not an answer to an acceptance request`);
    const answer = outcome as AcceptanceOutcome;
    const d = block.detail as {
      acceptance: string;
      target: Target;
      title: string;
      sha: string;
    };
    const kind = acceptanceKind(d.acceptance);
    if (kind === null) throw new Error(`draft doesn't know how to accept a ${d.acceptance}`);
    const text = (answer === "rejected" ? input.reason : input.note)?.trim() ?? "";
    const trigger = ANSWERS[answer];
    const fired = acceptanceMachine(kind).next("requested", trigger, "user", text);
    if (!fired.ok) throw new Error(fired.message);
    const settledStep = interruptMachine("acceptance").next("open", `settle:${outcome}`, "user");
    if (!settledStep.ok) throw new Error(settledStep.message);
    const traceId = this.systemTrace("draft.acceptance.answer");
    const settle = async (extra: { via: string | null; detail: Record<string, unknown> }) => {
      await this.append(
        [
          this.settledDraft({
            key: block.id,
            kind: "acceptance",
            outcome,
            started: null,
            traceId,
            ...extra,
          }),
        ],
        "interrupt.settled",
      );
      draftMetrics().interrupts.add(1, {
        "draft.interrupt.kind": "acceptance",
        "draft.interrupt.event": "settled",
        "draft.interrupt.outcome": outcome,
      });
    };

    if (answer === "changes-requested") {
      const thread = this.threadFold();
      if (thread !== null && isEnded(thread.state)) throw new Error("this thread has ended");
      if (this.busy) throw new Error("a turn is already running; ask for the changes when it ends");
      await settle({ via: null, detail: { note: text, sha: d.sha, acceptance: kind.name } });
      const ask = `Changes requested on ${d.title} (${d.target.id}): ${text}`;
      await this.submit(this.agentState() === "paused" ? `@agent ${ask}` : ask);
      return;
    }

    const actions = this.acceptance?.[kind.name];
    if (actions === undefined)
      throw new Error(
        `draft has no tools to ${answer === "accepted" ? "accept" : "reject"} a ${kind.name} with`,
      );
    // The evidence as it is now, not as it was when the request was raised.
    const resolver = this.resolvers.get(d.target.type);
    if (resolver === undefined) throw new Error(`no resolver for ${d.target.type}`);
    const state = await resolver.fetch(d.target.id);
    const subject = state === null ? null : kind.subject(d.target, state);
    if (
      state === null ||
      subject === null ||
      subject.key !== block.id ||
      !evidenceGreen(subject.evidence)
    ) {
      if (state !== null) await this.observe(d.target, state, resolver);
      throw new Error(
        "the evidence changed since the request was raised, so nothing was done. Look at it again.",
      );
    }
    const decl = answer === "accepted" ? kind.accept : kind.reject;
    const r = await this.userStep(
      `draft.${decl.effectKind}`,
      {
        acceptance: kind.name,
        target: d.target,
        sha: subject.sha,
        ...(text === "" ? {} : { reason: text }),
      },
      traceId,
      {
        exec: async () => {
          try {
            const out =
              answer === "accepted"
                ? await actions.accept(subject.where)
                : await actions.reject(subject.where, text);
            return {
              isError: false,
              text: out.summary,
              structured: null,
              effect: {
                kind: decl.effectKind,
                target: d.target,
                sha: out.sha,
                evidence: subject.evidence,
                inverse: decl.effect.inverse,
              },
            };
          } catch (err) {
            return {
              isError: true,
              text: err instanceof Error ? err.message : String(err),
              structured: null,
            };
          }
        },
      },
    );
    if (!r.ok) throw new Error(r.summary);
    await settle({
      via: r.started,
      detail: {
        acceptance: kind.name,
        sha: subject.sha,
        effect: decl.effectKind,
        inverse: decl.effect.inverse,
        ...(text === "" ? {} : { reason: text }),
      },
    });
    // The target is different now (a new commit, a merge): look at it at once.
    await this.refresh(d.target);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Threads                                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  /** This thread's state and conclusion; null for the main conversation. */
  threadState(): ThreadFold | null {
    return this.threadFold();
  }

  /** The conversation this thread's branch point is in. */
  private parentConversation(): string {
    const parent = this.projection
      .conversations()
      .find((c) => c.conversation === this.conversation)?.parent;
    if (parent === null || parent === undefined) throw new Error("this is not a thread");
    const a = parseAddress(parent);
    return conversationKey(a.context, a.conversation as string);
  }

  /** What the conclusion rests on: this thread, and what it produced. */
  private citations(): Citations {
    const conv = this.projection.conversations().find((c) => c.conversation === this.conversation);
    const seen = new Set<string>();
    const produced: Citations["produced"] = [];
    for (const e of this.projection.edges(this.conversation)) {
      if (seen.has(e.target)) continue;
      seen.add(e.target);
      const [type, ...rest] = e.target.split(":");
      produced.push({ type: type as string, id: rest.join(":") });
    }
    return {
      thread: this.conversation,
      parent: conv?.parent as string,
      messages: this.projection.messages(this.conversation).length,
      produced,
    };
  }

  private async fireThread(
    trigger: string,
    draft: (fold: ThreadFold) => EventDraft,
    reason?: string,
  ): Promise<void> {
    const fold = this.threadFold();
    if (fold === null) throw new Error("only a thread can do that");
    const step = threadMachine().next(fold.state, trigger, "user", reason);
    if (!step.ok) throw new Error(step.message);
    await this.append([draft(fold)], `thread.${trigger}`);
    draftMetrics().threadEvents.add(1, { "draft.thread.event": trigger });
  }

  /**
   * Confirms the conclusion the thread's agent drafted: one action, as the person. The thread
   * wraps up and the conclusion returns to the conversation the thread branched off, at its stub.
   */
  async confirmConclusion(): Promise<void> {
    const returnedTo = this.parentConversation();
    await this.fireThread("confirm", (fold) => {
      const c = fold.conclusion as NonNullable<ThreadFold["conclusion"]>;
      return {
        type: "thread.wrapped_up",
        address: itemAddress(this.conversation, newItemId(this.newId)),
        conversation: this.conversation,
        actor: this.user,
        traceId: this.systemTrace("draft.thread.wrap_up"),
        data: { proposal: c.address, text: c.text, cites: c.cites, returnedTo },
      };
    });
    this.touch(returnedTo);
  }

  /** Sends the conclusion back: the thread is open again, and the agent can draft another. */
  async declineConclusion(): Promise<void> {
    await this.fireThread("decline", (fold) => ({
      type: "thread.conclusion_declined",
      address: itemAddress(this.conversation, newItemId(this.newId)),
      conversation: this.conversation,
      actor: this.user,
      traceId: this.systemTrace("draft.thread.decline"),
      data: { proposal: (fold.conclusion as NonNullable<ThreadFold["conclusion"]>).address },
    }));
  }

  /** Ends the thread as superseded or withdrawn. A reason is required. */
  async endThread(as: "superseded" | "withdrawn", reason: string): Promise<void> {
    await this.fireThread(
      as,
      () => ({
        type: "thread.ended",
        address: itemAddress(this.conversation, newItemId(this.newId)),
        conversation: this.conversation,
        actor: this.user,
        traceId: this.systemTrace("draft.thread.end"),
        data: { state: as, reason: reason.trim() },
      }),
      reason,
    );
    this.touch(this.parentConversation());
  }

  /**
   * A note in the main conversation, such as how draft reaches GitHub. Written when it differs
   * from the latest note of the same kind, so a restart doesn't repeat it.
   */
  async note(what: string, text: string): Promise<void> {
    const last = [...this.projection.notices()].reverse().find((n) => n.what === what);
    if (last?.text === text) return;
    await this.append(
      [
        {
          type: "notice.posted",
          address: itemAddress(this.conversation, newItemId(this.newId)),
          conversation: this.conversation,
          actor: SYSTEM,
          traceId: null,
          data: { what, text },
        },
      ],
      "notice",
    );
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

  /** Posts the sentence for people only and waits for one confirmation. */
  private async propose(text: string, intent: ContextIntent): Promise<void> {
    await this.postPeopleOnly(text);
    const message = this.projection.messages(this.conversation).at(-1)?.address;
    const id = newItemId(this.newId);
    this.proposals.set(id, { id, intent, message: message ?? this.conversation });
    this.error = null;
    this.emitState();
  }

  /**
   * A person answers a proposal. Confirming opens the context and records the crossing as the
   * person; declining only dismisses it.
   */
  async answerProposal(id: string, accept: boolean): Promise<void> {
    const p = this.proposals.get(id);
    if (p === undefined || this.launcher === null) return;
    this.proposals.delete(id);
    if (!accept) return this.emitState();
    try {
      const { context } = await this.launcher.open(p.intent);
      await this.append(
        [
          {
            type: "context.crossed",
            address: itemAddress(this.conversation, newItemId(this.newId)),
            conversation: this.conversation,
            actor: this.user,
            traceId: null,
            data: {
              purpose: "opened",
              context,
              target: null,
              from: p.message as string,
              snapshotHash: null,
              via: "sentence",
            },
          },
        ],
        "context.opened",
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.emitState();
    }
  }

  /**
   * A person follows or pulls in a reference to another context's item. Both are crossings and
   * are recorded as the person; pulling lets the item's snapshot, and only that, reach this
   * conversation's agent. Only an item this conversation already references can be crossed to.
   */
  async cross(purpose: "followed" | "pulled", address: string): Promise<{ context: string }> {
    const edge = this.projection
      .edges(this.conversation)
      .find((e) => e.target === contextItemKey(address));
    if (edge === undefined) throw new Error(`this conversation has no reference to ${address}`);
    if (purpose === "pulled" && this.busy)
      throw new Error("wait for the agent to finish its turn before pulling something in");
    const snapshot = edge.snapshot as unknown as ContextItemSnapshot;
    await this.append(
      [
        {
          type: "context.crossed",
          address: itemAddress(this.conversation, newItemId(this.newId)),
          conversation: this.conversation,
          actor: this.user,
          traceId: null,
          data: {
            purpose,
            context: snapshot.context,
            target: address,
            from: edge.from,
            snapshotHash: snapshot.hash,
            via: purpose === "followed" ? "reference" : null,
          },
        },
      ],
      `context.${purpose}`,
    );
    // The running session was started without it: the next turn starts a new one from the log.
    if (purpose === "pulled") {
      try {
        this.runtime().closeConversation(this.conversation);
      } catch {
        // Its agent is no longer configured: there is no session to end.
      }
    }
    return { context: snapshot.context };
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
    const thread = this.threadFold();
    if (thread !== null && isEnded(thread.state)) throw new Error("this thread has ended");
    // A sentence that asks to open a context is for draft, not the agent: it is posted for people
    // only and becomes one action to confirm.
    const intent = options.aside === true ? null : (this.launcher?.recognise(text) ?? null);
    if (intent !== null) return this.propose(text, intent);
    // A sentence that asks for the map is for draft too: it shows the map, and the agent never
    // reads it.
    if (isMapRequest(text)) return this.postPeopleOnly(text);
    const state = this.agentState();
    const addressed = state === "paused" && AGENT_MENTION.test(text);
    const toAgent = options.aside !== true && (state === "active" || addressed);
    if (!toAgent) return this.postPeopleOnly(text);
    if (this.busy) throw new Error("a turn is already running");
    // A thread asked to wrap up drafts its conclusion in this turn.
    const wrapUp = thread !== null && (options.wrapUp === true || WRAP_UP_REQUEST.test(text));
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

        // What the agent could not see since its last turn: the person's decisions and what draft
        // resolved for the stubs referenced. It is written to the log before the agent runs, so
        // the log's place of this turn is where the next note starts counting from.
        const note = buildAgentNote(this.projection, this.conversation, { agent: agent.id });
        await this.append(
          [
            {
              type: "agent.turn_started",
              address: itemAddress(this.conversation, newItemId(this.newId)),
              conversation: this.conversation,
              actor: { kind: "agent", id: agent.id, model: agent.model, version: agent.version },
              traceId,
              data: {
                message: userAddress,
                agent: agent.id,
                note: note.text,
                entries: note.entries,
                omitted: note.omitted,
              },
            },
          ],
          "agent.turn_started",
        );

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
          {
            conversation: this.conversation,
            text: wrapUp ? `${text}${WRAP_UP_INSTRUCTION}` : text,
            context,
            note: note.text,
            signal: abort.signal,
          },
          {
            confirmTool: (call) =>
              otelContext.with(agentCtx, async () => {
                if (!stepsAllowed())
                  return { allow: false, message: "The conversation is paused." };
                const ask = tracer().startSpan("draft.permission.ask", {
                  attributes: { "draft.tool.name": call.name, "draft.tool.use_id": call.toolUseId },
                });
                // The prompt's age is in the log, like every other interrupt's.
                let askedAt = new Date().toISOString();
                try {
                  const [asked] = await this.append(
                    [
                      {
                        type: "agent.permission_asked",
                        address: itemAddress(this.conversation, newItemId(this.newId)),
                        conversation: this.conversation,
                        actor: agentActor(),
                        traceId,
                        data: { toolUseId: call.toolUseId, name: call.name, input: call.input },
                      },
                    ],
                    "agent.permission_asked",
                  );
                  if (asked !== undefined) askedAt = asked.at;
                } catch {
                  // The prompt still shows, with the time draft saw it.
                }
                const answer = await new Promise<PermissionAnswer>((resolve) => {
                  this.prompts.set(call.toolUseId, {
                    prompt: { id: call.toolUseId, tool: call.name, input: call.input },
                    at: askedAt,
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
                      ...(agent.environment === undefined
                        ? {}
                        : { environment: agent.environment }),
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
        // The reply to a wrap-up request is the thread's conclusion, waiting for a person's yes.
        if (wrapUp && failure === null && replyText.trim() !== "") {
          await this.append(
            [
              {
                type: "thread.conclusion_proposed",
                address: itemAddress(this.conversation, newItemId(this.newId)),
                conversation: this.conversation,
                actor: agentActor(),
                traceId,
                data: { text: replyText.trim(), cites: this.citations() },
              },
            ],
            "thread.propose",
          );
          m.threadEvents.add(1, { "draft.thread.event": "propose" });
        }
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
          await this.reconcile(target, snapshot, resolver, traceId);
        }
      }
      // What a person writes may name an item of another context. Only a person's own message
      // does: the agent's words never make draft read another context's log.
      if (kind === "explicit" && source === "text" && this.crossContext !== null) {
        for (const address of this.crossContext.detect(text)) {
          const key = contextItemKey(address);
          if (seen.has(key)) continue;
          seen.add(key);
          const snapshot = await this.crossContext.snapshot(address).catch(() => null);
          if (snapshot === null) continue;
          await this.append(
            [
              {
                type: "reference.made",
                address: itemAddress(this.conversation, newItemId(this.newId)),
                conversation: this.conversation,
                actor: this.user,
                traceId,
                data: {
                  from,
                  target: { type: CONTEXT_ITEM, id: address },
                  kind,
                  relation: "mentions",
                  source,
                  snapshot: { ...snapshot },
                },
              },
              {
                type: "context.crossed",
                address: itemAddress(this.conversation, newItemId(this.newId)),
                conversation: this.conversation,
                actor: this.user,
                traceId,
                data: {
                  purpose: "referenced",
                  context: snapshot.context,
                  target: address,
                  from,
                  snapshotHash: snapshot.hash,
                  via: null,
                },
              },
            ],
            "reference",
          );
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
      await otelContext.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
        const traceId = span.spanContext().traceId;
        await this.append([this.statusDraft(target, state, resolver, traceId)], "status");
        await this.reconcile(target, state, resolver, traceId);
      });
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
