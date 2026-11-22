import { describe, expect, it } from "vitest";
import {
  type AgentChange,
  buildAgentNote,
  changesSince,
  renderChanges,
} from "../src/agent-changes.ts";
import { type EventDraft, PEOPLE_ONLY } from "../src/events.ts";
import { MemoryLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { AGENT, CONV, genesisDrafts, messageDraft, SYSTEM, TRACE, testClock } from "./helpers.ts";

/**
 * What the agent is told about what the person could see and it could not: decisions made in
 * draft and what draft resolved for the stubs referenced, since the agent's last turn. The
 * function is pure over the projection; the "since" is a place in the log, so a restart sends
 * nothing twice.
 */

const PERSON = { kind: "user", id: "01kahx0000000000000000user", name: "Niko" } as const;
const PR14 = { type: "pull-request", id: "nikovirtala/draft/pull/14" };
const PR16 = { type: "pull-request", id: "nikovirtala/draft/pull/16" };

function pullState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: "nikovirtala/draft",
    number: 16,
    title: "feat: tell the agent",
    url: "https://github.com/nikovirtala/draft/pull/16",
    state: "open",
    draft: false,
    author: "kiro",
    headSha: "abcdef0123456789",
    headRef: "kiro/tell-the-agent",
    baseRef: "main",
    mergeable: true,
    mergeableState: "blocked",
    checks: [
      { name: "ci", source: "check-run", status: "in_progress", conclusion: null, url: null },
      { name: "lint", source: "check-run", status: "completed", conclusion: "success", url: null },
    ],
    checksSummary: { total: 2, passed: 1, failed: 0, pending: 1 },
    review: { decision: "none", reviews: [], requested: ["niko"] },
    ...over,
  };
}

class Rig {
  private readonly clock = testClock();
  readonly log = new MemoryLogStore(this.clock);
  projection = Projection.open();
  private n = 0;
  readonly turns: string[] = [];

  async open(): Promise<this> {
    await this.add(...genesisDrafts());
    return this;
  }

