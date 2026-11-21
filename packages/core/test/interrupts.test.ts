import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AttentionItem,
  ageMs,
  compareAttention,
  INTERRUPT_KINDS,
  type InterruptKind,
  interruptMachine,
  orderAttention,
} from "../src/interrupts.ts";
import { checkMachine } from "../src/machine.ts";
import { foldThread, isEnded, type ThreadEventRow, threadMachine } from "../src/thread.ts";

const item = (id: string, cause: InterruptKind, at: string): AttentionItem => ({
  id,
  conversation: "local/c1",
  cause,
  at,
});

describe("the attention order", () => {
  it("puts blocking permission requests first, then failures, then what is left to resolve, then reviews", () => {
    const items = [
      item("review", "review-requested", "2026-11-20T10:00:00.000Z"),
      item("step", "unfinished-step", "2026-11-20T10:01:00.000Z"),
      item("check", "failed-check", "2026-11-20T10:02:00.000Z"),
      item("perm", "permission", "2026-11-20T10:03:00.000Z"),
      item("conflict", "merge-conflict", "2026-11-20T10:04:00.000Z"),
      item("failed", "failed-step", "2026-11-20T10:05:00.000Z"),
    ];
    expect(orderAttention(items).map((i) => i.id)).toEqual([
      "perm",
      "check",
      "conflict",
      "failed",
      "step",
      "review",
    ]);
  });

  it("puts acceptance requests after failures and before what is left to resolve", () => {
    const items = [
      item("review", "review-requested", "2026-11-20T10:00:00.000Z"),
      item("conclusion", "conclusion", "2026-11-20T10:00:00.000Z"),
      item("step", "unfinished-step", "2026-11-20T09:00:00.000Z"),
      item("accept-new", "acceptance", "2026-11-20T11:00:00.000Z"),
      item("accept-old", "acceptance", "2026-11-20T08:00:00.000Z"),
      item("check", "failed-check", "2026-11-20T12:00:00.000Z"),
      item("perm", "permission", "2026-11-20T13:00:00.000Z"),
    ];
    expect(orderAttention(items).map((i) => i.id)).toEqual([
      "perm",
      "check",
      "accept-old",
      "accept-new",
      "step",
      "conclusion",
      "review",
    ]);
  });

  it("is oldest first within a rank, then by id", () => {
    const items = [
      item("b", "failed-check", "2026-11-20T10:00:00.000Z"),
      item("a", "failed-check", "2026-11-20T10:00:00.000Z"),
      item("old", "merge-conflict", "2026-11-20T09:00:00.000Z"),
      item("new", "permission", "2026-11-20T11:00:00.000Z"),
      item("older", "permission", "2026-11-20T08:00:00.000Z"),
    ];
    expect(orderAttention(items).map((i) => i.id)).toEqual(["older", "new", "old", "a", "b"]);
  });

  it("is a total order that does not depend on how the items arrive", () => {
    const kinds = Object.keys(INTERRUPT_KINDS) as InterruptKind[];
    const arb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 4 }),
      cause: fc.constantFrom(...kinds),
      at: fc
        .integer({ min: 0, max: 5 })
        .map((n) => new Date(Date.UTC(2026, 10, 20, 10, n)).toISOString()),
      conversation: fc.constant("local/c1"),
    });
    fc.assert(
      fc.property(fc.uniqueArray(arb, { selector: (i) => i.id }), (items) => {
        const sorted = orderAttention(items);
        expect(orderAttention([...items].reverse())).toEqual(sorted);
        for (let i = 1; i < sorted.length; i++)
          expect(
            compareAttention(sorted[i - 1] as AttentionItem, sorted[i] as AttentionItem),
          ).toBeLessThan(0);
      }),
    );
  });

  it("measures an interrupt's age from the time it arose", () => {
    expect(ageMs("2026-11-20T10:00:00.000Z", Date.parse("2026-11-20T10:00:30.000Z"))).toBe(30_000);
    expect(ageMs("2026-11-20T10:00:00.000Z", Date.parse("2026-11-20T09:00:00.000Z"))).toBe(0);
  });
});

