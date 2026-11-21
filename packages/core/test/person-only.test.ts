import { describe, expect, it } from "vitest";
import {
  checkMachine,
  defineMachine,
  type MachineSpec,
  proveOnlyPersonFires,
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

describe("person-only transitions", () => {
  const ask: MachineSpec<S> = {
    ...good,
    name: "person",
    transitions: [
      { from: "a", to: "b", trigger: "ask", actors: ["agent"] },
      { from: "b", to: "c", trigger: "accept", actors: ["user"], personOnly: true },
      { from: "b", to: "a", trigger: "reject", actors: ["user"], personOnly: true },
    ],
  };

  it("refuses a transition marked person-only that someone else may fire", () => {
    const bad: MachineSpec<S> = {
      ...ask,
      transitions: [
        ...ask.transitions.slice(0, 1),
        { from: "b", to: "c", trigger: "accept", actors: ["user", "agent"], personOnly: true },
        { from: "b", to: "a", trigger: "reject", actors: ["user"], personOnly: true },
      ],
    };
    expect(checkMachine(bad).map((p) => p.code)).toEqual(["person-only-actor"]);
    expect(() => defineMachine(bad)).toThrow(/marked person-only but agent may fire it/);
  });

  it("proves that no other actor can fire a person-only trigger from any state", () => {
    const m = defineMachine(ask);
    expect(proveOnlyPersonFires(m, ["accept", "reject"])).toEqual([]);
    // A trigger the agent may fire, or one that isn't marked, fails the proof.
    expect(proveOnlyPersonFires(m, ["ask"]).join("\n")).toMatch(/ask is not marked person-only/);
    expect(proveOnlyPersonFires(m, ["ask"]).join("\n")).toMatch(/agent may fire ask from a/);
    expect(proveOnlyPersonFires(m, ["nope"])).toEqual(["person: no state has nope"]);
  });
});

describe("every effect declares its inverse", () => {
  const effect = (inverse: unknown): MachineSpec<S> => ({
    ...good,
    name: "effects",
    transitions: [
      { from: "a", to: "b", trigger: "ask", actors: ["agent"] },
      {
        from: "b",
        to: "c",
        trigger: "accept",
        actors: ["user"],
        personOnly: true,
        effect: { steps: ["merge"], inverse } as never,
      },
      { from: "b", to: "a", trigger: "reject", actors: ["user"] },
    ],
  });

  it("accepts reversible, compensable (with a named step) and irreversible (with a reason)", () => {
    for (const inverse of [
      { kind: "reversible", step: "reopen" },
      { kind: "compensable", step: "revert" },
      { kind: "irreversible", reason: "a message was sent" },
    ])
      expect(checkMachine(effect(inverse))).toEqual([]);
  });

  it("refuses an effect with no inverse, an unnamed step, or an irreversible one with no reason", () => {
    for (const inverse of [
      undefined,
      { kind: "compensable" },
      { kind: "reversible", step: " " },
      { kind: "irreversible" },
      { kind: "whenever", step: "x" },
    ])
      expect(
        checkMachine(effect(inverse)).map((p) => p.code),
        JSON.stringify(inverse),
      ).toEqual(["no-inverse"]);
  });
});
