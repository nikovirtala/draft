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

/** Who wrote an event. The agent never acts under the user's identity. */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string().min(1) }),
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
  "agent.tool_called": z.object({
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    /** How the call was allowed or refused: the grounds of the action. */
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

/** The one envelope every event shares. `data` is kept exactly as received. */
export const EnvelopeSchema = z.object({
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
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

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

/** The hash of an envelope: sha256(prevHash + canonical JSON of the envelope without `hash`). */
export function eventHash(e: Omit<Envelope, "hash"> | Envelope): string {
  const { hash: _ignored, ...rest } = e as Envelope;
  return sha256Hex(e.prevHash + canonicalJson(rest));
}

function issues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Checks an envelope and its data. Unknown event types and newer schema versions are reported,
 * not guessed at: a later build may know them, and the raw event stays in the log either way.
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
