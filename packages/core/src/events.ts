import { z } from "zod";
import { tryParseAddress } from "./address.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { isUlid } from "./ids.ts";

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

/** The data of each event type at schema version 1. Data is stored as received; these check it. */
export const EventData = {
  "context.created": z.object({ context: z.string().min(1), title: z.string() }),
  "conversation.created": z.object({
    conversation: ConversationString,
    title: z.string(),
    /** The message a thread branches off; `null` for a top-level conversation. */
    parent: AddressString(true).nullable(),
  }),
  "message.posted": z.object({
    role: z.enum(["user", "agent"]),
    text: z.string(),
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

/** The schema version this build writes for every event type. */
export const SCHEMA_VERSION = 1;

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
  ? Omit<Envelope, "type" | "data"> & { type: T; data: EventDataOf<T> }
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
  if (c.schema > SCHEMA_VERSION) return { ok: true, record: new UnknownEvent(c, "newer-schema") };
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
  if (e.schema > SCHEMA_VERSION) {
    return { ok: false, reason: `schema version ${e.schema} is newer than ${SCHEMA_VERSION}` };
  }
  if ((e.conversation === null) !== (e.type === "context.created")) {
    return { ok: false, reason: "only context.created has no conversation" };
  }
  const data = EventData[e.type as EventType].safeParse(e.data);
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
    schema: SCHEMA_VERSION,
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
