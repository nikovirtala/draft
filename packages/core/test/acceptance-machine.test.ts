import { describe, expect, it } from "vitest";
import { acceptanceMachine, acceptanceSpec, PERSON_ONLY_TRIGGERS } from "../src/acceptance.ts";
import { adrAcceptance } from "../src/adr.ts";
import { INTERRUPT_KINDS, type InterruptKind, interruptMachine } from "../src/interrupts.ts";
import { checkMachine, proveOnlyPersonFires } from "../src/machine.ts";
import { pullRequestAcceptance } from "../src/pull-request.ts";

describe("the acceptance machine", () => {
  const kinds = [adrAcceptance, pullRequestAcceptance];

  it.each(kinds.map((k) => [k.name, k] as const))(
    "%s: has no open ends and every effect has an inverse",
    (_n, kind) => {
      expect(checkMachine(acceptanceSpec(kind))).toEqual([]);
      const m = acceptanceMachine(kind);
      expect(m.effectOf("accept")?.inverse).toEqual(kind.accept.effect.inverse);
      expect(m.effectOf("reject")?.inverse).toEqual(kind.reject.effect.inverse);
      expect(m.effectOf("request-changes")).toBeNull();
    },
  );

  it.each(kinds.map((k) => [k.name, k] as const))(
    "%s: only a person accepts, rejects or requests changes, from every state",
    (_n, kind) => {
      const m = acceptanceMachine(kind);
      expect(proveOnlyPersonFires(m, PERSON_ONLY_TRIGGERS)).toEqual([]);
      expect(m.triggersFirableBy("agent")).toEqual([]);
      // What the resolver fires is evidence turning green or red, never an answer.
      expect(m.triggersFirableBy("resolver").sort()).toEqual([
        "evidence-green",
        "evidence-red",
        "new-evidence",
      ]);
      for (const t of PERSON_ONLY_TRIGGERS) expect(m.personOnlyTriggers()).toContain(t);
    },
  );

  it("runs the path: green, request, changes requested, new evidence, green, accepted", () => {
    const m = acceptanceMachine(adrAcceptance);
    const r = m.replay([
      { trigger: "evidence-green", actor: "resolver" },
      { trigger: "request-changes", actor: "user", reason: "name the alternatives" },
      { trigger: "new-evidence", actor: "resolver" },
      { trigger: "evidence-green", actor: "resolver" },
      { trigger: "accept", actor: "user" },
    ]);
    expect(r).toEqual({ state: "accepted", rejected: [] });
  });

  it("refuses an answer by anyone else, an answer without its reason, and an answer before green", () => {
    const m = acceptanceMachine(adrAcceptance);
    const r = m.replay([
      { trigger: "accept", actor: "user" },
      { trigger: "evidence-green", actor: "resolver" },
      { trigger: "accept", actor: "agent" },
      { trigger: "reject", actor: "user" },
      { trigger: "request-changes", actor: "user", reason: "  " },
      { trigger: "evidence-red", actor: "resolver" },
      { trigger: "accept", actor: "user" },
    ]);
    expect(r.state).toBe("waiting");
    expect(r.rejected.map((x) => x.index)).toEqual([0, 2, 3, 4, 6]);
    expect(r.rejected.map((x) => x.message).join("\n")).toMatch(/is for user, not agent/);
    expect(r.rejected.map((x) => x.message).join("\n")).toMatch(/reject needs a reason/);
  });

  it("has an acceptance interrupt whose three answers are person-only", () => {
    const kind = "acceptance" as InterruptKind;
    expect(INTERRUPT_KINDS[kind].outcomes).toEqual(["accepted", "changes-requested", "rejected"]);
    const m = interruptMachine(kind);
    expect(
      proveOnlyPersonFires(
        m,
        INTERRUPT_KINDS[kind].outcomes.map((o) => `settle:${o}`),
      ),
    ).toEqual([]);
  });
});
