import type { Actor } from "./events.ts";

/**
 * A small declarative state machine: states, transitions with the actors allowed to fire each,
 * waits and terminal states, plus a checker for open ends. The thread lifecycle and the interrupt
 * lifecycle are built on it, and kinds will be (docs/model.md, "Kinds are state machines").
 *
 * The model proposes; the machine disposes: nothing moves until `next` has checked the trigger
 * and the actor. A machine is plain data, so a spec can be stored, diffed and checked before it
 * is accepted.
 */

export type ActorKind = Actor["kind"];

/** A state is active, waiting on someone, or terminal. */
export interface StateSpec {
  /** No transition leaves a terminal state. */
  terminal?: boolean;
  /**
   * The state waits on someone. A wait names whom it waits on and a timeout; a timeout never
   * closes anything silently, it escalates. `timeoutMs: null` is allowed only with the reason it
   * has none.
   */
  wait?: {
    on: ActorKind;
    timeoutMs: number | null;
    noTimeoutBecause?: string;
  };
}

/**
 * How an effect is undone (docs/model.md, "Revert"): by putting things back, by a named step that
 * compensates, or not at all, with the reason. Nothing executes an inverse yet; it is declared so
 * a revert can be planned from the log.
 */
export type Inverse =
  | { kind: "reversible"; step: string }
  | { kind: "compensable"; step: string }
  | { kind: "irreversible"; reason: string };

/** What a transition does outside the machine: the steps it runs, and how to undo them. */
export interface Effect {
  /** The durable steps it runs, by name. */
  steps: readonly string[];
  inverse: Inverse;
}

export interface TransitionSpec<S extends string> {
  from: S | readonly S[];
  to: S;
  /** What fires it: an event name, or a person's action. */
  trigger: string;
  /** Who may fire it. `["user"]` is person-only. */
  actors: readonly ActorKind[];
  /** The firing must carry a reason: the standard ends need one. */
  reason?: boolean;
  /**
   * Marks a transition that needs a person (an acceptance, a rejection). The checker refuses a
   * machine that marked one and lets anyone but a person fire it, and proves the agent can fire
   * none of them.
   */
  personOnly?: boolean;
  /** What the transition changes outside the machine. Every effect declares its inverse. */
  effect?: Effect;
}

export interface MachineSpec<S extends string> {
  name: string;
  version: number;
  initial: S;
  states: Record<S, StateSpec>;
  transitions: readonly TransitionSpec<S>[];
}

export type ProblemCode =
  | "no-terminal"
  | "unknown-state"
  | "unreachable"
  | "open-end"
  | "terminal-exit"
  | "wait-without-owner"
  | "wait-without-timeout"
  | "no-actor"
  | "duplicate-transition"
  | "person-only-actor"
  | "no-inverse";

export interface Problem {
  code: ProblemCode;
  state: string | null;
  message: string;
}

const froms = <S extends string>(t: TransitionSpec<S>): readonly S[] =>
  typeof t.from === "string" ? [t.from as S] : (t.from as readonly S[]);

/**
 * Checks a machine for what the model asks of every kind: every state is reachable from the
 * initial one, and every state can reach a terminal state (no open ends); every wait has an owner
 * and a timeout; every transition names who may fire it. Returns every problem found.
 */
