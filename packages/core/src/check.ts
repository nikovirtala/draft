import { type AfterDeployItem, parseAfterDeploy } from "./after-deploy.ts";
import {
  type CheckSource,
  type DraftEvent,
  type EventDataOf,
  type Target,
  targetKey,
} from "./events.ts";
import { defineMachine, type Machine } from "./machine.ts";

/**
 * Checks: what a merged pull request still leaves for a person, as a kind (docs/model.md,
 * "Checks"). A check is requested, then a person passes or fails it. Its facts are events of
 * draft's own log (`check.requested`, `check.passed`, `check.failed`, `check.reminded`), so a later
 * step can publish them, and no reader keeps a state of its own: the fold of the log is the state.
 *
 * The kind reads `source`, not a pull request: the factory's done-when and review passes will ask
 * for checks too.
 */

/** How long a check waits on a person before it is raised again, and again after each reminder. */
export const CHECK_REMINDER_MS = 24 * 60 * 60 * 1000;

export type CheckState = "requested" | "passed" | "failed";

let machine: Machine<CheckState> | null = null;

/**
 * The lifecycle of a check. Only a person passes or fails it. A failure is the end of the person's
 * part, not of the problem: the map shows it as waiting on whoever fixes it. The wait on the
 * person has a timeout, which escalates and never closes anything: a reminder.
 */
export function checkLifecycle(): Machine<CheckState> {
  machine ??= defineMachine<CheckState>({
    name: "check",
    version: 1,
    initial: "requested",
    states: {
      requested: { wait: { on: "user", timeoutMs: CHECK_REMINDER_MS } },
      passed: { terminal: true },
      failed: { terminal: true },
    },
    transitions: [
      { from: "requested", to: "passed", trigger: "pass", actors: ["user"], personOnly: true },
      {
        from: "requested",
        to: "failed",
        trigger: "fail",
        actors: ["user"],
        personOnly: true,
        reason: true,
      },
      { from: "requested", to: "requested", trigger: "remind", actors: ["system"] },
    ],
  });
  return machine;
}

export type CheckRequested = EventDataOf<"check.requested">;

/** One check, folded from the log. */
export interface CheckFold {
  key: string;
  /** The conversation it is in: the one that holds its source's stub. */
  conversation: string;
  /** The address of the `check.requested` event. */
  address: string;
  /** Where in the log it was requested. */
  seq: number;
  requested: CheckRequested;
  requestedAt: string;
  state: CheckState;
  /** The person's answer, once there is one. */
  answer: { outcome: "passed" | "failed"; at: string; by: string; note: string | null } | null;
  reminders: number;
  /** When it last asked for the person: the request, or its latest reminder. */
  raisedAt: string;
  /** Every state it was in, oldest first, for the map. */
  path: { state: CheckState; at: string; seq: number }[];
}

type Ev = { event: DraftEvent; seq: number };

/**
 * The checks of a log, oldest first. The first request of a key is the one that counts, so asking
 * twice for the same item changes nothing. A pass or a failure counts only from a person, and only
 * while the check is requested; a reminder only while it is, and only from draft itself.
 */
export function foldChecks(events: readonly Ev[]): CheckFold[] {
  const m = checkLifecycle();
  const checks = new Map<string, CheckFold>();
  for (const { event: d, seq } of events) {
    switch (d.type) {
      case "check.requested": {
        if (checks.has(d.data.key)) break;
        checks.set(d.data.key, {
          key: d.data.key,
          conversation: d.conversation as string,
          address: d.address,
          seq,
          requested: d.data,
          requestedAt: d.at,
          state: m.initial,
          answer: null,
          reminders: 0,
          raisedAt: d.at,
          path: [{ state: m.initial, at: d.at, seq }],
        });
        break;
      }
      case "check.passed":
      case "check.failed": {
        const c = checks.get(d.data.key);
        if (c === undefined) break;
        const outcome = d.type === "check.passed" ? "passed" : "failed";
        const note = d.data.note;
        const step = m.next(
          c.state,
          d.type === "check.passed" ? "pass" : "fail",
          d.actor.kind,
          note,
        );
        // What the machine doesn't allow (an agent's answer, a second answer) moves nothing.
        if (!step.ok) break;
        c.state = step.to;
        c.answer = {
          outcome,
          at: d.at,
          by: d.actor.kind === "user" ? d.actor.name : d.actor.id,
          note: note === null || note.trim() === "" ? null : note,
        };
        c.path.push({ state: step.to, at: d.at, seq });
        break;
      }
      case "check.reminded": {
        const c = checks.get(d.data.key);
        if (c === undefined) break;
        if (!m.next(c.state, "remind", d.actor.kind).ok) break;
        c.reminders++;
        c.raisedAt = d.at;
        break;
      }
    }
  }
  return [...checks.values()];
}

/** The checks that have waited a reminder's interval since they last asked, as of `now`. */
export function dueReminders(checks: readonly CheckFold[], now: number): CheckFold[] {
  return checks.filter(
    (c) => c.state === "requested" && now - Date.parse(c.raisedAt) >= CHECK_REMINDER_MS,
  );
}

/** What a request of one check says, before it is in the log. */
export type CheckRequest = Omit<CheckRequested, "gates"> & { candidates: string[] };

export function checkKey(source: CheckSource, index: number): string {
  return `check:${targetKey(source.target)}:${source.sha}:${index}`;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The checks a pull request's state asks for when it has merged: one for each item of its After
 * deploy section. A state that is not merged, or has no body, asks for none. A pure function of
 * the state, so the same pull request always asks for the same keys.
 */
export function requestsOfMerge(target: Target, state: Record<string, unknown>): CheckRequest[] {
  if (state.state !== "merged") return [];
  const body = text(state.body);
  const sha = text(state.headSha);
  const repo = text(state.repo);
  if (body === null || sha === null || repo === null || typeof state.number !== "number") return [];
  const source: CheckSource = {
    type: "merged-pull-request",
    target,
    ref: `${repo}#${state.number}`,
    sha,
    title: text(state.title),
    url: text(state.url),
  };
  return parseAfterDeploy(body).map((item: AfterDeployItem) => ({
    key: checkKey(source, item.index),
    source,
    index: item.index,
    title: item.title,
    reason: item.reason,
    steps: item.steps,
    tail: item.tail,
    raw: item.raw,
    parsed: item.parsed,
    candidates: item.adrCandidates,
  }));
}

/** A check as a window shows it. */
export interface UiCheck {
  key: string;
  state: CheckState;
  title: string;
  reason: string;
  steps: CheckRequested["steps"];
  tail: string | null;
  raw: string;
  parsed: boolean;
  source: CheckSource;
  /** The proposed decisions it is about: passing it offers their acceptance. */
  gates: { target: Target; title: string | null }[];
  requestedAt: string;
  raisedAt: string;
  reminders: number;
  answer: CheckFold["answer"];
}
