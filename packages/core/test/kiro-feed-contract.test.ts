import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  classifyFeedEvent,
  FEED_ENUMS,
  FEED_TYPE_NAMES,
  FEED_TYPES,
  FeedPageSchema,
  type FeedType,
  KNOWN_FEED_TYPES,
  WAIT_END_REASONS,
  WAKE_CAUSES,
} from "../src/feed.ts";
import { FakeKiroRemote } from "../src/testing/index.ts";

/**
 * The contract test: draft's reader is checked against Kiro Remote's own JSON Schemas, vendored at
 * the commit PINNED.json names (scripts/sync-feed-schemas.ts refreshes them). Vendored, not
 * fetched, so the test passes offline and a change of contract is a diff someone reads.
 *
 * Three things are checked, so the reader can drift from the contract in none of them:
 * 1. the types, their effects and their payload fields are the schemas' (structure);
 * 2. what the schemas accept, the reader handles, and what they refuse, it does not follow
 *    (behaviour, on a sample of every type and a mutation of every field);
 * 3. what the fake Kiro Remote emits, the schemas accept (so the fake the other tests read is
 *    the contract's, not draft's idea of it).
 */

const dir = join(dirname(fileURLToPath(import.meta.url)), "../schemas/kiro-remote-feed");
const read = (name: string) =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
const pinned = read("PINNED.json") as { commit: string; files: string[]; repo: string };

type Json = Record<string, unknown>;
const props = (schema: Json): Record<string, Json> => schema.properties as Record<string, Json>;

/** The validator of one vendored schema, built with zod's own JSON Schema reader. */
const validator = (name: string) =>
  z.fromJSONSchema(read(name) as Parameters<typeof z.fromJSONSchema>[0]);

const TYPES = pinned.files.filter((f) => !["envelope.json", "page.json"].includes(f));

/** A payload that every type's schema accepts. */
const PAYLOADS: Record<FeedType, Json> = {
  "link.added": { method: "trailer", prState: "open" },
  "link.removed": { reason: "unlinked" },
  "link.state_changed": { from: "open", to: "merged" },
  "wait.registered": { waitSource: "mcp" },
  "wait.removed": { reason: "merged" },
  "wake.queued": { itemId: "item-1", kind: "pr_wait_merged", cause: "wait", merged: false },
  "wake.delivered": { itemId: "item-1", kind: "pr_wait_merged", cause: "wait", turnId: "turn-1" },
  "wake.released": { itemId: "item-1", kind: "pr_wait_merged", cause: "wait", turnId: "turn-1" },
  "wake.dropped": { itemId: "item-1", kind: "pr_wait_merged", cause: "wait", reason: "deleted" },
};

function sample(type: FeedType, payload: Json = PAYLOADS[type], seq = 1): Json {
  return {
    v: 1,
    id: "01M8AAAAAAAAAAAAAAAAAAAAAA",
    seq,
    ts: "2026-11-24T08:01:12.000Z",
    type,
    effect: FEED_TYPES[type].effect,
    sessionId: "01M8BBBBBBBBBBBBBBBBBBBBBB",
    pr: "octo/repo#7",
    source: "webhook",
    payload,
  };
}

describe("the vendored contract", () => {
  it("is pinned to a commit of kiro-remote, with every file it lists", () => {
    expect(pinned.repo).toBe("nikovirtala/kiro-remote");
    expect(pinned.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      readdirSync(dir)
        .filter((f) => f.endsWith(".json") && f !== "PINNED.json")
        .sort(),
    ).toEqual([...pinned.files].sort());
  });

  it("has a schema for every type the reader knows, and the reader knows every type there is", () => {
    expect(TYPES.map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...FEED_TYPE_NAMES].sort());
    expect([...KNOWN_FEED_TYPES].sort()).toEqual([...FEED_TYPE_NAMES].sort());
  });
});

describe.each(TYPES)("%s, against its schema", (file) => {
  const type = file.replace(/\.json$/, "") as FeedType;
  const schema = read(file);
  const check = validator(file);
  const payloadSchema = props(schema).payload as Json;

  it("has the type and the effect the reader has", () => {
    expect(props(schema).type?.const).toBe(type);
    expect(props(schema).effect?.const).toBe(FEED_TYPES[type].effect);
  });

  it("has the payload fields and the required ones the reader has", () => {
    const ours = z.toJSONSchema(FEED_TYPES[type].payload, {
      target: "draft-2020-12",
      io: "input",
    }) as Json;
    expect(Object.keys(props(ours)).sort()).toEqual(Object.keys(props(payloadSchema)).sort());
    expect([...((ours.required as string[] | undefined) ?? [])].sort()).toEqual(
      [...((payloadSchema.required as string[] | undefined) ?? [])].sort(),
    );
  });

  it("names, for each enum, the values the schema lists: a sync that adds one shows here", () => {
    const theirs = Object.fromEntries(
      Object.entries(props(payloadSchema))
        .filter(([, s]) => Array.isArray(s.enum))
        .map(([name, s]) => [name, [...(s.enum as string[])].sort()]),
    );
    const ours = Object.fromEntries(
      Object.entries(FEED_ENUMS[type] ?? {}).map(([name, values]) => [name, [...values].sort()]),
    );
    expect(ours).toEqual(theirs);
  });

  it("reads what the schema accepts", () => {
    const event = sample(type);
    expect(check.safeParse(event).success).toBe(true);
    expect(classifyFeedEvent(event).kind).toBe("handle");
  });

  const fields = Object.keys(props(payloadSchema));
  it.each(fields)("does not follow an event without its payload field %s", (field) => {
    const { [field]: _gone, ...rest } = PAYLOADS[type];
    const event = sample(type, rest);
    expect(check.safeParse(event).success).toBe(false);
    expect(classifyFeedEvent(event).kind).not.toBe("handle");
  });

  it.each(Object.entries(props(payloadSchema)).filter(([, s]) => Array.isArray(s.enum)))(
    "follows a value of %s the contract gained since, as opaque",
    (field) => {
      // Enums gain values within v: 1: the schema as a producer wrote it refuses what it doesn't
      // list, and a reader never does (Kiro Remote's docs/github.md, "The rule for enum values").
      const event = sample(type, { ...PAYLOADS[type], [field]: "something-new" });
      expect(check.safeParse(event).success).toBe(false);
      const c = classifyFeedEvent(event);
      expect(c.kind).toBe("handle");
      if (c.kind === "handle")
        expect((c.event.payload as Json)[field], `${type}.${field}`).toBe("something-new");
    },
  );

  it("ignores a field it doesn't know, as the contract asks of readers", () => {
    const event = sample(type, { ...PAYLOADS[type], added: "later" });
    // The schema is strict, as a producer's must be; a reader is not.
    expect(check.safeParse(event).success).toBe(false);
    expect(classifyFeedEvent(event).kind).toBe("handle");
  });
});

