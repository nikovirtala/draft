import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isUnknown, UnknownEvent } from "../src/events.ts";
import { FileLogStore, LogRefusedError } from "../src/log.ts";
import { appendRawLines } from "../src/testing/index.ts";
import { verifyLines } from "../src/verify.ts";
import { fakeKiro, openService } from "./fixtures.ts";

/** A conversation with one turn, written by this build, then closed. */
async function logWithOneTurn() {
  const dir = mkdtempSync(join(tmpdir(), "draft-unknown-"));
  const first = await openService(dir, fakeKiro());
  await first.service.submit("Which sessions are open?");
  const conversation = first.service.conversation;
  first.close();
  return { dir, path: join(dir, "log.jsonl"), conversation };
}

/** What a newer draft might write: a type this build has never heard of. */
const futureType = (conversation: string) => ({
  id: "01M8000000000000000000000A",
  at: "2027-03-01T09:00:00.000Z",
  address: `${conversation}/01m8000000000000000000000a@1`,
  conversation,
  type: "thread.summarized",
  schema: 1,
  actor: { kind: "agent", id: "draft-agent", model: "claude-opus-6", version: "9.9.9" },
  traceId: null,
  data: { summary: "A summary a future kind wrote", decisions: 3 },
  audience: ["someone-new"],
});

/** A known type at a schema version this build doesn't have yet. */
const newerSchema = (conversation: string) => ({
  id: "01M8000000000000000000000B",
  at: "2027-03-01T09:00:01.000Z",
  address: `${conversation}/01m8000000000000000000000b@1`,
  conversation,
  type: "message.posted",
  schema: 3,
  actor: { kind: "person", id: "01m8000000000000000000000c", handle: "@niko" },
  traceId: null,
  data: { role: "user", parts: [{ kind: "text", text: "a v2 message" }] },
});

describe("events this build doesn't understand", () => {
  it("are kept: the chain verifies over them, and they are read back as received", async () => {
    const { path, conversation } = await logWithOneTurn();
    const before = readFileSync(path, "utf8");
    writeFileSync(
      path,
      appendRawLines(before, [futureType(conversation), newerSchema(conversation)]),
    );
    const r = verifyLines(readFileSync(path, "utf8").trim().split("\n"));
    expect(r.ok).toBe(true);
    const unknown = r.ok ? r.events.filter(isUnknown) : [];
    expect(unknown.map((u) => [u.type, u.schema, u.reason])).toEqual([
      ["thread.summarized", 1, "unknown-type"],
      ["message.posted", 3, "newer-schema"],
    ]);
    expect(unknown[0]?.raw).toEqual(
      JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-2) as string),
    );
  });

  it("restore with the rest of the conversation and show as generic blocks", async () => {
    const { dir, path, conversation } = await logWithOneTurn();
    writeFileSync(
      path,
      appendRawLines(readFileSync(path, "utf8"), [
        futureType(conversation),
        newerSchema(conversation),
      ]),
    );
    rmSync(join(dir, "views.db"));
    const second = await openService(dir, fakeKiro());
    const state = second.service.state();
    expect(state.messages.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(state.timeline.map((b) => b.kind)).toEqual(["message", "message", "unknown", "unknown"]);
    expect(state.timeline[2]).toMatchObject({
      kind: "unknown",
      type: "thread.summarized",
      reason: "unknown-type",
    });
    expect(state.timeline[3]).toMatchObject({
      kind: "unknown",
      type: "message.posted",
      schema: 3,
      reason: "newer-schema",
    });
    // The newer message is not read as a message of this build.
    expect(state.messages.some((m) => m.text.includes("a v2 message"))).toBe(false);
    expect(second.projection.unknownCount()).toBe(2);

    // This build keeps appending after them, and the chain still verifies.
    await second.service.submit("And now?");
    second.close();
    const third = FileLogStore.open(path);
    expect(third.events().filter((e) => e instanceof UnknownEvent)).toHaveLength(2);
    expect(third.events().at(-1)?.type).toBe("message.posted");
    third.close();
  });

  it("are still refused when tampered with", async () => {
    const { path, conversation } = await logWithOneTurn();
    const text = appendRawLines(readFileSync(path, "utf8"), [futureType(conversation)]);
    writeFileSync(path, text.replace("A summary a future kind wrote", "A different summary"));
    expect(() => FileLogStore.open(path)).toThrow(/was changed after it was written/);
  });

  it("don't excuse a known type whose data fails its schema", async () => {
    const { path, conversation } = await logWithOneTurn();
    const bad = {
      ...newerSchema(conversation),
      schema: 1,
      actor: { kind: "user", id: "u", name: "U" },
    };
    writeFileSync(path, appendRawLines(readFileSync(path, "utf8"), [bad]));
    expect(() => FileLogStore.open(path)).toThrow(LogRefusedError);
    expect(() => FileLogStore.open(path)).toThrow(/is invalid: data/);
  });

  it("refuse a record without the chain fields", async () => {
    const { path } = await logWithOneTurn();
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({ type: "x" })}\n`);
    expect(() => FileLogStore.open(path)).toThrow(/is invalid: not an event record/);
  });
});