export function checkMachine<S extends string>(spec: MachineSpec<S>): Problem[] {
  const problems: Problem[] = [];
  const states = Object.keys(spec.states) as S[];
  const known = new Set<string>(states);
  const add = (code: ProblemCode, state: string | null, message: string) =>
    problems.push({ code, state, message });

  if (!known.has(spec.initial))
    add("unknown-state", spec.initial, `the initial state ${spec.initial} is not declared`);
  const terminals = states.filter((s) => spec.states[s].terminal === true);
  if (terminals.length === 0) add("no-terminal", null, "the machine has no terminal state");

  const seen = new Set<string>();
  for (const t of spec.transitions) {
    for (const f of froms(t)) {
      if (!known.has(f)) add("unknown-state", f, `${t.trigger} leaves ${f}, which is not declared`);
      if (spec.states[f]?.terminal === true)
        add("terminal-exit", f, `${t.trigger} leaves the terminal state ${f}`);
      const key = `${f}\u0000${t.trigger}`;
      if (seen.has(key)) add("duplicate-transition", f, `${f} has two transitions on ${t.trigger}`);
      seen.add(key);
    }
    if (!known.has(t.to))
      add("unknown-state", t.to, `${t.trigger} enters ${t.to}, which is not declared`);
    if (t.actors.length === 0) add("no-actor", null, `${t.trigger} names no actor who may fire it`);
    if (t.personOnly === true && t.actors.some((a) => a !== "user"))
      add(
        "person-only-actor",
        null,
        `${t.trigger} is marked person-only but ${t.actors.filter((a) => a !== "user").join(" and ")} may fire it`,
      );
    if (t.effect !== undefined) {
      const i = t.effect.inverse as Partial<Record<string, unknown>> | undefined;
      const named = (k: string) => typeof i?.[k] === "string" && (i[k] as string).trim() !== "";
      if (i === undefined)
        add("no-inverse", null, `${t.trigger} has an effect and declares no inverse`);
      else if (i.kind === "irreversible" ? !named("reason") : !named("step"))
        add(
          "no-inverse",
          null,
          i.kind === "irreversible"
            ? `${t.trigger} is irreversible and gives no reason`
            : `${t.trigger} declares its inverse ${String(i.kind)} and names no step`,
        );
      else if (i.kind !== "irreversible" && i.kind !== "reversible" && i.kind !== "compensable")
        add(
          "no-inverse",
          null,
          `${t.trigger} declares an inverse of unknown kind ${String(i.kind)}`,
        );
    }
  }

  for (const s of states) {
    const w = spec.states[s].wait;
    if (w === undefined) continue;
    if (!w.on) add("wait-without-owner", s, `${s} waits on no one`);
    if (w.timeoutMs === undefined || (w.timeoutMs === null && !w.noTimeoutBecause))
      add("wait-without-timeout", s, `${s} waits without a timeout or the reason it has none`);
  }

  // Every state is reachable from the initial one.
  const reached = new Set<string>([spec.initial]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of spec.transitions)
      if (froms(t).some((f) => reached.has(f)) && !reached.has(t.to)) {
        reached.add(t.to);
        grew = true;
      }
  }
  for (const s of states)
    if (!reached.has(s)) add("unreachable", s, `${s} cannot be reached from ${spec.initial}`);

  // Every state can reach a terminal state.
  const canEnd = new Set<string>(terminals);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of spec.transitions)
      if (canEnd.has(t.to))
        for (const f of froms(t))
          if (!canEnd.has(f)) {
            canEnd.add(f);
            grew = true;
          }
  }
  for (const s of states)
    if (!canEnd.has(s)) add("open-end", s, `${s} cannot reach a terminal state: an open end`);

  return problems;
}

export class MachineRefusedError extends Error {
  constructor(
    readonly machine: string,
    readonly problems: readonly Problem[],
  ) {
    super(
      `the machine ${machine} is refused: ${problems.map((p) => `${p.code}: ${p.message}`).join("; ")}`,
    );
    this.name = "MachineRefusedError";
  }
}

export type Step<S extends string> =
  | { ok: true; from: S; to: S; trigger: string }
  | {
      ok: false;
      reason: "no-transition" | "actor-not-allowed" | "reason-required";
      message: string;
    };

/** One event fed to a machine when a log is replayed through it. */
export interface Firing {
  trigger: string;
  actor: ActorKind;
  reason?: string | null;
}

export interface Replay<S extends string> {
  state: S;
  /** Firings the machine did not allow, by their position: each is a broken invariant. */
  rejected: { index: number; message: string }[];
}

export class Machine<S extends string> {
  constructor(readonly spec: MachineSpec<S>) {}

  get name(): string {
    return this.spec.name;
  }

  get initial(): S {
    return this.spec.initial;
  }

  isTerminal(state: S): boolean {
    return this.spec.states[state].terminal === true;
  }

  /** What `actor` may fire from `state`. */
  triggers(state: S, actor?: ActorKind): string[] {
    return this.spec.transitions
      .filter((t) => froms(t).includes(state) && (actor === undefined || t.actors.includes(actor)))
      .map((t) => t.trigger);
  }

  /** Whether the only actor allowed to fire `trigger` from `state` is a person. */
  personOnly(state: S, trigger: string): boolean {
    const t = this.find(state, trigger);
    return t !== undefined && t.actors.length === 1 && t.actors[0] === "user";
  }

  /**
   * Every trigger that someone other than a person may fire, from any state. A trigger marked
   * person-only is never among them: that is what the checker proves about the agent.
   */
  triggersFirableBy(actor: ActorKind): string[] {
    return [
      ...new Set(
        this.spec.transitions.filter((t) => t.actors.includes(actor)).map((t) => t.trigger),
      ),
    ];
  }