describe("an end reason added after the pinned schemas: session_deleted", () => {
  it("is followed, not stopped on, and kept as given", () => {
    const event = sample("wait.removed", { reason: "session_deleted" });
    expect(validator("wait.removed.json").safeParse(event).success).toBe(false);
    const c = classifyFeedEvent(event);
    expect(c.kind).toBe("handle");
    if (c.kind === "handle") expect(c.event.payload).toMatchObject({ reason: "session_deleted" });
  });

  it("still stops at what it can't read: a missing field, a wrong kind of value, a type, an effect", () => {
    expect(classifyFeedEvent(sample("wait.removed", {})).kind).toBe("stop");
    expect(classifyFeedEvent(sample("wait.removed", { reason: 7 })).kind).toBe("stop");
    expect(classifyFeedEvent({ ...sample("wait.removed"), type: "wait.paused" }).kind).toBe("stop");
    expect(classifyFeedEvent({ ...sample("wait.removed"), effect: "sideways" }).kind).toBe("stop");
  });
});

describe("the envelope and the page", () => {
  it("accept each other's sample", () => {
    const env = validator("envelope.json");
    const page = validator("page.json");
    const event = sample("wait.removed");
    expect(env.safeParse({ ...event, type: "anything.new" }).success).toBe(true);
    const body = { events: [event], nextCursor: 1, hasMore: false };
    expect(page.safeParse(body).success).toBe(true);
    expect(FeedPageSchema.safeParse(body).success).toBe(true);
    expect(page.safeParse({ ...body, hasMore: "no" }).success).toBe(false);
    expect(FeedPageSchema.safeParse({ ...body, hasMore: "no" }).success).toBe(false);
  });

  it("lists the sources, the causes and the end reasons the reader names", () => {
    const sources = (props(read("envelope.json")).source as Json).enum as string[];
    expect(sources.sort()).toEqual(["harvest", "mcp", "rest", "sweep", "trailer", "webhook"]);
    const cause = (props(props(read("wake.queued.json")).payload as Json).cause as Json)
      .enum as string[];
    expect([...cause].sort()).toEqual([...WAKE_CAUSES].sort());
    const reason = (props(props(read("wait.removed.json")).payload as Json).reason as Json)
      .enum as string[];
    expect([...reason].sort()).toEqual([...WAIT_END_REASONS].sort());
  });

  it("keeps a source it doesn't know, opaque", () => {
    const c = classifyFeedEvent({ ...sample("wait.removed"), source: "carrier-pigeon" });
    expect(c.kind).toBe("handle");
    if (c.kind === "handle") expect(c.event.source).toBe("carrier-pigeon");
  });
});

describe("what the fake Kiro Remote emits", () => {
  it("is accepted by the schemas, type by type", () => {
    const kiro = new FakeKiroRemote({ sessions: [{ id: "S1", title: "One", status: "running" }] });
    kiro.link("S1", "octo/repo#1", "harvest");
    kiro.startWaiting("S1", "octo/repo#7", "rest");
    kiro.emit({
      type: "link.state_changed",
      sessionId: "S1",
      pr: "octo/repo#1",
      payload: { from: "open", to: "merged" },
    });
    const wake = kiro.endWait("S1", "octo/repo#7", "merged");
    kiro.deliverWake("S1", wake as string);
    kiro.emit({
      type: "link.removed",
      sessionId: "S1",
      pr: "octo/repo#1",
      payload: { reason: "unlinked" },
    });
    kiro.emit({
      type: "wake.released",
      sessionId: "S1",
      pr: "octo/repo#7",
      payload: { ...PAYLOADS["wake.released"] },
    });
    kiro.emit({
      type: "wake.dropped",
      sessionId: "S1",
      pr: "octo/repo#7",
      payload: { ...PAYLOADS["wake.dropped"] },
    });
    expect(new Set(kiro.feed.map((e) => e.type)).size).toBe(FEED_TYPE_NAMES.length);
    for (const e of kiro.feed)
      expect(validator(`${e.type}.json`).safeParse(e).success, `${e.seq} ${e.type}`).toBe(true);
    expect(kiro.feed.map((e) => e.seq)).toEqual(kiro.feed.map((_, i) => i + 1));
  });
});
