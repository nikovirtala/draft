import { z } from "zod";

/**
 * Kiro Remote's change feed, as draft reads it (nikovirtala/kiro-remote docs/github.md, "The change
 * feed"; the decision behind it is ark ADR 9t6n5jc6). Pure: parsing and what to do with an event,
 * with no log, network or Electron in it, so ark's folds can read the same feed.
 *
 * The contract is Kiro Remote's zod objects, published as JSON Schemas. draft vendors those
 * (schemas/kiro-remote-feed, at the commit PINNED.json names) and checks its reader against them in
 * test/kiro-feed-contract.test.ts, so a type, a field or a value that moves there fails here.
 *
 * Reading rules, from the contract:
 * - An event of a type the reader knows is handled.
 * - An `annotation` of a type it doesn't know is skipped.
 * - A `state` event it doesn't know (or can't read, or of another contract version) stops the
 *   fold: the state it would rebuild would be wrong.
 * - A `source` it doesn't know is opaque: kept and shown as it is, never matched on. So is any
 *   value of a payload enum (a wait's end reason, a wake's cause, ...): enums gain values within
 *   `v: 1`, and an unknown one is shown and never stops the fold.
 * - Fields it doesn't know are ignored.
 */

/** The feed's name in draft's log and views. */
export const KIRO_FEED = "kiro-remote";

/** The contract version this reader understands. */
export const KIRO_FEED_VERSION = 1;