  id(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  async add(...drafts: EventDraft[]): Promise<void> {
    this.clock.advance(1000);
    for (const e of await this.log.append(drafts)) this.projection.apply(e);
  }

  /** A message of the person to the agent, and the references it makes. */
  async say(
    text: string,
    refs: { type: string; id: string }[] = [],
    snapshot: Record<string, unknown> = {},
    audience?: typeof PEOPLE_ONLY,
  ): Promise<string> {
    const item = this.id("m");
    const address = `${CONV}/${item}@1`;
    await this.add(messageDraft(item, "user", text, audience));
    for (const target of refs)
      await this.add({
        type: "reference.made",
        address: `${CONV}/${this.id("r")}@1`,
        conversation: CONV,
        actor: SYSTEM,
        traceId: TRACE,
        data: {
          from: address,
          target,
          kind: "explicit",
          relation: "mentions",
          source: "text",
          snapshot,
        },
      });
    return address;
  }

  async observe(target: { type: string; id: string }, state: Record<string, unknown>) {
    await this.add({
      type: "status.observed",
      address: `${CONV}/${this.id("o")}@1`,
      conversation: CONV,
      actor: { kind: "resolver", id: target.type, version: "1" },
      traceId: null,
      data: { target, state },
    });
  }

  /** Begins a turn the way the conversation does: the note is computed, then written. */
  async turn(agent = "fake") {
    const message = await this.say("go");
    const note = buildAgentNote(this.projection, CONV, { agent });
    await this.add({
      type: "agent.turn_started",
      address: `${CONV}/${this.id("t")}@1`,
      conversation: CONV,
      actor: { ...AGENT, id: agent },
      traceId: TRACE,
      data: { message, agent, note: note.text, entries: note.entries, omitted: note.omitted },
    });
    return note;
  }

  /** An acceptance request, the step that carried the answer out, and the settlement. */
  async decide(
    outcome: "accepted" | "rejected" | "changes-requested",
    o: { target?: { type: string; id: string }; text?: string; sha?: string } = {},
  ): Promise<void> {
    const target = o.target ?? PR14;
    const key = `acceptance:${target.id}@${o.sha ?? "c0ffee0"}`;
    await this.add({
      type: "interrupt.raised",
      address: `${CONV}/${this.id("i")}@1`,
      conversation: CONV,
      actor: { kind: "resolver", id: target.type, version: "1" },
      traceId: null,
      data: {
        key,
        kind: "acceptance",
        target,
        summary: "nikovirtala/draft#14: ready to merge",
        detail: {
          acceptance: "pull-request",
          target,
          title: "docs: explain acceptance",
          sha: "c0ffee0",
        },
      },
    });
    let via: string | null = null;
    if (outcome !== "changes-requested") {
      const started = `${CONV}/${this.id("s")}@1`;
      const idempotencyKey = this.id("k");
      await this.add({
        type: "step.started",
        address: started,
        conversation: CONV,
        actor: PERSON,
        traceId: TRACE,
        data: {
          idempotencyKey,
          toolUseId: this.id("u"),
          name: outcome === "accepted" ? "draft.pull-request.merge" : "draft.pull-request.close",
          input: {},
          decision: "approved-by-user",
        },
      });
      await this.add({
        type: "step.completed",
        address: `${CONV}/${this.id("c")}@1`,
        conversation: CONV,
        actor: PERSON,
        traceId: TRACE,
        data: {
          started,
          idempotencyKey,
          resultSummary:
            outcome === "accepted"
              ? "merged nikovirtala/draft#14 by rebase, now f724c94"
              : "closed nikovirtala/draft#14 with your reason as a comment",
          effect: {
            kind: outcome === "accepted" ? "pull-request.merge" : "pull-request.close",
            target,
            sha: outcome === "accepted" ? "f724c94aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : null,
            evidence: [],
            inverse: { kind: "irreversible", reason: "a merge is not undone from here" },
          },
        },
      });
      via = started;
    }
    await this.add({
      type: "interrupt.settled",
      address: `${CONV}/${this.id("z")}@1`,
      conversation: CONV,
      actor: PERSON,
      traceId: TRACE,
      data: {
        key,
        kind: "acceptance",
        outcome,
        started: null,
        via,
        detail: {
          acceptance: "pull-request",
          sha: "c0ffee0",
          ...(o.text === undefined
            ? {}
            : outcome === "rejected"
              ? { reason: o.text }
              : { note: o.text }),
        },
      },
    });
  }
}

const note = (r: Rig, agent = "fake") => buildAgentNote(r.projection, CONV, { agent });

describe("what changed since the agent's last turn", () => {
  it("tells an acceptance: who, what, and the commit it merged at", async () => {
    const r = await new Rig().open();
    await r.turn();
    await r.decide("accepted");
    const n = note(r);
    expect(n.changes).toHaveLength(1);
    expect(n.changes[0]).toMatchObject({
      kind: "settlement",
      by: "Niko",
      outcome: "accepted",
      address: "pull-request:nikovirtala/draft/pull/14",
      result: { kind: "pull-request.merge", sha: expect.stringMatching(/^f724c94/) },
    });
    expect(n.text).toContain("draft's record, not the person's words");
    expect(n.text).toContain("Niko accepted pull request “docs: explain acceptance”");
    expect(n.text).toContain("[pull-request:nikovirtala/draft/pull/14]");
    expect(n.text).toContain("commit f724c94");
    expect(n.text).toContain("merged nikovirtala/draft#14 by rebase, now f724c94");
    expect(n.entries).toBe(1);
    expect(n.omitted).toBe(0);
  });

  it("tells a rejection with its reason", async () => {
    const r = await new Rig().open();
    await r.turn();
    await r.decide("rejected", { text: "the design is wrong, redo it" });
    const text = note(r).text ?? "";
    expect(text).toContain("Niko rejected pull request");
    expect(text).toContain("Their reason: “the design is wrong, redo it”");
    expect(text).toContain("closed nikovirtala/draft#14");
  });

  it("tells a request for changes with the text, and that nothing was merged", async () => {
    const r = await new Rig().open();
    await r.turn();
    await r.decide("changes-requested", { text: "add a test for the cap" });
    const n = note(r);
    expect(n.changes[0]).toMatchObject({
      outcome: "changes-requested",
      text: "add a test for the cap",
      result: null,
    });
    expect(n.text).toContain("Niko requested changes on pull request");
    expect(n.text).toContain("Their note: “add a test for the cap”");
    expect(n.text).toContain("Nothing was merged or accepted");
  });

  it("tells any person-only settlement of a kind, not only acceptance", async () => {
    const r = await new Rig().open();
    await r.turn();
    await r.add({
      type: "interrupt.settled",
      address: `${CONV}/${r.id("z")}@1`,
      conversation: CONV,
      actor: PERSON,
      traceId: TRACE,
      data: {
        key: "conclusion:x",
        kind: "conclusion",
        outcome: "declined",
        started: null,
        via: null,
        detail: {},
      },
    });
    expect(note(r).text).toContain("Niko settled (conclusion, as “declined”)");
  });

  it("ignores a settlement that is not a person's", async () => {
    const r = await new Rig().open();
    await r.add({
      type: "interrupt.settled",
      address: `${CONV}/${r.id("z")}@1`,
      conversation: CONV,
      actor: SYSTEM,
      traceId: TRACE,
      data: {
        key: "x",
        kind: "conclusion",
        outcome: "confirmed",
        started: null,
        via: null,
        detail: {},
      },
    });
    expect(changesSince(r.projection, CONV)).toEqual([]);
  });

  it("gives a pull request's facts: state, head, checks, mergeability, review, and when", async () => {
    const r = await new Rig().open();
    await r.say("what about nikovirtala/draft#16?", [PR16], pullState());
    const n = note(r);
    expect(n.changes).toHaveLength(1);
    const text = n.text ?? "";
    expect(text).toContain("pull request nikovirtala/draft#16 “feat: tell the agent”");
    expect(text).toContain("open");
    expect(text).toContain("head abcdef0 (kiro/tell-the-agent)");
    expect(text).toContain("checks: 1 of 2 passed, 1 still running (ci)");
    expect(text).toContain("mergeable: yes (GitHub says blocked)");
    expect(text).toContain("review: none, requested from niko");
    expect(text).toContain("[pull-request:nikovirtala/draft/pull/16]");
    expect(text).toContain("2026-11-20T12:00:03.000Z: pull request");
  });

  it("gives a Kiro session's status, an issue's and an artifact page's state and title", () => {
    const at = "2026-11-22T12:00:00Z";
    const stubs: AgentChange[] = [
      {
        kind: "stub",
        at,
        seq: 1,
        target: "kiro-session:01KAHX7Z1M2N3P4Q5R6S7T8V9W",
        type: "kiro-session",
        id: "01KAHX7Z1M2N3P4Q5R6S7T8V9W",
        state: {
          title: "Fix the build",
          status: "running",
          pendingPermissions: 0,
          repos: ["nikovirtala/draft"],
          pullRequests: ["nikovirtala/draft#16"],
        },
      },
      {
        kind: "stub",
        at,
        seq: 2,
        target: "ark-issue:draft:15cxvdep",
        type: "ark-issue",
        id: "draft:15cxvdep",
        state: { title: "Keep credentials out", status: "closed", resolution: "done" },
      },
      {
        kind: "stub",
        at,
        seq: 3,
        target: "artifact:http://a/p",
        type: "artifact",
        id: "p",
        state: { title: "Plan", currentVersion: 2, versions: 3 },
      },
    ];
    const text = renderChanges(stubs).text ?? "";
    expect(text).toContain(
      "Kiro session 01KAHX7Z1M2N3P4Q5R6S7T8V9W “Fix the build”: status running",
    );
    expect(text).toContain("linked pull requests nikovirtala/draft#16");
    expect(text).toContain("ark issue draft:15cxvdep “Keep credentials out”: closed (done)");
    expect(text).toContain("artifact page p “Plan”: version 2 of 3");
  });

  it("a stub resolved twice is one entry, with the latest state and time", async () => {
    const r = await new Rig().open();
    await r.say("see nikovirtala/draft#16", [PR16], pullState());
    await r.observe(PR16, pullState({ mergeableState: "clean" }));
    await r.observe(
      PR16,
      pullState({
        state: "merged",
        mergeable: null,
        checks: [],
        checksSummary: { total: 2, passed: 2, failed: 0, pending: 0 },
      }),
    );
    const changes = changesSince(r.projection, CONV).filter((c) => c.kind === "stub");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ target: "pull-request:nikovirtala/draft/pull/16" });
    const text = note(r).text ?? "";
    expect(text.match(/pull request nikovirtala\/draft#16/g)).toHaveLength(1);
    expect(text).toContain("merged");
    expect(text).toContain("2 of 2 passed");
    expect(text).not.toContain("still running");
  });

  it("says nothing when nothing is new", async () => {
    const r = await new Rig().open();
    expect(note(r)).toEqual({ text: null, entries: 0, omitted: 0, changes: [] });
    await r.say("see nikovirtala/draft#16", [PR16], pullState());
    await r.decide("accepted");
    expect(note(r).text).not.toBeNull();
    await r.turn();
    expect(note(r)).toEqual({ text: null, entries: 0, omitted: 0, changes: [] });
  });

  it("the turn records exactly the note the agent was given", async () => {
    const r = await new Rig().open();
    await r.decide("accepted");
    const told = await r.turn();
    expect(told.text).not.toBeNull();
    expect(r.projection.lastTurn(CONV, "fake")).toMatchObject({
      note: told.text,
      entries: 1,
      omitted: 0,
    });
  });

  it("puts what happens during a turn into the next turn's note, not the running one's", async () => {
    const r = await new Rig().open();
    await r.say("see nikovirtala/draft#16", [PR16], pullState());
    const first = await r.turn();
    expect(first.text).toContain("still running (ci)");
    // The turn is running: the check passes, and the person accepts something else.
    await r.observe(
      PR16,
      pullState({ checksSummary: { total: 2, passed: 2, failed: 0, pending: 0 }, checks: [] }),
    );
    await r.decide("accepted");
    const second = await r.turn();
    expect(second.text).toContain("2 of 2 passed");
    expect(second.text).toContain("Niko accepted");
    expect(note(r).text).toBeNull();
  });

  it("is still the same after a restart: the note is not sent twice", async () => {
    const r = await new Rig().open();
    await r.say("see nikovirtala/draft#16", [PR16], pullState());
    await r.decide("rejected", { text: "no" });
    const first = await r.turn();
    expect(first.entries).toBe(2);
    // A restart rebuilds the projection from the log alone.
    const again = Projection.open();
    again.rebuild(r.log.events());
    expect(buildAgentNote(again, CONV, { agent: "fake" })).toEqual({
      text: null,
      entries: 0,
      omitted: 0,
      changes: [],
    });
    // And an incremental one that never saw the first agree.
    expect(again.lastTurn(CONV, "fake")?.seq).toBe(r.projection.lastTurn(CONV, "fake")?.seq);
  });

  it("counts from the agent's own last turn: another agent starts from the beginning", async () => {
    const r = await new Rig().open();
    await r.decide("accepted");
    await r.turn("first");
    expect(note(r, "first").text).toBeNull();
    // A second agent never saw the decision.
    expect(note(r, "second").text).toContain("Niko accepted");
  });

  it("keeps people-only messages out: a stub only they referenced is not told", async () => {
    const r = await new Rig().open();
    await r.say("aside: nikovirtala/draft#16", [PR16], pullState(), PEOPLE_ONLY);
    expect(note(r)).toEqual({ text: null, entries: 0, omitted: 0, changes: [] });
    // Referenced again where the agent can read it, it is told.
    await r.say("nikovirtala/draft#16", [PR16], pullState());
    expect(note(r).changes).toHaveLength(1);
  });

  it("tells a stub the person names again, though it did not change", async () => {
    const r = await new Rig().open();
    await r.say("nikovirtala/draft#16", [PR16], pullState());
    await r.turn();
    expect(note(r).text).toBeNull();
    await r.say("and again nikovirtala/draft#16", [PR16], pullState());
    expect(note(r).changes).toHaveLength(1);
  });

  it("tells another context's item only once a person pulled it in, and then once", async () => {
    const r = await new Rig().open();
    const item = { type: "context-item", id: "harbour/c1/m1@1" };
    const snapshot = {
      context: "harbour",
      address: "harbour/c1/m1@1",
      kind: "message",
      version: 1,
      hash: "0".repeat(64),
      title: "The harbour plan",
      text: "Dock at six.",
      role: "user",
      at: "2026-11-20T10:00:00Z",
    };
    await r.say("see harbour/c1/m1@1", [item], snapshot);
    await r.turn();
    expect(note(r).text).toBeNull();
    await r.add({
      type: "context.crossed",
      address: `${CONV}/${r.id("x")}@1`,
      conversation: CONV,
      actor: PERSON,
      traceId: TRACE,
      data: {
        purpose: "pulled",
        context: "harbour",
        target: "harbour/c1/m1@1",
        from: null,
        snapshotHash: "0".repeat(64),
        via: null,
      },
    });
    const text = note(r).text ?? "";
    expect(text).toContain("harbour/c1/m1@1 from the context “harbour”");
    expect(text).toContain("Dock at six.");
    await r.turn();
    expect(note(r).text).toBeNull();
  });

  describe("the cap", () => {
    it("names how many were left out and how to ask, keeping decisions first and the newest", async () => {
      const r = await new Rig().open();
      for (let i = 1; i <= 30; i++) {
        const t = { type: "pull-request", id: `nikovirtala/draft/pull/${100 + i}` };
        await r.say(`#${i}`, [t], pullState({ number: 100 + i, title: `change ${i}` }));
      }
      await r.decide("accepted");
      const n = note(r);
      expect(n.changes).toHaveLength(31);
      expect(n.entries).toBe(12);
      expect(n.omitted).toBe(19);
      const text = n.text ?? "";
      expect(text).toContain("Niko accepted");
      expect(text).toContain("change 30");
      expect(text).not.toContain("change 1”");
      expect(text).toContain("19 more changes were left out");
      expect(text).toContain("Ask the user");
      expect(text.length).toBeLessThanOrEqual(4000);
    });

    it("also holds when the entries are long", () => {
      const stubs: AgentChange[] = Array.from({ length: 10 }, (_, i) => ({
        kind: "stub" as const,
        at: "2026-11-22T12:00:00Z",
        seq: i,
        target: `x:${i}`,
        type: "unknown-type",
        id: String(i),
        state: { blob: "z".repeat(3000) },
      }));
      const out = renderChanges(stubs);
      expect((out.text ?? "").length).toBeLessThanOrEqual(4000);
      expect(out.entries + out.omitted).toBe(10);
      expect(out.omitted).toBeGreaterThan(0);
    });
  });
});
