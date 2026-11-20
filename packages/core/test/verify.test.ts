import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLogStore, LogRefusedError, MemoryLogStore } from "../src/log.ts";
import { verifyLines } from "../src/verify.ts";
import { genesisDrafts, messageDraft, testClock } from "./helpers.ts";

async function logWithFive() {
  const clock = testClock();
  const log = new MemoryLogStore(clock);
  await log.append(genesisDrafts());
  await log.append([messageDraft("m1", "user", "first"), messageDraft("m2", "agent", "second")]);
  await log.append([messageDraft("m3", "user", "third")]);
  return log;
}

describe("hash chain verify", () => {
  it("accepts an untouched chain", async () => {
    const log = await logWithFive();
    const r = verifyLines(log.lines);
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.length).toBe(5);
    expect(log.events()[1]?.prevHash).toBe(log.events()[0]?.hash);
  });

  it("names the one tampered event", async () => {
    const log = await logWithFive();
    const lines = [...log.lines];
    const e = JSON.parse(lines[3] as string);
    e.data.text = "second, rewritten";
    lines[3] = JSON.stringify(e);
    const r = verifyLines(lines);
    expect(r).toMatchObject({ ok: false, index: 3, id: e.id });
    expect(r.ok ? "" : r.reason).toMatch(/hash mismatch/);
  });

  it("names an event whose hash was recomputed after tampering, by its broken link", async () => {
    const log = await logWithFive();
    const lines = [...log.lines];
    const { eventHash } = await import("../src/events.ts");
    const e = JSON.parse(lines[2] as string);
    e.data.text = "rewritten";
    e.hash = eventHash(e);
    lines[2] = JSON.stringify(e);
    const r = verifyLines(lines);
    expect(r).toMatchObject({ ok: false, index: 3 });
    expect(r.ok ? "" : r.reason).toMatch(/previous hash mismatch/);
  });

  it("names a removed event by the gap it leaves", async () => {
    const log = await logWithFive();
    const lines = log.lines.filter((_, i) => i !== 2);
    expect(verifyLines(lines)).toMatchObject({ ok: false, index: 2 });
  });

  it("names a torn last line", async () => {
    const log = await logWithFive();
    const lines = [...log.lines.slice(0, 4), (log.lines[4] as string).slice(0, 40)];
    const r = verifyLines(lines);
    expect(r).toMatchObject({ ok: false, index: 4, id: null });
    expect(r.ok ? "" : r.reason).toMatch(/not valid JSON/);
  });

  it("refuses to open a tampered log file and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-log-"));
    const path = join(dir, "log.jsonl");
    const log = FileLogStore.open(path, testClock());
    await log.append(genesisDrafts());
    await log.append([messageDraft("m1", "user", "keep me")]);
    log.close();

    const reopened = FileLogStore.open(path);
    expect(reopened.events()).toHaveLength(3);
    reopened.close();

    writeFileSync(path, readFileSync(path, "utf8").replace("keep me", "changed"));
    const third = JSON.parse(readFileSync(path, "utf8").split("\n")[2] as string).id as string;
    expect(() => FileLogStore.open(path)).toThrow(LogRefusedError);
    expect(() => FileLogStore.open(path)).toThrow(
      `event 3 (${third}) was changed after it was written`,
    );
  });
});
