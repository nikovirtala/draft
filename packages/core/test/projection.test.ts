import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type EventDraft, isUnknown } from "../src/events.ts";
import { MemoryLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { sealRawRecord } from "../src/testing/index.ts";
import { verifyChain } from "../src/verify.ts";
import { AGENT, CONV, genesisDrafts, messageDraft, SYSTEM, TRACE, testClock } from "./helpers.ts";

const SESSIONS = [
  "01KAHX7Z1M2N3P4Q5R6S7T8V9W",
  "01KAHX8A1B2C3D4E5F6G7H8J9K",
  "01KAHX9M8N7P6Q5R4S3T2V1W0X",
];

const arbState = fc.record({
  title: fc.constantFrom("Fix the build", "Write docs", null),
  status: fc.constantFrom("running", "idle", "awaiting_permission", "failed"),
  pendingPermissions: fc.integer({ min: 0, max: 3 }),
});

let item = 0;
const next = () => `i${++item}`;

const arbDraft: fc.Arbitrary<() => EventDraft> = fc.oneof(
  fc.tuple(fc.constantFrom("user", "agent" as const), fc.string()).map(
    ([role, text]) =>
      () =>
        messageDraft(next(), role as "user" | "agent", text),
  ),
  fc
    .tuple(fc.constantFrom("kiro_get_session", "kiro_launch_session"), fc.boolean(), fc.boolean())
    .map(
      ([name, isError, ran]) =>
        (): EventDraft => ({
          type: "agent.tool_called",
          address: `${CONV}/${next()}@1`,
          conversation: CONV,
          actor: AGENT,
          traceId: TRACE,
          data: {
            toolUseId: `toolu_${item}`,
            name,
            input: { sessionId: SESSIONS[0] },
            decision: ran ? "allowed-read-only" : "denied-by-user",
            resultSummary: ran ? "{}" : null,
            isError,
          },
        }),
    ),
  fc
    .tuple(
      fc.constantFrom(...SESSIONS),
      arbState,
      fc.constantFrom("explicit", "structural" as const),
    )
    .map(
      ([id, snapshot, kind]) =>
        (): EventDraft => ({
          type: "reference.made",
          address: `${CONV}/${next()}@1`,
          conversation: CONV,
          actor: SYSTEM,
          traceId: TRACE,
          data: {
            from: `${CONV}/m1@1`,
            target: { type: "kiro-session", id },
            kind: kind as "explicit" | "structural",
            relation: "mentions",
            source: "text",
            snapshot,
          },
        }),
    ),
  fc.tuple(fc.constantFrom(...SESSIONS), arbState).map(
    ([id, state]) =>
      (): EventDraft => ({
        type: "status.observed",
        address: `${CONV}/${next()}@1`,
        conversation: CONV,
        actor: { kind: "resolver", id: "kiro-session", version: "1" },
        traceId: null,
        data: { target: { type: "kiro-session", id }, state },
      }),
  ),
);

describe("projections", () => {
  it("rebuild from the log equals the incremental build, across restarts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(arbDraft, fc.boolean()), { maxLength: 40 }),
        fc.integer({ min: 1, max: 5 }),
        async (steps, batch) => {
          const log = new MemoryLogStore(testClock());
          const db = new DatabaseSync(":memory:");
          let incremental = new Projection(db);
          for (const e of await log.append(genesisDrafts())) incremental.apply(e);
          let pending: EventDraft[] = [];
          for (const [make, restart] of steps) {
            pending.push(make());
            if (pending.length >= batch) {
              for (const e of await log.append(pending)) incremental.apply(e);
              pending = [];
            }
            if (restart) {
              // A restart reopens the same database and catches up from the log.
              incremental = new Projection(db);
              expect(incremental.sync(log.events())).not.toBe("rebuilt");
            }
          }
          await log.append(pending);
          incremental.sync(log.events());

          const rebuilt = Projection.open();
          rebuilt.rebuild(log.events());
          expect(incremental.dump()).toEqual(rebuilt.dump());
          rebuilt.close();
          db.close();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("rebuild equals incremental with events this build doesn't understand in the log", async () => {
    // An unknown type at any schema version, or a known type at a newer one.
    const arbUnknown = fc
      .oneof(
        fc.record({
          type: fc.constantFrom("thread.summarized", "kind.extracted"),
          schema: fc.integer({ min: 1, max: 4 }),
        }),
        fc.record({
          type: fc.constantFrom("message.posted", "status.observed"),
          schema: fc.integer({ min: 2, max: 4 }),
        }),
      )
      .chain((t) =>
        fc.record({
          type: fc.constant(t.type),
          schema: fc.constant(t.schema),
          conversation: fc.constantFrom(CONV, "local/other", null),
        }),
      );
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            arbDraft.map((d) => ({ d })),
            arbUnknown.map((u) => ({ u })),
          ),
          { maxLength: 30 },
        ),
        fc.array(fc.nat(), { maxLength: 5 }),
        async (steps, cuts) => {
          // Seal this build's events, then re-chain them with the raw ones as another build would.
          const sealed = new MemoryLogStore(testClock());
          const known = await sealed.append([
            ...genesisDrafts(),
            ...steps.flatMap((x) => ("d" in x ? [x.d()] : [])),
          ]);
          let k = 2;
          let n = 0;
          let prev = "0".repeat(64);
          const plain = (r: unknown) => {
            const { prevHash: _p, hash: _h, ...rest } = JSON.parse(JSON.stringify(r));
            return rest as Record<string, unknown>;
          };
          const fields = [
            plain(known[0]),
            plain(known[1]),
            ...steps.map((x) =>
              "d" in x
                ? plain(known[k++])
                : {
                    id: `01M80000000000000000000${String(n++).padStart(3, "0")}`,
                    at: "2027-01-01T00:00:00.000Z",
                    data: { from: "a newer build" },
                    ...x.u,
                  },
            ),
          ];
          const raw = fields.map((f) => {
            const out = sealRawRecord(f, prev);
            prev = out.hash as string;
            return out;
          });
          const verified = verifyChain(raw);
          expect(verified.ok).toBe(true);
          if (!verified.ok) return;
          const records = verified.events;
          const db = new DatabaseSync(":memory:");
          for (const c of [...cuts.map((x) => x % (records.length + 1))].sort((a, b) => a - b)) {
            expect(new Projection(db).sync(records.slice(0, c))).not.toBe("rebuilt");
          }
          const incremental = new Projection(db);
          incremental.sync(records);
          const rebuilt = Projection.open();
          rebuilt.rebuild(records);
          expect(incremental.dump()).toEqual(rebuilt.dump());
          expect(rebuilt.unknownCount()).toBe(records.filter(isUnknown).length);
          rebuilt.close();
          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("shows messages, references and live stubs", async () => {
    const log = new MemoryLogStore(testClock());
    const p = Projection.open();
    p.applyAll(await log.append(genesisDrafts()));
    const ref: EventDraft = {
      type: "reference.made",
      address: `${CONV}/r1@1`,
      conversation: CONV,
      actor: SYSTEM,
      traceId: TRACE,
      data: {
        from: `${CONV}/m2@1`,
        target: { type: "kiro-session", id: SESSIONS[0] as string },
        kind: "structural",
        relation: "mentions",
        source: "text",
        snapshot: { title: "Fix the build", status: "running", pendingPermissions: 0 },
      },
    };
    const status: EventDraft = {
      type: "status.observed",
      address: `${CONV}/s1@1`,
      conversation: CONV,
      actor: { kind: "resolver", id: "kiro-session", version: "1" },
      traceId: null,
      data: {
        target: { type: "kiro-session", id: SESSIONS[0] as string },
        state: { title: "Fix the build", status: "awaiting_permission", pendingPermissions: 1 },
      },
    };
    p.applyAll(
      await log.append([
        messageDraft("m1", "user", "hi"),
        messageDraft("m2", "agent", "hello"),
        ref,
        status,
      ]),
    );
    expect(p.messages(CONV).map((m) => [m.role, m.text])).toEqual([
      ["user", "hi"],
      ["agent", "hello"],
    ]);
    const [edge] = p.edges(CONV);
    expect(edge).toMatchObject({
      from: `${CONV}/m2@1`,
      kind: "structural",
      snapshot: { status: "running" },
    });
    expect(p.stub(`kiro-session:${SESSIONS[0]}`)?.state).toMatchObject({
      status: "awaiting_permission",
    });
  });

  it("rebuilds when the database belongs to another log", async () => {
    const a = new MemoryLogStore(testClock());
    await a.append([...genesisDrafts(), messageDraft("m1", "user", "a")]);
    const b = new MemoryLogStore(testClock(Date.UTC(2027, 0, 1)));
    await b.append([...genesisDrafts(), messageDraft("m1", "user", "b")]);
    const p = Projection.open();
    p.sync(a.events());
    expect(p.sync(b.events())).toBe("rebuilt");
    expect(p.messages(CONV)[0]?.text).toBe("b");
  });
});