  /** The triggers marked person-only. */
  personOnlyTriggers(): string[] {
    return [
      ...new Set(this.spec.transitions.filter((t) => t.personOnly === true).map((t) => t.trigger)),
    ];
  }

  /** What `trigger` does outside the machine, with its declared inverse, or null when nothing. */
  effectOf(trigger: string): Effect | null {
    return (
      this.spec.transitions.find((t) => t.trigger === trigger && t.effect !== undefined)?.effect ??
      null
    );
  }

  private find(state: S, trigger: string): TransitionSpec<S> | undefined {
    return this.spec.transitions.find((t) => t.trigger === trigger && froms(t).includes(state));
  }

  /** Fires `trigger` from `state` as `actor`, or says why it can't. */
  next(state: S, trigger: string, actor: ActorKind, reason?: string | null): Step<S> {
    const t = this.find(state, trigger);
    if (t === undefined)
      return {
        ok: false,
        reason: "no-transition",
        message: `${this.name}: ${trigger} is not allowed from ${state}`,
      };
    if (!t.actors.includes(actor))
      return {
        ok: false,
        reason: "actor-not-allowed",
        message: `${this.name}: ${trigger} is for ${t.actors.join(" or ")}, not ${actor}`,
      };
    if (t.reason === true && (reason === undefined || reason === null || reason.trim() === ""))
      return {
        ok: false,
        reason: "reason-required",
        message: `${this.name}: ${trigger} needs a reason`,
      };
    return { ok: true, from: state, to: t.to, trigger };
  }

  /**
   * Replays a log's firings through the machine: the conformance test. A firing the machine does
   * not allow leaves the state where it was and is reported.
   */
  replay(firings: readonly Firing[]): Replay<S> {
    let state = this.initial;
    const rejected: Replay<S>["rejected"] = [];
    firings.forEach((f, index) => {
      const step = this.next(state, f.trigger, f.actor, f.reason);
      if (step.ok) state = step.to;
      else rejected.push({ index, message: step.message });
    });
    return { state, rejected };
  }
}

/** Builds a machine, or refuses a spec that has an open end or any other problem. */
export function defineMachine<S extends string>(spec: MachineSpec<S>): Machine<S> {
  const problems = checkMachine(spec);
  if (problems.length > 0) throw new MachineRefusedError(spec.name, problems);
  return new Machine(spec);
}

export const STANDARD_ENDS = ["dismissed", "superseded", "withdrawn"] as const;
export type StandardEnd = (typeof STANDARD_ENDS)[number];

/**
 * Adds the standard terminal states, each reachable from every state that isn't terminal and each
 * needing a person and a reason: anything can end honestly, without a false "done".
 */
export function withStandardEnds<S extends string, E extends StandardEnd>(
  spec: MachineSpec<S>,
  ends: readonly E[],
): MachineSpec<S | E> {
  const live = (Object.keys(spec.states) as S[]).filter((s) => spec.states[s].terminal !== true);
  const states = { ...spec.states } as Record<S | E, StateSpec>;
  for (const e of ends) states[e] = { terminal: true };
  return {
    ...spec,
    states,
    transitions: [
      ...spec.transitions,
      ...ends.map(
        (e): TransitionSpec<S | E> => ({
          from: live,
          to: e,
          trigger: e,
          actors: ["user"],
          reason: true,
        }),
      ),
    ],
  } as MachineSpec<S | E>;
}

/**
 * Proves that only a person fires `triggers`. Each must exist, be marked person-only, and be
 * refused for every other actor kind from every state that has it: the machine itself says no, so
 * the proof holds however the caller got there. Returns what failed; nothing means proved.
 */
export function proveOnlyPersonFires<S extends string>(
  machine: Machine<S>,
  triggers: readonly string[],
): string[] {
  const failures: string[] = [];
  const others: ActorKind[] = ["agent", "resolver", "system"];
  const states = Object.keys(machine.spec.states) as S[];
  for (const trigger of triggers) {
    const there = states.filter((s) => machine.triggers(s).includes(trigger));
    if (there.length === 0) {
      failures.push(`${machine.name}: no state has ${trigger}`);
      continue;
    }
    if (!machine.personOnlyTriggers().includes(trigger))
      failures.push(`${machine.name}: ${trigger} is not marked person-only`);
    for (const s of there)
      for (const actor of others) {
        const r = machine.next(s, trigger, actor, "proof");
        if (r.ok || r.reason !== "actor-not-allowed")
          failures.push(`${machine.name}: ${actor} may fire ${trigger} from ${s}`);
      }
  }
  return failures;
}
