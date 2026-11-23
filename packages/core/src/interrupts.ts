import type { ActorKind, Machine } from "./machine.ts";
import { defineMachine } from "./machine.ts";

/**
 * Interrupts: what needs a person, in one place and one order. Each kind has a lifecycle on the
 * state machine module: open, then settled by a person with one of the kind's outcomes, or
 * cleared when its source stops needing the person (a check passes, a permission is answered
 * elsewhere). Nothing else closes one, and the agent can settle none of them.
 *
 * Attention order: blocking permission requests first, then failures, then acceptance requests
 * (green work waiting for a yes), then what is left to resolve, then reviews requested; oldest
 * first within each. A new kind joins by naming its rank.
 */

export type InterruptKind =
  | "permission"
  | "failed-check"
  | "merge-conflict"
  | "changes-requested"
  | "failed-step"
  | "unasked-call"
  | "unfinished-step"
  | "conclusion"
  | "review-requested"
  | "acceptance"
  | "check";

export interface InterruptKindSpec {
  /** Where the kind sits in the attention order: lower comes first. */
  rank: number;
  /** What a person can settle it as. */
  outcomes: readonly string[];
  /** Short name for lists and the title bar. */
  label: string;
}

/** The attention ranks, in order. */
export const RANKS = { blocking: 0, failure: 1, accept: 2, resolve: 3, review: 4 } as const;

export const INTERRUPT_KINDS: Record<InterruptKind, InterruptKindSpec> = {
  permission: {
    rank: RANKS.blocking,
    outcomes: ["allowed", "denied"],
    label: "Permission request",
  },
  "failed-check": { rank: RANKS.failure, outcomes: ["acknowledged"], label: "Failed check" },
  "merge-conflict": { rank: RANKS.failure, outcomes: ["acknowledged"], label: "Merge conflict" },
  "changes-requested": {
    rank: RANKS.failure,
    outcomes: ["acknowledged"],
    label: "Changes requested",
  },
  "failed-step": { rank: RANKS.failure, outcomes: ["acknowledged", "retry"], label: "Failed step" },
  "unasked-call": {
    rank: RANKS.failure,
    outcomes: ["acknowledged"],
    label: "Call without asking",
  },
  "unfinished-step": {
    rank: RANKS.resolve,
    outcomes: ["done", "failed", "retry"],
    label: "Interrupted step",
  },
  conclusion: { rank: RANKS.resolve, outcomes: ["confirmed", "declined"], label: "Conclusion" },
  "review-requested": {
    rank: RANKS.review,
    outcomes: ["acknowledged"],
    label: "Review requested",
  },
  /**
   * Something is ready and waits for a person's yes, with its evidence green (docs/model.md,
   * "Acceptance"). It ranks after failures, because something broken may make it moot, and before
   * what is left to resolve, because it is what the rest of the process is stopped at.
   */
  acceptance: {
    rank: RANKS.accept,
    outcomes: ["accepted", "changes-requested", "rejected"],
    label: "Acceptance request",
  },
  /**
   * What a merged pull request still leaves for the person, as a check (check.ts). It is not an
   * `interrupt.*` event: its own facts are in the log, and it joins the attention order here.
   * It ranks with what is left to resolve: nothing is broken, and it stops no one but the person.
   */
  check: { rank: RANKS.resolve, outcomes: ["passed", "failed"], label: "Check" },
};

export type InterruptState = "open" | "settled" | "cleared";

const machines = new Map<InterruptKind, Machine<InterruptState>>();

/**
 * The lifecycle of one kind of interrupt. Settling is person-only; only the source (a resolver,
 * or draft itself) can clear one, with a reason.
 */
export function interruptMachine(kind: InterruptKind): Machine<InterruptState> {
  let m = machines.get(kind);
  if (m === undefined) {
    m = defineMachine<InterruptState>({
      name: `interrupt:${kind}`,
      version: 1,
      initial: "open",
      states: {
        open: {
          wait: {
            on: "user",
            timeoutMs: null,
            noTimeoutBecause: "its age is read by feedback and the map, which escalate it",
          },
        },
        settled: { terminal: true },
        cleared: { terminal: true },
      },
      transitions: [
        ...INTERRUPT_KINDS[kind].outcomes.map((o) => ({
          from: "open" as const,
          to: "settled" as const,
          trigger: `settle:${o}`,
          actors: ["user"] as readonly ActorKind[],
          personOnly: true,
        })),
        {
          from: "open",
          to: "cleared",
          trigger: "clear",
          actors: ["resolver", "system"],
          reason: true,
        },
      ],
    });
    machines.set(kind, m);
  }
  return m;
}

/** Something that needs a person in one conversation: one count, in one order, across all of them. */
export interface AttentionItem {
  id: string;
  conversation: string;
  cause: InterruptKind;
  /** When it arose; its age is now minus this. */
  at: string;
  /** Where in the log it arose, when it did: it settles ties between events of the same millisecond. */
  seq?: number;
}

export function attentionRank(cause: InterruptKind): number {
  return INTERRUPT_KINDS[cause].rank;
}

/**
 * The attention order: by rank, then oldest first (by time, then by place in the log), then by id
 * so the order is total.
 */
export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  return (
    attentionRank(a.cause) - attentionRank(b.cause) ||
    (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) ||
    (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function orderAttention<T extends AttentionItem>(items: readonly T[]): T[] {
  return [...items].sort(compareAttention);
}

/** How long an interrupt has waited, in milliseconds, from its creation time. */
export function ageMs(at: string, now: number = Date.now()): number {
  return Math.max(0, now - Date.parse(at));
}

/** What a resolver says needs a person, given the target's state. */
export interface InterruptCandidate {
  /** Stable for as long as it is the same thing: the same request, check on the same commit. */
  key: string;
  kind: InterruptKind;
  summary: string;
  detail: Record<string, unknown>;
}
