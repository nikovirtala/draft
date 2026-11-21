import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkMachine,
  defineMachine,
  MachineRefusedError,
  type MachineSpec,
  STANDARD_ENDS,
  withStandardEnds,
} from "../src/machine.ts";

type S = "a" | "b" | "c";

const good: MachineSpec<S> = {
  name: "good",
  version: 1,
  initial: "a",
  states: {
    a: {},
    b: { wait: { on: "user", timeoutMs: 1000 } },
    c: { terminal: true },
  },
  transitions: [
    { from: "a", to: "b", trigger: "ask", actors: ["agent"] },
    { from: "b", to: "c", trigger: "accept", actors: ["user"] },
    { from: "b", to: "a", trigger: "reject", actors: ["user"] },
  ],
};

describe("the state machine checker", () => {
  it("accepts a machine with no open ends", () => {
    expect(checkMachine(good)).toEqual([]);
    expect(defineMachine(good).initial).toBe("a");
  });

  it("refuses a machine with an open end", () => {
    // a and b only lead to each other; the terminal state c is out of reach of both.
    const stuck: MachineSpec<S> = {
      ...good,
      name: "open-end",
      transitions: [
        { from: "a", to: "b", trigger: "ask", actors: ["agent"] },
        { from: "b", to: "a", trigger: "reject", actors: ["user"] },
      ],
    };
    const problems = checkMachine(stuck);
    expect(problems.map((p) => [p.code, p.state])).toEqual(
      expect.arrayContaining([
        ["open-end", "a"],
        ["open-end", "b"],
        ["unreachable", "c"],
      ]),
    );
    expect(() => defineMachine(stuck)).toThrow(MachineRefusedError);
    expect(() => defineMachine(stuck)).toThrow(/open end/);
  });

  it("refuses a machine that has no terminal state", () => {
    const m: MachineSpec<S> = {
      ...good,
      states: { a: {}, b: {}, c: {} },
      transitions: [
        { from: "a", to: "b", trigger: "x", actors: ["user"] },
        { from: "b", to: "c", trigger: "y", actors: ["user"] },
        { from: "c", to: "a", trigger: "z", actors: ["user"] },
      ],
    };
    expect(checkMachine(m).map((p) => p.code)).toContain("no-terminal");
  });

  it("refuses a state that cannot be reached", () => {
    const m: MachineSpec<S> = {
      ...good,
      transitions: good.transitions.filter((t) => t.trigger !== "ask"),
    };
    expect(checkMachine(m).map((p) => [p.code, p.state])).toContainEqual(["unreachable", "b"]);
  });

  it("refuses a way out of a terminal state, a duplicate trigger and a transition nobody may fire", () => {
    const m: MachineSpec<S> = {
      ...good,
      transitions: [
        ...good.transitions,
        { from: "c", to: "a", trigger: "reopen", actors: ["user"] },
        { from: "a", to: "b", trigger: "ask", actors: ["user"] },
        { from: "a", to: "c", trigger: "nobody", actors: [] },
      ],
    };
    const codes = checkMachine(m).map((p) => p.code);
    expect(codes).toContain("terminal-exit");
    expect(codes).toContain("duplicate-transition");
    expect(codes).toContain("no-actor");
  });

  it("refuses a wait without an owner, and one without a timeout or the reason it has none", () => {
    const noTimeout: MachineSpec<S> = {
      ...good,
      states: { ...good.states, b: { wait: { on: "user", timeoutMs: null } } },
    };
    expect(checkMachine(noTimeout).map((p) => p.code)).toContain("wait-without-timeout");
    const reasoned: MachineSpec<S> = {
      ...good,
      states: {
        ...good.states,
        b: { wait: { on: "user", timeoutMs: null, noTimeoutBecause: "the map escalates it" } },
      },
    };
    expect(checkMachine(reasoned)).toEqual([]);
    const noOwner = {
      ...good,
      states: { ...good.states, b: { wait: { timeoutMs: 5 } } },
    } as unknown as MachineSpec<S>;
    expect(checkMachine(noOwner).map((p) => p.code)).toContain("wait-without-owner");
  });
});

describe("firing a machine", () => {
  const m = defineMachine(good);

  it("moves on an allowed trigger by an allowed actor", () => {
    expect(m.next("a", "ask", "agent")).toMatchObject({ ok: true, to: "b" });
    expect(m.next("b", "accept", "user")).toMatchObject({ ok: true, to: "c" });
  });

  it("refuses the wrong actor, an unknown trigger and a trigger from the wrong state", () => {
    expect(m.next("b", "accept", "agent")).toMatchObject({
      ok: false,
      reason: "actor-not-allowed",
    });
    expect(m.next("a", "accept", "user")).toMatchObject({ ok: false, reason: "no-transition" });
    expect(m.next("c", "ask", "agent")).toMatchObject({ ok: false, reason: "no-transition" });
  });

  it("knows what only a person may do", () => {
    expect(m.personOnly("b", "accept")).toBe(true);
    expect(m.personOnly("a", "ask")).toBe(false);
    expect(m.triggers("b", "user")).toEqual(["accept", "reject"]);
  });

  it("replays a log and reports what it did not allow", () => {
    const r = m.replay([
      { trigger: "ask", actor: "agent" },
      { trigger: "accept", actor: "agent" },
      { trigger: "accept", actor: "user" },
      { trigger: "reject", actor: "user" },
    ]);
    expect(r.state).toBe("c");
    expect(r.rejected.map((x) => x.index)).toEqual([1, 3]);
  });

  it("never leaves a declared state, whatever is fired", () => {
    const triggers = ["ask", "accept", "reject", "nope"];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            trigger: fc.constantFrom(...triggers),
            actor: fc.constantFrom("user", "agent", "resolver", "system" as const),
          }),
        ),
        (firings) => {
          const r = m.replay(firings);
          expect(Object.keys(good.states)).toContain(r.state);
        },
      ),
    );
  });
});

describe("the standard ends", () => {
  const spec = withStandardEnds(good, ["superseded", "withdrawn"]);
  const m = defineMachine(spec);

  it("keep a machine closed: every live state can end honestly", () => {
    expect(checkMachine(spec)).toEqual([]);
    for (const s of ["a", "b"] as const) {
      expect(m.triggers(s, "user")).toEqual(expect.arrayContaining(["superseded", "withdrawn"]));
    }
    expect(m.triggers("c")).toEqual([]);
  });

  it("need a person and a reason", () => {
    expect(m.next("a", "withdrawn", "user")).toMatchObject({
      ok: false,
      reason: "reason-required",
    });
    expect(m.next("a", "withdrawn", "user", "  ")).toMatchObject({ ok: false });
    expect(m.next("a", "withdrawn", "agent", "because")).toMatchObject({
      ok: false,
      reason: "actor-not-allowed",
    });
    expect(m.next("b", "superseded", "user", "replaced by x")).toMatchObject({
      ok: true,
      to: "superseded",
    });
  });

  it("names dismissed, superseded and withdrawn", () => {
    expect(STANDARD_ENDS).toEqual(["dismissed", "superseded", "withdrawn"]);
  });
});