describe("interrupt lifecycles", () => {
  const kinds = Object.keys(INTERRUPT_KINDS) as InterruptKind[];

  it("are closed machines for every kind: open, then settled or cleared", () => {
    for (const k of kinds) {
      const m = interruptMachine(k);
      expect(checkMachine(m.spec)).toEqual([]);
      expect(m.isTerminal("settled")).toBe(true);
      expect(m.isTerminal("cleared")).toBe(true);
      expect(m.triggers("open")).toEqual([
        ...INTERRUPT_KINDS[k].outcomes.map((o) => `settle:${o}`),
        "clear",
      ]);
    }
  });

  it("are settled by a person and by no one else", () => {
    for (const k of kinds) {
      const m = interruptMachine(k);
      for (const o of INTERRUPT_KINDS[k].outcomes) {
        expect(m.next("open", `settle:${o}`, "user")).toMatchObject({ ok: true, to: "settled" });
        for (const actor of ["agent", "resolver", "system"] as const)
          expect(m.next("open", `settle:${o}`, actor)).toMatchObject({
            ok: false,
            reason: "actor-not-allowed",
          });
        expect(m.personOnly("open", `settle:${o}`)).toBe(true);
      }
    }
  });

  it("are cleared by the source with a reason, never by a person", () => {
    const m = interruptMachine("failed-check");
    expect(m.next("open", "clear", "resolver", "the check passes")).toMatchObject({
      ok: true,
      to: "cleared",
    });
    expect(m.next("open", "clear", "resolver")).toMatchObject({
      ok: false,
      reason: "reason-required",
    });
    expect(m.next("open", "clear", "user", "gone")).toMatchObject({ ok: false });
  });

  it("settle only as an outcome the kind has, once", () => {
    const m = interruptMachine("permission");
    expect(m.next("open", "settle:retry", "user")).toMatchObject({
      ok: false,
      reason: "no-transition",
    });
    expect(m.next("settled", "settle:allowed", "user")).toMatchObject({ ok: false });
    expect(m.next("cleared", "settle:denied", "user")).toMatchObject({ ok: false });
    expect(interruptMachine("unfinished-step").triggers("open", "user")).toEqual([
      "settle:done",
      "settle:failed",
      "settle:retry",
    ]);
  });
});

describe("the thread lifecycle", () => {
  const m = threadMachine();
  const user = { kind: "user", id: "u", name: "Niko" } as const;
  const agent = { kind: "agent", id: "kiro", model: "m", version: "1" } as const;
  const cites = {
    thread: "local/t1",
    parent: "local/c1/m1@1",
    messages: 4,
    produced: [{ type: "kiro-session", id: "X" }],
  };
  const ev = (
    o: Partial<ThreadEventRow> & Pick<ThreadEventRow, "type" | "actor">,
  ): ThreadEventRow => ({
    address: `local/t1/${o.type}@1`,
    at: "2026-11-20T10:00:00.000Z",
    text: null,
    cites: null,
    proposal: null,
    endedAs: null,
    reason: null,
    ...o,
  });

  it("has no open ends, and ends honestly", () => {
    expect(checkMachine(m.spec)).toEqual([]);
    expect(m.isTerminal("wrapped-up")).toBe(true);
    expect(m.isTerminal("superseded")).toBe(true);
    expect(m.isTerminal("withdrawn")).toBe(true);
    expect(isEnded("concluding")).toBe(false);
    expect(isEnded("withdrawn")).toBe(true);
  });

  it("moves open, concluding, wrapped up, by the agent's proposal and the person's yes", () => {
    const fold = foldThread([
      ev({ type: "proposed", actor: agent, text: "Decided X.", cites }),
      ev({
        type: "wrapped-up",
        actor: user,
        text: "Decided X.",
        cites,
        proposal: "local/t1/proposed@1",
        at: "2026-11-20T10:05:00.000Z",
      }),
    ]);
    expect(fold.state).toBe("wrapped-up");
    expect(fold.conclusion).toMatchObject({
      text: "Decided X.",
      wrappedAt: "2026-11-20T10:05:00.000Z",
    });
    expect(fold.rejected).toBe(0);
  });

  it("returns to open when the person declines, and replaces a proposal with a newer one", () => {
    const declined = foldThread([
      ev({ type: "proposed", actor: agent, text: "One.", cites }),
      ev({ type: "declined", actor: user, proposal: "x" }),
    ]);
    expect(declined).toMatchObject({ state: "open", conclusion: null });
    const replaced = foldThread([
      ev({ type: "proposed", actor: agent, text: "One.", cites }),
      ev({ type: "proposed", actor: agent, text: "Two.", cites }),
    ]);
    expect(replaced).toMatchObject({ state: "concluding", conclusion: { text: "Two." } });
  });

  it("is not wrapped up by the agent, and a rejected event is counted, not applied", () => {
    const fold = foldThread([
      ev({ type: "proposed", actor: agent, text: "One.", cites }),
      ev({ type: "wrapped-up", actor: agent, text: "One.", cites }),
    ]);
    expect(fold.state).toBe("concluding");
    expect(fold.rejected).toBe(1);
  });

  it("ends as superseded or withdrawn only with a reason, from any live state", () => {
    expect(
      foldThread([
        ev({ type: "ended", actor: user, endedAs: "withdrawn", reason: "no longer needed" }),
      ]),
    ).toMatchObject({ state: "withdrawn", endedReason: "no longer needed" });
    expect(
      foldThread([ev({ type: "ended", actor: user, endedAs: "superseded", reason: "" })]),
    ).toMatchObject({
      state: "open",
      rejected: 1,
    });
    expect(
      foldThread([
        ev({ type: "proposed", actor: agent, text: "x", cites }),
        ev({ type: "ended", actor: user, endedAs: "superseded", reason: "folded into t2" }),
      ]).state,
    ).toBe("superseded");
  });
});
