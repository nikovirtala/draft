import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.ts";
import { eventHash, GENESIS_HASH, PEOPLE_AND_AGENT, parseEvent, sealEvent } from "../src/events.ts";
import { CONV, messageDraft, TRACE, USER } from "./helpers.ts";

const sealed = () =>
  sealEvent(messageDraft("m1", "user", "hello"), {
    id: "01KAHX0000000000000000000A",
    at: "2026-11-20T12:00:00.000Z",
    prevHash: GENESIS_HASH,
  });

describe("the event envelope", () => {
  it("seals a draft with every envelope field", () => {
    const e = sealed();
    expect(Object.keys(e).sort()).toEqual(
      [
        "actor",
        "address",
        "at",
        "conversation",
        "data",
        "hash",
        "id",
        "prevHash",
        "schema",
        "traceId",
        "type",
      ].sort(),
    );
    expect(e).toMatchObject({
      address: `${CONV}/m1@1`,
      conversation: CONV,
      type: "message.posted",
      schema: 2,
      actor: USER,
      traceId: TRACE,
      prevHash: GENESIS_HASH,
      data: { role: "user", text: "hello", audience: { people: "all", agent: true } },
    });
    expect(e.hash).toBe(eventHash(e));
    expect(parseEvent(e).ok).toBe(true);
  });

  it("hashes the previous hash plus the canonical JSON of the rest", async () => {
    const e = sealed();
    const { hash, ...rest } = e;
    const { createHash } = await import("node:crypto");
    expect(hash).toBe(
      createHash("sha256")
        .update(e.prevHash + canonicalJson(rest))
        .digest("hex"),
    );
  });

  it("keeps unknown data fields as received", () => {
    const e = {
      ...sealed(),
      data: { role: "user", text: "hi", audience: PEOPLE_AND_AGENT, extra: { kept: true } },
    };
    const r = parseEvent(e);
    expect(r.ok && (r.event.data as Record<string, unknown>).extra).toEqual({ kept: true });
  });

  it.each([
    ["a missing trace ID field", (e: Record<string, unknown>) => delete e.traceId, "traceId"],
    ["a short trace ID", (e: Record<string, unknown>) => (e.traceId = "abc"), "traceId"],
    [
      "an unversioned address",
      (e: Record<string, unknown>) => (e.address = `${CONV}/m1`),
      "address",
    ],
    [
      "a conversation with a version",
      (e: Record<string, unknown>) => (e.conversation = `${CONV}@1`),
      "conversation",
    ],
    [
      "an agent without a model",
      (e: Record<string, unknown>) => (e.actor = { kind: "agent", id: "a", version: "1" }),
      "actor",
    ],
    [
      "an unknown actor kind",
      (e: Record<string, unknown>) => (e.actor = { kind: "robot", id: "r" }),
      "actor",
    ],
    [
      "a time without milliseconds",
      (e: Record<string, unknown>) => (e.at = "2026-11-20T12:00:00Z"),
      "at",
    ],
    ["a non-ULID id", (e: Record<string, unknown>) => (e.id = "event-1"), "id"],
    ["a bad hash", (e: Record<string, unknown>) => (e.hash = "xyz"), "hash"],
    [
      "data of the wrong shape",
      (e: Record<string, unknown>) => (e.data = { role: "robot", text: 1 }),
      "data",
    ],
    [
      "an unknown type",
      (e: Record<string, unknown>) => (e.type = "message.edited"),
      "unknown event type",
    ],
    ["a newer schema version", (e: Record<string, unknown>) => (e.schema = 3), "newer"],
    [
      "no conversation outside context.created and log.recovered",
      (e: Record<string, unknown>) => (e.conversation = null),
      "conversation",
    ],
  ])("rejects %s", (_name, mutate, mention) => {
    const e = structuredClone(sealed()) as unknown as Record<string, unknown>;
    mutate(e);
    const r = parseEvent(e);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain(mention);
  });

  it("refuses to seal an invalid draft", () => {
    expect(() =>
      sealEvent(
        { ...messageDraft("m1", "user", "x"), traceId: "nope" },
        {
          id: "01KAHX0000000000000000000A",
          at: "2026-11-20T12:00:00.000Z",
          prevHash: GENESIS_HASH,
        },
      ),
    ).toThrow(/refusing to write/);
  });
});
