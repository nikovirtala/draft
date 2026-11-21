import { z } from "zod";
import { tryParseAddress } from "./address.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { isUlid } from "./ids.ts";
import { INTERRUPT_KINDS, type InterruptKind } from "./interrupts.ts";

/** The previous hash of the first event in a log. */
export const GENESIS_HASH = "0".repeat(64);

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");
const TraceId = z.string().regex(/^[0-9a-f]{32}$/, "must be a 32-character hex trace ID");
const AddressString = (versioned: boolean) =>
  z.string().refine(
    (s) => {
      const a = tryParseAddress(s);
      return a !== null && (!versioned || a.version !== null);
    },
    versioned ? "must be a versioned address" : "must be an address",
  );
const ConversationString = z.string().refine((s) => {
  const a = tryParseAddress(s);
  return a !== null && a.conversation !== null && a.item === null && a.version === null;
}, "must be <context>/<conversation>");

/**
 * Who wrote an event. The agent never acts under the user's identity. A user is a stable identity
 * (a ULID created on the device's first run), never an assumed "me", so adding people later needs
 * no migration; `name` is the display name at the time of the event.
 */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().min(1), name: z.string().min(1) }),
  z.object({
    kind: z.literal("agent"),
    id: z.string().min(1),
    model: z.string().min(1),
    version: z.string().min(1),
  }),
  z.object({ kind: z.literal("resolver"), id: z.string().min(1), version: z.string().min(1) }),
  z.object({ kind: z.literal("system"), id: z.string().min(1), version: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;

/** A reference target outside the log, named by its resolver type and its own id. */
export const TargetSchema = z.object({ type: z.string().min(1), id: z.string().min(1) });
export type Target = z.infer<typeof TargetSchema>;

export function targetKey(t: Target): string {
  return `${t.type}:${t.id}`;
}

export const EdgeKindSchema = z.enum(["structural", "explicit", "suggested"]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/**
 * Who a message is for. `people` is everyone in the conversation, or named people once there are
 * several (an ID list), so "people only" and "people and the agent" grow into named audiences
 * without a migration. `agent` says whether the agent may read the message.
 */
export const AudienceSchema = z.object({
  people: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
  agent: z.boolean(),
});
export type Audience = z.infer<typeof AudienceSchema>;

export const PEOPLE_ONLY: Audience = { people: "all", agent: false };
export const PEOPLE_AND_AGENT: Audience = { people: "all", agent: true };

export const InterruptKindSchema = z.enum(
  Object.keys(INTERRUPT_KINDS) as [InterruptKind, ...InterruptKind[]],
);

/** What a conclusion rests on: the thread, and what it produced. */
export const CitationsSchema = z.object({
  thread: ConversationString,
  parent: AddressString(true),
  messages: z.number().int().min(0),
  produced: z.array(TargetSchema),
});

export const AgentStateSchema = z.enum(["active", "paused"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

/** The data of each event type at the schema version this build writes. Data is stored as received; these check it. */
export const EventData = {
  "context.created": z.object({ context: z.string().min(1), title: z.string() }),
  "conversation.created": z.object({
    conversation: ConversationString,
    title: z.string(),
    /** The message a thread branches off; `null` for a top-level conversation. */
    parent: AddressString(true).nullable(),
  }),
  /**
   * A message and who it is for. Every message carries its audience, so what the agent may read is
   * decided where its context is built, from the log, never by the UI.
   */
  "message.posted": z.object({
    role: z.enum(["user", "agent"]),
    text: z.string(),
    audience: AudienceSchema,
  }),
  /** Whether the agent takes part in the conversation, set by a person. */
  "agent.state_changed": z.object({ state: AgentStateSchema }),
  /**
   * A tool call that changes something (or that draft can't tell from one) ran without the agent
   * asking first, so no step was started before it. It shows as an interrupt.
   */
  "agent.anomaly": z.object({
    kind: z.enum(["call-without-permission"]),
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    /** The call's status when draft saw it run. */
    status: z.string().min(1),
  }),
  /**
   * Which agent runs a conversation, chosen by a person: when a thread starts, or later as an
   * explicit switch. The new agent's session starts from the log's projection, the same path as
   * recovering from a crash (ADR h89hcrk6). A conversation with none runs on the default agent.
   */
  "agent.selected": z.object({
    agent: z.string().min(1),
    /** The agent it ran on until now; `null` when a thread starts. */
    previous: z.string().min(1).nullable(),
    reason: z.enum(["thread-start", "switch"]),
    /** What the new session starts from, as shown to the person before they chose. */
    context: z
      .object({
        messages: z.number().int().min(0),
        openItems: z.number().int().min(0),
        decisions: z.number().int().min(0),
        references: z.number().int().min(0),
        characters: z.number().int().min(0),
      })
      .nullable(),
  }),
  /** An agent session began for the conversation, from this context and no memory of the agent's own. */
  "agent.session_started": z.object({
    agent: z.string().min(1),
    agentVersion: z.string().min(1),
    model: z.string().min(1),
    /** sha256 of the context the session started from, so "what did it know?" has an answer. */
    contextHash: Hex64,
    contextMessages: z.number().int().min(0),
    contextOpenItems: z.number().int().min(0),
  }),
  /**
   * The log's last line was never completed, so it was never confirmed: its bytes moved to a
   * sidecar file next to the log, and the log carries on from the line before.
   */
  "log.recovered": z.object({
    sidecar: z.string().min(1),
    bytes: z.number().int().min(1),
    hash: Hex64,
  }),
  /**
   * A tool call that changes nothing: a read-only call with its result, or a refused call. Calls
   * that change something are steps (`step.started`, then `step.completed` or `step.failed`).
   */
  "agent.tool_called": z.object({
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    /**
     * How the call was allowed or refused: the grounds of the action. `approved-by-user` appears
     * only if a call that changes something reported a result without a step, which draft's tool
     * policy doesn't allow to happen.
     */
    decision: z.enum([
      "allowed-read-only",
      "approved-by-user",
      "denied-by-user",
      "denied-by-policy",
    ]),
    /** A bounded summary of the result; `null` when the call never ran. */
    resultSummary: z.string().nullable(),
    isError: z.boolean(),
  }),
  /**
   * A call that changes something, recorded after it is allowed and before it runs: its intent and
   * its grounds. A step without a completion never runs again; it shows as an interrupt.
   */
  "step.started": z.object({
    /** A fresh key per step, for services that deduplicate retried calls. */
    idempotencyKey: z.string().min(1),
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    decision: z.literal("approved-by-user"),
    /**
     * The step this one retries: a person settled that step as "retry", so this is a new step
     * with its own key. The old one is never run again.
     */
    retryOf: AddressString(true).optional(),
  }),
  /** The step ran and its tool reported success. */
  "step.completed": z.object({
    started: AddressString(true),
    idempotencyKey: z.string().min(1),
    resultSummary: z.string(),
  }),
  /** The step ran and its tool reported an error. */
  "step.failed": z.object({
    started: AddressString(true),
    idempotencyKey: z.string().min(1),
    resultSummary: z.string(),
  }),
  /**
   * Something outside the log needs a person: a hosted session's permission request, a failed
   * check, a merge conflict. Written by the resolver that saw it, in the conversation it belongs
   * to; its time is when it arose, so its age is derivable from the log. Interrupts that are
   * computed from other events (an unfinished step, a call that ran unasked) need no such event.
   */
  "interrupt.raised": z.object({
    key: z.string().min(1),
    kind: InterruptKindSchema,
    target: TargetSchema.nullable(),
    summary: z.string(),
    detail: z.record(z.string(), z.unknown()),
  }),
  /** The source stopped needing a person: the check passes, the request was answered elsewhere. */
  "interrupt.cleared": z.object({
    key: z.string().min(1),
    kind: InterruptKindSchema,
    reason: z.string().min(1),
  }),
  /**
   * A person settled an interrupt, as themselves. For a step it names the started step; `via` is
   * the step that carried the settlement out (answering a permission, retrying), when there was one.
   */
  "interrupt.settled": z.object({
    key: z.string().min(1),
    kind: InterruptKindSchema,
    outcome: z.string().min(1),
    started: AddressString(true).nullable(),
    via: AddressString(true).nullable(),
    detail: z.record(z.string(), z.unknown()),
  }),
  /** A thread's agent drafted a conclusion for the main conversation; it waits for a person. */
  "thread.conclusion_proposed": z.object({
    text: z.string().min(1),
    cites: CitationsSchema,
  }),
  /** A person confirmed the proposal: the thread wraps up and the conclusion returns to its parent. */
  "thread.wrapped_up": z.object({
    proposal: AddressString(true),
    text: z.string().min(1),
    cites: CitationsSchema,
    /** The conversation the conclusion returns to. */
    returnedTo: ConversationString,
  }),
  "thread.conclusion_declined": z.object({ proposal: AddressString(true) }),
  /** A person ended a thread as superseded or withdrawn, with a reason. */
  "thread.ended": z.object({
    state: z.enum(["superseded", "withdrawn"]),
    reason: z.string().min(1),
  }),
  /** A note draft shows in the conversation, such as how it reaches GitHub. */
  "notice.posted": z.object({ what: z.string().min(1), text: z.string().min(1) }),
  "reference.made": z.object({
    from: AddressString(true),
    target: TargetSchema,
    kind: EdgeKindSchema,
    relation: z.string().min(1),
    /** Where the mention was found: message text or a tool result. */
    source: z.enum(["text", "tool-result"]),
    /** The target's state at the moment it was referenced. */
    snapshot: z.record(z.string(), z.unknown()),
  }),
  "status.observed": z.object({
    target: TargetSchema,
    state: z.record(z.string(), z.unknown()),
  }),
} as const;

export type EventType = keyof typeof EventData;
export const EVENT_TYPES = Object.keys(EventData) as EventType[];
export type EventDataOf<T extends EventType> = z.infer<(typeof EventData)[T]>;

/**
 * The schema version this build writes for each event type. A type's version rises when its data
 * changes in a way an older build must not read: that build keeps the event as one it doesn't
 * understand, instead of showing it with something missing.
 */
export const SCHEMA_VERSIONS: Record<EventType, number> = {
  "context.created": 1,
  "conversation.created": 1,
  "message.posted": 2,
  "agent.state_changed": 1,
  "agent.anomaly": 1,
  "agent.session_started": 1,
  "agent.selected": 1,
  "agent.tool_called": 1,
  "step.started": 1,
  "step.completed": 1,
  "step.failed": 1,
  "interrupt.raised": 1,
  "interrupt.cleared": 1,
  "interrupt.settled": 1,
  "thread.conclusion_proposed": 1,
  "thread.wrapped_up": 1,
  "thread.conclusion_declined": 1,
  "thread.ended": 1,
  "notice.posted": 1,
  "reference.made": 1,
  "status.observed": 1,
  "log.recovered": 1,
};

export function schemaVersionOf(type: EventType): number {
  return SCHEMA_VERSIONS[type];
}

/** `message.posted` at schema version 1, which had no audience: every message reached the agent. */
const MessagePostedV1 = z.object({ role: z.enum(["user", "agent"]), text: z.string() });
export type MessagePostedV1Data = z.infer<typeof MessagePostedV1>;

/** Older versions of a type's data that this build still reads. Old versions are upcast on read; the log is never rewritten. */
const OLDER_DATA: { [T in EventType]?: Record<number, z.ZodType> } = {
  "message.posted": { 1: MessagePostedV1 },
};

/** What `message.posted` of any version read carries; use `audienceOf` for the audience. */
export type MessagePostedData = EventDataOf<"message.posted"> | MessagePostedV1Data;

/** Messages written before audiences existed went to everyone, the agent included. */
export function audienceOf(data: MessagePostedData): Audience {
  return "audience" in data ? data.audience : PEOPLE_AND_AGENT;
}

function dataSchema(type: EventType, version: number): z.ZodType | null {
  if (version === SCHEMA_VERSIONS[type]) return EventData[type];
  return OLDER_DATA[type]?.[version] ?? null;
}

/**
 * What every record needs so the chain can be checked, whatever its type: a newer draft, or another
 * context, may write event types and schema versions this build has never heard of.
 */
export const ChainFieldsSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  schema: z.number().int().min(1),
  prevHash: Hex64,
  hash: Hex64,
});

/**
 * The one envelope every event of a known type shares. `data` is kept exactly as received, and so
 * are envelope fields this build doesn't know.
 */
const envelopeShape = {
  id: z.string().refine(isUlid, "must be a ULID"),
  at: z.iso.datetime({ precision: 3 }),
  address: AddressString(true),
  conversation: ConversationString.nullable(),
  type: z.string().min(1),
  schema: z.number().int().min(1),
  actor: ActorSchema,
  traceId: TraceId.nullable(),
  prevHash: Hex64,
  hash: Hex64,
  data: z.unknown(),
};
export const EnvelopeSchema = z.looseObject(envelopeShape);
const StrictEnvelope = z.object(envelopeShape);
export type Envelope = z.infer<typeof StrictEnvelope>;

/** A typed view of an envelope whose data passed its type's schema. */
export type DraftEvent<T extends EventType = EventType> = T extends EventType
  ? Omit<Envelope, "type" | "data"> & {
      type: T;
      data: T extends "message.posted" ? MessagePostedData : EventDataOf<T>;
    }
  : never;

/** What a writer supplies; the log fills in `id`, `prevHash` and `hash`. */
export type EventDraft<T extends EventType = EventType> = T extends EventType
  ? {
      type: T;
      address: string;
      conversation: string | null;
      actor: Actor;
      traceId: string | null;
      data: EventDataOf<T>;
      at?: string;
    }
  : never;

/** Events about the whole context or its log, not about a conversation. */
const NO_CONVERSATION: ReadonlySet<string> = new Set(["context.created", "log.recovered"]);

export type ParseResult = { ok: true; event: DraftEvent } | { ok: false; reason: string };

/**
 * A record this build can't interpret: an unknown event type, or a known type at a newer schema
 * version. It is kept exactly as received, chained like any other event, skipped by projections,
 * counted, and shown as a generic block.
 */
export class UnknownEvent {
  readonly id: string;
  readonly type: string;
  readonly schema: number;
  readonly prevHash: string;
  readonly hash: string;
  /** Best effort: the record's time and conversation, when they read as such. */
  readonly at: string | null;
  readonly conversation: string | null;
  readonly reason: "unknown-type" | "newer-schema";
  /** The record as received. */
  readonly raw: Readonly<Record<string, unknown>>;

  constructor(raw: z.infer<typeof ChainFieldsSchema>, reason: UnknownEvent["reason"]) {
    this.id = raw.id;
    this.type = raw.type;
    this.schema = raw.schema;
    this.prevHash = raw.prevHash;
    this.hash = raw.hash;
    this.at = typeof raw.at === "string" ? raw.at : null;
    this.conversation = typeof raw.conversation === "string" ? raw.conversation : null;
    this.reason = reason;
    this.raw = raw;
  }
}

/** One record of the log: an event this build understands, or one it keeps without understanding. */
export type LogRecord = DraftEvent | UnknownEvent;

export function isUnknown(r: LogRecord): r is UnknownEvent {
  return r instanceof UnknownEvent;
}

/** The events of a log this build understands. */
export function knownEvents(records: readonly LogRecord[]): DraftEvent[] {
  return records.filter((r): r is DraftEvent => !isUnknown(r));
}

/**
 * The hash of a record: sha256(prevHash + canonical JSON of the record without `hash`). Computed
 * over the record as received, so fields this build doesn't know are covered too.
 */
export function eventHash(
  e: { readonly prevHash: string } & Readonly<Record<string, unknown>>,
): string {
  const { hash: _ignored, ...rest } = e;
  return sha256Hex(e.prevHash + canonicalJson(rest));
}

export type ReadResult = { ok: true; record: LogRecord } | { ok: false; reason: string };

/**
 * Reads one record of a log. A record without the chain fields, or a known type at a known schema
 * version that fails its schema, is invalid. An unknown type or a newer schema version is kept.
 */
export function readRecord(raw: unknown): ReadResult {
  const chain = ChainFieldsSchema.safeParse(raw);
  if (!chain.success) return { ok: false, reason: `not an event record: ${issues(chain.error)}` };
  const c = chain.data;
  if (!(c.type in EventData)) return { ok: true, record: new UnknownEvent(c, "unknown-type") };
  if (c.schema > SCHEMA_VERSIONS[c.type as EventType])
    return { ok: true, record: new UnknownEvent(c, "newer-schema") };
  const parsed = parseEvent(raw);
  return parsed.ok ? { ok: true, record: parsed.event } : parsed;
}

function issues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Checks the envelope and data of an event of a known type. Unknown event types and newer schema
 * versions are reported here, not guessed at; `readRecord` keeps them instead.
 */
export function parseEvent(raw: unknown): ParseResult {
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, reason: `envelope: ${issues(env.error)}` };
  const e = env.data;
  if (!(e.type in EventData))
    return { ok: false, reason: `unknown event type ${JSON.stringify(e.type)}` };
  const latest = SCHEMA_VERSIONS[e.type as EventType];
  if (e.schema > latest) {
    return { ok: false, reason: `schema version ${e.schema} is newer than ${latest}` };
  }
  if ((e.conversation === null) !== NO_CONVERSATION.has(e.type)) {
    return { ok: false, reason: "only context.created and log.recovered have no conversation" };
  }
  const schema = dataSchema(e.type as EventType, e.schema);
  if (schema === null) {
    return { ok: false, reason: `no schema for ${e.type} at version ${e.schema}` };
  }
  const data = schema.safeParse(e.data);
  if (!data.success) return { ok: false, reason: `data: ${issues(data.error)}` };
  return { ok: true, event: { ...e, data: e.data } as DraftEvent };
}

/** Seals a draft into an envelope chained to `prevHash`. */
export function sealEvent(
  draft: EventDraft,
  o: { id: string; at: string; prevHash: string },
): DraftEvent {
  const unsealed = {
    id: o.id,
    at: draft.at ?? o.at,
    address: draft.address,
    conversation: draft.conversation,
    type: draft.type,
    schema: SCHEMA_VERSIONS[draft.type],
    actor: draft.actor,
    traceId: draft.traceId,
    prevHash: o.prevHash,
    data: draft.data,
  };
  // A JSON round trip first, so the hash covers exactly what is written and read back.
  const plain = JSON.parse(JSON.stringify(unsealed)) as Omit<Envelope, "hash">;
  const sealed = { ...plain, hash: eventHash(plain) };
  const checked = parseEvent(sealed);
  if (!checked.ok)
    throw new TypeError(`refusing to write an invalid ${draft.type} event: ${checked.reason}`);
  return checked.event;
}