/** `owner/repo#n`, as the feed names a pull request. */
export const PR_REF = /^[^/\s]+\/[^#\s]+#[1-9][0-9]*$/;
const PrRef = z.string().regex(PR_REF, "owner/repo#n");
/**
 * The values of each payload enum that the contract lists (the vendored schemas), for display and
 * logic. They are not a filter: an enum may gain values within `v: 1`, and a reader treats a value
 * it doesn't know as opaque, shows it, and never fails or stops because of it (Kiro Remote's
 * docs/github.md, "The rule for enum values"). So every payload enum is read as a bounded string.
 */
export const PR_STATES = ["open", "closed", "merged", "unknown"] as const;
export const LINK_METHODS = ["harvest", "trailer", "manual"] as const;
export const WAIT_SOURCES = ["mcp", "rest", "trailer"] as const;
export const LINK_REMOVE_REASONS = ["unlinked"] as const;

/** Why a session is woken: its own PR's event, its PR no longer merging, or a PR it waits for. */
export const WAKE_CAUSES = ["linked_pr_event", "conflict", "wait"] as const;

/** Why a wait ended: it fired (merged, closed, unreadable), or it was removed (stopped, failed). */
export const WAIT_END_REASONS = [
  "merged",
  "closed",
  "unreadable",
  "stopped",
  "registration_failed",
] as const;

/** An enum value: one the contract lists, or one it gained since, kept as given. */
export type Opaque<T extends string> = T | (string & {});
export type WakeCause = Opaque<(typeof WAKE_CAUSES)[number]>;
export type WaitEndReason = Opaque<(typeof WAIT_END_REASONS)[number]>;

/** The wait ends that leave a session with nothing to wake it for the pull request. */
export const UNREAD_WAIT_REASONS: readonly string[] = ["unreadable", "registration_failed"];

const EnumValue = z.string().min(1).max(60);

const wakeItem = {
  itemId: z.string().min(1),
  kind: z.string().min(1).max(40),
  cause: EnumValue,
};

/** The enum fields of each type's payload, with the values the contract lists for each. */
export const FEED_ENUMS: Record<string, Record<string, readonly string[]>> = {
  "link.added": { method: LINK_METHODS, prState: PR_STATES },
  "link.removed": { reason: LINK_REMOVE_REASONS },
  "link.state_changed": { from: PR_STATES, to: PR_STATES },
  "wait.registered": { waitSource: WAIT_SOURCES },
  "wait.removed": { reason: WAIT_END_REASONS },
  "wake.queued": { cause: WAKE_CAUSES },
  "wake.delivered": { cause: WAKE_CAUSES },
  "wake.released": { cause: WAKE_CAUSES },
  "wake.dropped": { cause: WAKE_CAUSES },
};

/**
 * The payload of each type the reader knows, and whether it moves state. Fields the contract
 * doesn't name are ignored (loose objects), as the contract asks.
 */
export const FEED_TYPES = {
  "link.added": {
    effect: "state",
    payload: z.looseObject({ method: EnumValue, prState: EnumValue }),
  },
  "link.removed": { effect: "state", payload: z.looseObject({ reason: EnumValue }) },
  "link.state_changed": {
    effect: "state",
    payload: z.looseObject({ from: EnumValue, to: EnumValue }),
  },
  "wait.registered": {
    effect: "state",
    payload: z.looseObject({ waitSource: EnumValue }),
  },
  "wait.removed": {
    effect: "state",
    payload: z.looseObject({ reason: EnumValue }),
  },
  "wake.queued": {
    effect: "annotation",
    payload: z.looseObject({ ...wakeItem, merged: z.boolean() }),
  },
  "wake.delivered": {
    effect: "annotation",
    payload: z.looseObject({ ...wakeItem, turnId: z.string().min(1) }),
  },
  "wake.released": {
    effect: "annotation",
    payload: z.looseObject({ ...wakeItem, turnId: z.string().min(1) }),
  },
  "wake.dropped": {
    effect: "annotation",
    payload: z.looseObject({ ...wakeItem, reason: z.string().min(1).max(60) }),
  },
} as const;

export type FeedType = keyof typeof FEED_TYPES;
export const FEED_TYPE_NAMES = Object.keys(FEED_TYPES) as FeedType[];
export const KNOWN_FEED_TYPES: ReadonlySet<string> = new Set(FEED_TYPE_NAMES);

export type FeedPayload<T extends FeedType> = z.infer<(typeof FEED_TYPES)[T]["payload"]>;

/**
 * What every event has, whatever its type. `effect` and `source` are kept as received: an unknown
 * source is opaque, and an unknown effect is read as a state change (the safe way).
 */
export const FeedEnvelopeSchema = z.looseObject({
  v: z.number().int().min(1),
  id: z.string().min(1),
  seq: z.number().int().min(1),
  ts: z.string().min(1),
  type: z.string().min(1).max(60),
  effect: z.string().min(1),
  sessionId: z.string().min(1),
  pr: PrRef.nullable(),
  source: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type FeedEnvelope = z.infer<typeof FeedEnvelopeSchema>;

/** An envelope of a type the reader knows, with its payload typed. */
export interface FeedEnvelopeFields {
  v: number;
  id: string;
  seq: number;
  ts: string;
  sessionId: string;
  pr: string | null;
  source: string;
}
export type KnownFeedEvent = {
  [T in FeedType]: FeedEnvelopeFields & {
    type: T;
    effect: (typeof FEED_TYPES)[T]["effect"];
    payload: FeedPayload<T>;
  };
}[FeedType];

/** A page of the feed, as GET /v1/events answers it. */
export const FeedPageSchema = z.looseObject({
  events: z.array(z.unknown()),
  nextCursor: z.number().int().min(0),
  hasMore: z.boolean(),
});
export interface RawFeedPage {
  events: unknown[];
  nextCursor: number;
  hasMore: boolean;
}

/** Why a reader stopped following the feed. */
export type StopReason =
  /** A `state` type it doesn't know. */
  | "type"
  /** An event of another contract version. */
  | "version"
  /** A `state` event it could not read. */
  | "invalid";

/** What a reader does with one event of the feed. */
export type FeedDisposition =
  | { kind: "handle"; event: KnownFeedEvent }
  /** Kept in the log as received, and not followed: an annotation it doesn't know or can't read. */
  | { kind: "skip"; event: FeedEnvelope }
  | { kind: "stop"; reason: StopReason; type: string; seq: number | null };

/**
 * What to do with an event, from what the reader knows (the contract's `feedEventDisposition`).
 * Never throws: whatever the feed sends is data.
 */
export function classifyFeedEvent(
  raw: unknown,
  known: ReadonlySet<string> = KNOWN_FEED_TYPES,
): FeedDisposition {
  const env = FeedEnvelopeSchema.safeParse(raw);
  if (!env.success) {
    const r = raw as { type?: unknown; seq?: unknown } | null;
    return {
      kind: "stop",
      reason: "invalid",
      type: typeof r?.type === "string" && r.type !== "" ? r.type : "(unreadable)",
      seq: typeof r?.seq === "number" && Number.isInteger(r.seq) ? r.seq : null,
    };
  }
  const e = env.data;
  // A reader that meets another version of the contract can't tell what an event means.
  if (e.v !== KIRO_FEED_VERSION)
    return { kind: "stop", reason: "version", type: e.type, seq: e.seq };
  const annotation = e.effect === "annotation";
  if (!known.has(e.type) || !(e.type in FEED_TYPES))
    return annotation
      ? { kind: "skip", event: e }
      : { kind: "stop", reason: "type", type: e.type, seq: e.seq };
  const spec = FEED_TYPES[e.type as FeedType];
  const payload = spec.payload.safeParse(e.payload);
  // The envelope's effect must be the type's: an event that says otherwise is not the one known.
  if (!payload.success || e.effect !== spec.effect)
    return annotation
      ? { kind: "skip", event: e }
      : { kind: "stop", reason: "invalid", type: e.type, seq: e.seq };
  return { kind: "handle", event: { ...e, payload: payload.data } as KnownFeedEvent };
}

/** A pull request as the feed names it (`owner/repo#n`) and as draft's stubs do (`owner/repo/pull/n`). */
export function prTargetId(ref: string): string {
  const m = /^(.+)#(\d+)$/.exec(ref);
  return m === null ? ref : `${m[1]}/pull/${m[2]}`;
}

/** The feed's reference of a pull request stub's id; null when the id is not one. */
export function prRefOfTarget(id: string): string | null {
  const m = /^(.+)\/pull\/(\d+)$/.exec(id);
  return m === null ? null : `${m[1]}#${m[2]}`;
}
