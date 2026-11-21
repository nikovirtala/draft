import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DraftEvent, knownEvents } from "../src/events.ts";
import { FileLogStore, LogRefusedError } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { verifyLines } from "../src/verify.ts";
import { fakeKiro, openService } from "./fixtures.ts";
import { genesisDrafts, messageDraft, testClock } from "./helpers.ts";

async function logWithEvents(n = 3) {
  const dir = mkdtempSync(join(tmpdir(), "draft-torn-"));
  const path = join(dir, "log.jsonl");
  const log = FileLogStore.open(path, testClock());
  await log.append([
    ...genesisDrafts(),
    ...Array.from({ length: n }, (_, i) => messageDraft(`m${i}`, "user", `message ${i}`)),
  ]);
  log.close();
  return { dir, path };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sidecars = (dir: string) => readdirSync(dir).filter((f) => f.includes(".torn-"));

describe("a log whose last line was never completed", () => {
  it("opens: the bytes go to a sidecar, the log is cut, and a log.recovered event says so", async () => {
    const { dir, path } = await logWithEvents();
    const complete = readFileSync(path);
    // A write that stopped half way through an event, in the middle of a multi-byte character.
    const torn = Buffer.concat([
      Buffer.from('{"id":"01KAHX0000000000000000000A","at":"2026-11-20T12:00:00.000Z","text":"caf'),
      Buffer.from([0xc3]),
    ]);
    writeFileSync(path, Buffer.concat([complete, torn]));

    const log = FileLogStore.open(path, testClock());
    expect(log.recovery).not.toBeNull();
    const recovery = log.recovery as NonNullable<typeof log.recovery>;
    expect(recovery.bytes).toBe(torn.length);
    expect(recovery.hash).toBe(sha256(torn));

    // The sidecar sits next to the log and holds exactly the moved bytes.
    expect(sidecars(dir)).toEqual([recovery.sidecar]);
    expect(readFileSync(join(dir, recovery.sidecar)).equals(torn)).toBe(true);

    // The log is the complete lines plus one event that records the recovery.
    const events = knownEvents(log.events());
    const last = events.at(-1) as DraftEvent<"log.recovered">;
    expect(last.type).toBe("log.recovered");
    expect(last.data).toEqual({
      sidecar: recovery.sidecar,
      bytes: torn.length,
      hash: sha256(torn),
    });
    expect(last.conversation).toBeNull();
    expect(events.length).toBe(1 + 2 + 3);
    log.close();
    const onDisk = readFileSync(path);
    expect(onDisk.subarray(0, complete.length).equals(complete)).toBe(true);
    expect(onDisk.at(-1)).toBe(0x0a);
    expect(verifyLines(onDisk.toString("utf8").trimEnd().split("\n")).ok).toBe(true);

    // The next open is clean: nothing is recovered twice, and writing carries on.
    const again = FileLogStore.open(path, testClock(Date.UTC(2026, 10, 21)));
    expect(again.recovery).toBeNull();
    expect(sidecars(dir)).toHaveLength(1);
    await again.append([messageDraft("after", "user", "after the recovery")]);
    expect(knownEvents(again.events()).at(-1)?.type).toBe("message.posted");
    again.close();
    expect(FileLogStore.open(path).events()).toHaveLength(events.length + 1);
  });

  it("opens when the last line is a whole event that only lacks its newline", async () => {
    const { dir, path } = await logWithEvents(2);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.slice(0, -1));
    const log = FileLogStore.open(path);
    expect(log.recovery?.bytes).toBe(text.split("\n").at(-2)?.length);
    // It was never confirmed, so it isn't kept in the log.
    expect(knownEvents(log.events()).filter((e) => e.type === "message.posted")).toHaveLength(1);
    expect(sidecars(dir)).toHaveLength(1);
    log.close();
  });

  it("opens when the only line is half written, and the conversation starts after the recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-torn-"));
    const path = join(dir, "log.jsonl");
    writeFileSync(path, '{"id":"01KAHX00');
    const opened = await openService(dir, fakeKiro());
    expect(opened.log.recovery?.bytes).toBe('{"id":"01KAHX00'.length);
    const types = knownEvents(opened.log.events()).map((e) => e.type);
    expect(types).toEqual(["log.recovered", "context.created", "conversation.created"]);
    // The conversation shows it, and a projection rebuilt from the log shows it too.
    expect(opened.service.state().timeline.map((b) => b.kind)).toEqual(["notice"]);
    const rebuilt = Projection.open();
    rebuilt.rebuild(opened.log.events());
    expect(rebuilt.recoveries().map((r) => r.sidecar)).toEqual([opened.log.recovery?.sidecar]);
    opened.close();
  });

  it("is refused when anything before the last line is wrong", async () => {
    const torn = '{"id":"01KAHX00';
    const { path } = await logWithEvents(3);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");

    // A torn line in the middle.
    const middle = [...lines];
    middle[3] = middle[3]?.slice(0, 40) as string;
    writeFileSync(path, `${middle.join("\n")}\n`);
    expect(() => FileLogStore.open(path)).toThrow(LogRefusedError);
    expect(() => FileLogStore.open(path)).toThrow(/event 4.*not valid JSON/);

    // A torn line in the middle, and a torn last line as well.
    writeFileSync(path, `${middle.join("\n")}\n${torn}`);
    expect(() => FileLogStore.open(path)).toThrow(/event 4/);

    // An edited event.
    const edited = lines.map((l) => l.replace("message 1", "message one"));
    writeFileSync(path, `${edited.join("\n")}\n`);
    expect(() => FileLogStore.open(path)).toThrow(/changed after it was written/);
    writeFileSync(path, `${edited.join("\n")}\n${torn}`);
    expect(() => FileLogStore.open(path)).toThrow(/changed after it was written/);

    // A broken chain: an event removed.
    const removed = lines.filter((_, i) => i !== 3);
    writeFileSync(path, `${removed.join("\n")}\n`);
    expect(() => FileLogStore.open(path)).toThrow(/does not chain/);
    writeFileSync(path, `${removed.join("\n")}\n${torn}`);
    expect(() => FileLogStore.open(path)).toThrow(/does not chain/);
  });

  it("is refused, untouched, when the log can't be trusted: nothing is moved or cut", async () => {
    const { dir, path } = await logWithEvents(3);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const edited = lines.map((l) => l.replace("message 1", "message one"));
    const bytes = `${edited.join("\n")}\n{"id":"01KAHX00`;
    writeFileSync(path, bytes);
    expect(() => FileLogStore.open(path)).toThrow(LogRefusedError);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(dir) && sidecars(dir)).toEqual([]);
  });
});
