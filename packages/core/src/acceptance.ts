import { z } from "zod";
import type { Target } from "./events.ts";
import type { InterruptCandidate } from "./interrupts.ts";
import {
  defineMachine,
  type Effect,
  type Inverse,
  type Machine,
  type MachineSpec,
  withStandardEnds,
} from "./machine.ts";

/**
 * Acceptance: every human gate is one pattern. Something waits for a person's yes, with evidence
 * attached (docs/model.md, "Acceptance"). A *kind* of record (an ADR, a pull request, later a
 * decision, task or design candidate) says what it takes to be ready, what each answer does outside
 * draft and how to undo it; this module turns that into one interrupt, one state machine and one
 * record of what happened. The UI draws whatever evidence a request carries, so a new kind needs no
 * UI work.
 *
 * - The request is raised only while every item of its evidence is green, and withdrawn when one
 *   goes red (the resolver's `interrupts` is a pure function of the target's state, so both follow).
 * - Its key names the commit it was judged on: a new push is a new request, and an answered one
 *   stays answered.
 * - Accepting, rejecting and requesting changes are person-only transitions. The checker proves the
 *   agent can fire none of them.
 * - Each answer's effect declares its inverse, recorded with the step that carried it out. Nothing
 *   executes an inverse yet.
 */

export const EvidenceStatusSchema = z.enum(["green", "red", "pending"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

/** One thing a person would want to know before saying yes, and what it says right now. */
export const EvidenceItemSchema = z.object({
  /** Stable name of the check: "checks", "verify", "mergeable". */
  id: z.string().min(1),
  label: z.string().min(1),
  status: EvidenceStatusSchema,
  /** What it says, in a few words. */
  detail: z.string().nullable(),
  url: z.string().nullable(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const InverseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reversible"), step: z.string().min(1) }),
  z.object({ kind: z.literal("compensable"), step: z.string().min(1) }),
  z.object({ kind: z.literal("irreversible"), reason: z.string().min(1) }),
]);

/** What an answer did, as the step that carried it out records it. */
export const AcceptanceEffectSchema = z.object({
  /** "adr.accept", "pull-request.merge", ... */
  kind: z.string().min(1),
  target: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  /** The commit the answer made (the accept commit) or the merge produced; null when none. */
  sha: z.string().nullable(),
  /** The evidence as it was when the person answered. */
  evidence: z.array(EvidenceItemSchema),
  /** How to undo it. Nothing executes it yet. */
  inverse: InverseSchema,
});
export type AcceptanceEffect = z.infer<typeof AcceptanceEffectSchema>;

/** An answer's effect outside draft, declared by the kind. */
export interface AnswerDeclaration {
  /** What the button says. */
  label: string;
  /** A short name for the effect: "adr.accept". */
  effectKind: string;
  effect: Effect;
}

/** What a kind finds waiting in a target's state. */
export interface AcceptanceSubject {
  /** The request's identity: the target and the commit its evidence was judged on. */
  key: string;
  title: string;
  /** One line for the list. */
  summary: string;
  /** The commit it was judged on. */
  sha: string;
  url: string | null;
  evidence: EvidenceItem[];
  /** What accepting and rejecting will do, in words, for this subject. */
  accepts: string;
  rejects: string;
  /** Where the record is (repository, branch, pull request), for whoever carries the answer out. */
  where: Record<string, unknown>;
}

/**
 * A kind of record that can wait for acceptance. The evidence is declared here, by the kind, and
 * not by the UI.
 */
export interface AcceptanceKind {
  /** "adr", "pull-request". */
  readonly name: string;
  /** The resolver type of its targets. */
  readonly resolver: string;
  readonly accept: AnswerDeclaration;
  readonly reject: AnswerDeclaration;
  /** What is waiting in this state, with its evidence, or null when nothing is. */
  subject(target: Target, state: Record<string, unknown>): AcceptanceSubject | null;
}

export const evidenceGreen = (evidence: readonly EvidenceItem[]): boolean =>
  evidence.length > 0 && evidence.every((e) => e.status === "green");

/** What a person's answer is called as an interrupt outcome, and as a trigger of the machine. */
export const ANSWERS = {
  accepted: "accept",
  "changes-requested": "request-changes",
  rejected: "reject",
} as const;
export type AcceptanceOutcome = keyof typeof ANSWERS;
export const ACCEPTANCE_OUTCOMES = Object.keys(ANSWERS) as AcceptanceOutcome[];

/** The triggers a person fires; the agent fires none of them. */
export const PERSON_ONLY_TRIGGERS: readonly string[] = Object.values(ANSWERS);

export type AcceptanceState =
  | "waiting"
  | "requested"
  | "changes-requested"
  | "accepted"
  | "rejected"
  | "superseded"
  | "withdrawn"
  | "dismissed";

/**
 * The lifecycle of one acceptance request, per kind of record. `waiting` is the evidence not being
 * green (nothing is shown); `requested` is the request on screen; changes requested waits for new
 * evidence and goes back to `waiting`. Accept and reject carry the kind's declared effects and
 * inverses, and every answer is person only.
 */
export function acceptanceSpec(kind: AcceptanceKind): MachineSpec<AcceptanceState> {
  const base: MachineSpec<"waiting" | "requested" | "changes-requested" | "accepted" | "rejected"> =
    {
      name: `acceptance:${kind.name}`,
      version: 1,
      initial: "waiting",
      states: {
        waiting: {
          wait: {
            on: "resolver",
            timeoutMs: null,
            noTimeoutBecause: "the request appears when the evidence turns green",
          },
        },
        requested: {
          wait: {
            on: "user",
            timeoutMs: null,
            noTimeoutBecause: "its age is read by feedback and the map, which escalate it",
          },
        },
        "changes-requested": {
          wait: {
            on: "resolver",
            timeoutMs: null,
            noTimeoutBecause: "it waits for a new push, which is new evidence",
          },
        },
        accepted: { terminal: true },
        rejected: { terminal: true },
      },
      transitions: [
        { from: "waiting", to: "requested", trigger: "evidence-green", actors: ["resolver"] },
        { from: "requested", to: "waiting", trigger: "evidence-red", actors: ["resolver"] },
        {
          from: "requested",
          to: "accepted",
          trigger: ANSWERS.accepted,
          actors: ["user"],
          personOnly: true,
          effect: kind.accept.effect,
        },
        {
          from: "requested",
          to: "rejected",
          trigger: ANSWERS.rejected,
          actors: ["user"],
          personOnly: true,
          reason: true,
          effect: kind.reject.effect,
        },
        {
          from: "requested",
          to: "changes-requested",
          trigger: ANSWERS["changes-requested"],
          actors: ["user"],
          personOnly: true,
          reason: true,
        },
        { from: "changes-requested", to: "waiting", trigger: "new-evidence", actors: ["resolver"] },
      ],
    };
  return withStandardEnds(base, ["superseded", "withdrawn", "dismissed"]);
}

const machines = new Map<string, Machine<AcceptanceState>>();

/** The state machine of one kind of record's acceptance, checked when first built. */
export function acceptanceMachine(kind: AcceptanceKind): Machine<AcceptanceState> {
  let m = machines.get(kind.name);
  if (m === undefined) {
    m = defineMachine(acceptanceSpec(kind));
    machines.set(kind.name, m);
  }
  return m;
}

/**
 * The request a kind raises for a target in this state: one interrupt, only while every item of
 * its evidence is green. The same state always gives the same answer.
 */
export function acceptanceCandidates(
  kind: AcceptanceKind,
  target: Target,
  state: Record<string, unknown>,
): InterruptCandidate[] {
  const subject = kind.subject(target, state);
  if (subject === null || !evidenceGreen(subject.evidence)) return [];
  return [
    {
      key: subject.key,
      kind: "acceptance",
      summary: subject.summary,
      detail: {
        acceptance: kind.name,
        target,
        title: subject.title,
        sha: subject.sha,
        url: subject.url,
        evidence: subject.evidence,
        accepts: subject.accepts,
        rejects: subject.rejects,
        where: subject.where,
        answers: {
          accepted: describe(kind.accept),
          rejected: describe(kind.reject),
        },
      },
    },
  ];
}

function describe(a: AnswerDeclaration): { label: string; effect: string; inverse: Inverse } {
  return { label: a.label, effect: a.effectKind, inverse: a.effect.inverse };
}

/** Why a request that was shown is withdrawn, from the target's state now. */
export function withdrawnBecause(
  kind: AcceptanceKind,
  target: Target,
  state: Record<string, unknown>,
): string {
  const subject = kind.subject(target, state);
  if (subject === null)
    return "there is nothing left to accept: it was closed, accepted or changed";
  const bad = subject.evidence.filter((e) => e.status !== "green");
  if (bad.length === 0)
    return "the evidence is the same, but it is no longer the commit that was judged";
  return `the evidence is no longer green: ${bad.map((e) => `${e.label} is ${e.status}`).join("; ")}`;
}

/** The registered kinds, by name. Every kind of record that can wait for acceptance is here. */
const kinds = new Map<string, AcceptanceKind>();

export function registerAcceptanceKind(kind: AcceptanceKind): void {
  kinds.set(kind.name, kind);
  // Building the machine checks it now, not when the first request arrives.
  acceptanceMachine(kind);
}

export function acceptanceKind(name: string): AcceptanceKind | null {
  return kinds.get(name) ?? null;
}

export function acceptanceKinds(): AcceptanceKind[] {
  return [...kinds.values()];
}

/** What carrying an answer out produced. */
export interface CarriedOut {
  /** The commit it made or the merge it produced; null when it made none (closing a pull request). */
  sha: string | null;
  summary: string;
}

/**
 * How one kind of record's answers are carried out, as the person. The desktop app gives the
 * conversation one of these per kind; the conversation calls it only when a person answers.
 */
export interface KindActions {
  accept(where: Record<string, unknown>): Promise<CarriedOut>;
  reject(where: Record<string, unknown>, reason: string): Promise<CarriedOut>;
}

export type AcceptanceActions = Readonly<Record<string, KindActions>>;
