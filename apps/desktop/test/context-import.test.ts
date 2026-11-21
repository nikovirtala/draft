import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogStore, Projection, readLogRecords, Workspace } from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { ImportError, importDataDir, workspaceLink } from "../src/main/contexts/import.ts";
import { ContextRegistry, pathsOf } from "../src/main/contexts/registry.ts";
import { USER } from "./acp-helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "draft-import-"));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A data directory as an older draft left it: one log of the context "local". */
async function oldSetup(opts: { link?: string } = {}): Promise<string> {
  const dir = tmp();
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const agent = {
    id: "fake",
    model: "m",
    version: "1",
    async *runTurn() {
      yield { type: "text-delta" as const, text: "Hello." };
      yield { type: "done" as const, text: "Hello.", usage: null, model: "m" };
    },
    closeConversation() {},
    async close() {},
  };
  const workspace = await Workspace.open({ log, projection, agent, resolvers: [], user: USER });
  await workspace.main.submit("What was I doing in longplay?");
  await workspace.close();
  log.close();
  projection.close();
  if (opts.link !== undefined) symlinkSync(opts.link, join(dir, "agent-workspace"));
  return dir;
}

describe("importing a DRAFT_DATA_DIR setup", () => {
  it("copies the log byte for byte, leaves the old directory alone, and keeps the log's own context name", async () => {
    const project = tmp();
    const old = await oldSetup({ link: project });
    const before = sha(join(old, "log.jsonl"));
    const data = tmp();
    const registry = ContextRegistry.load(data);

    const result = importDataDir(registry, data, old);
    expect(result.created).toBe(true);
    // The log says "local" in every address, as it always did; this device calls it by a new name.
    expect(result.entry.logContext).toBe("local");
    expect(result.entry.name).not.toBe("local");
    expect(registry.names()).toContain("local");
    const copy = pathsOf(data, result.entry).log;
    expect(sha(copy)).toBe(before);
    expect(sha(join(old, "log.jsonl"))).toBe(before);
    expect(readLogRecords(copy).ok).toBe(true);
    // The link's target is offered, not bound: binding is the trust step's.
    expect(result.folder).toBe(workspaceLink(old));
    expect(result.entry.folder).toBeNull();
  });

  it("finds a setup that was imported before instead of copying it again", async () => {
    const old = await oldSetup();
    const data = tmp();
    const registry = ContextRegistry.load(data);
    const first = importDataDir(registry, data, old);
    const again = importDataDir(registry, data, old);
    expect(again.created).toBe(false);
    expect(again.entry.name).toBe(first.entry.name);
    expect(registry.list()).toHaveLength(2);
    expect(workspaceLink(old)).toBeNull();
  });

  it("refuses a log whose chain doesn't verify, and what isn't a data directory", async () => {
    const old = await oldSetup();
    const lines = readFileSync(join(old, "log.jsonl"), "utf8").split("\n");
    lines[1] = lines[1]?.replace('"title":"Conversation"', '"title":"Changed"') ?? "";
    writeFileSync(join(old, "log.jsonl"), lines.join("\n"));
    const data = tmp();
    const registry = ContextRegistry.load(data);
    expect(() => importDataDir(registry, data, old)).toThrow(/doesn't verify/);
    expect(registry.list()).toHaveLength(1);
    expect(() => importDataDir(registry, data, tmp())).toThrow(/no log.jsonl/);
    expect(() => importDataDir(registry, data, join(data, "nope"))).toThrow(ImportError);
    expect(() => importDataDir(registry, data, data)).toThrow(/own data directory/);
  });

  it("copies a log with a half-written last line as it is; opening it will move the line aside", async () => {
    const old = await oldSetup();
    appendFileSync(join(old, "log.jsonl"), '{"id":"torn');
    const before = sha(join(old, "log.jsonl"));
    const data = tmp();
    const registry = ContextRegistry.load(data);
    const { entry } = importDataDir(registry, data, old);
    expect(sha(pathsOf(data, entry).log)).toBe(before);
  });
});
