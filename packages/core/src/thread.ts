import type { Actor } from "./events.ts";
import { defineMachine, type Firing, type Machine, withStandardEnds } from "./machine.ts";

/**
 * A thread's lifecycle, on the state machine module. It is open until its agent drafts a
 * conclusion; it then waits on a person to confirm or decline it. Confirming wraps the thread up,
 * and the conclusion returns to the main conversation. Superseded and withdrawn, each with a
 * reason, are available from every state that isn't over.
 *
 * `wrapped-up` is terminal for now. What closes a thread for good, a measurable sign of use in
 * production, adds states after it later (issue 8g9f7vqh).
 */
export type ThreadState = "open" | "concluding" | "wrapped-up" | "superseded" | "withdrawn";

export const THREAD_STATES: readonly ThreadState[] = [
  "open",
  "concluding",
  "wrapped-up",
  "superseded",
  "withdrawn",
];

/** A thread that has ended takes no more turns. */
export function isEnded(state: ThreadState): boolean {
  return state === "wrapped-up" || state === "superseded" || state === "withdrawn";
}

let machine: Machine<ThreadState> | null = null;

export function threadMachine(): Machine<ThreadState> {
  machine ??= defineMachine<ThreadState>(
    withStandardEnds(
      {
        name: "thread",
        version: 1,
        initial: "open",
        states: {
          open: {},
          concluding: {
            wait: {
              on: "user",
              timeoutMs: null,
              noTimeoutBecause: "its age is read by feedback and the map, which escalate it",
            },
          },
          "wrapped-up": { terminal: true },
        },
        transitions: [
          { from: ["open", "concluding"], to: "concluding", trigger: "propose", actors: ["agent"] },
          { from: "concluding", to: "wrapped-up", trigger: "confirm", actors: ["user"] },
          { from: "concluding", to: "open", trigger: "decline", actors: ["user"] },
        ],
      },
      ["superseded", "withdrawn"],
    ),
  ) as Machine<ThreadState>;
  return machine;
}

/** The events that move a thread, by the trigger each fires. */
export const THREAD_TRIGGERS = {
  "thread.conclusion_proposed": "propose",
  "thread.wrapped_up": "confirm",
  "thread.conclusion_declined": "decline",
} as const;

/** What the conclusion says it rests on: the thread, and what it produced. */
export interface Citations {
  /** The thread's conversation. */
  thread: string;
  /** The message it branched off. */
  parent: string;
  /** Its messages, and what it referenced: the things it produced that have a block of their own. */
  messages: number;
  produced: { type: string; id: string }[];
}

export interface ThreadEventRow {
  type: "proposed" | "wrapped-up" | "declined" | "ended";
  address: string;
  at: string;
  actor: Actor;
  /** For proposed and wrapped-up: the conclusion. */
  text: string | null;
  cites: Citations | null;
  /** For wrapped-up and declined: the proposal it answers. */
  proposal: string | null;
  /** For ended: how, and why. */
  endedAs: "superseded" | "withdrawn" | null;
  reason: string | null;
}

export interface ThreadFold {
  state: ThreadState;
  /** The latest proposal while concluding, or the conclusion that wrapped the thread up. */
  conclusion: {
    address: string;
    text: string;
    cites: Citations;
    proposedAt: string;
    proposedBy: Actor;
    wrappedAt: string | null;
  } | null;
  endedReason: string | null;
  /** Events the machine did not allow, which are broken invariants. */
  rejected: number;
}

/** Folds a thread's events through its machine. */
export function foldThread(events: readonly ThreadEventRow[]): ThreadFold {
  const m = threadMachine();
  let state: ThreadState = m.initial;
  let conclusion = null as ThreadFold["conclusion"];
  let endedReason: string | null = null;
  let rejected = 0;
  for (const e of events) {
    const firing: Firing & { trigger: string } = {
      trigger:
        e.type === "proposed"
          ? "propose"
          : e.type === "wrapped-up"
            ? "confirm"
            : e.type === "declined"
              ? "decline"
              : (e.endedAs as string),
      actor: e.actor.kind,
      reason: e.reason,
    };
    const step = m.next(state, firing.trigger, firing.actor, firing.reason);
    if (!step.ok) {
      rejected++;
      continue;
    }
    state = step.to;
    if (e.type === "proposed" && e.text !== null && e.cites !== null) {
      conclusion = {
        address: e.address,
        text: e.text,
        cites: e.cites,
        proposedAt: e.at,
        proposedBy: e.actor,
        wrappedAt: null,
      };
    } else if (e.type === "wrapped-up" && conclusion !== null) {
      conclusion = { ...conclusion, wrappedAt: e.at };
    } else if (e.type === "declined") {
      conclusion = null;
    } else if (e.type === "ended") {
      endedReason = e.reason;
    }
  }
  return { state, conclusion, endedReason, rejected };
}
