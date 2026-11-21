import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContextRegistry,
  LOCAL_CONTEXT,
  pathsOf,
  RegistryError,
  slugify,
} from "../src/main/contexts/registry.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "draft-registry-"));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("the context registry", () => {
  it("starts with the local context and leaves the files already there alone", () => {
    const dir = tmp();
    writeFileSync(join(dir, "log.jsonl"), '{"not":"touched"}\n');
    writeFileSync(join(dir, "device.db"), "device");
    const before = readdirSync(dir).sort();
    const log = sha(join(dir, "log.jsonl"));
    const registry = ContextRegistry.load(dir);
    expect(registry.list().map((e) => e.name)).toEqual([LOCAL_CONTEXT]);
    const local = registry.get(LOCAL_CONTEXT);
    expect(local).toMatchObject({ logContext: "local", dir: ".", folder: null });
    // The local context's files are exactly where they were; only the registry file is new.
    expect(pathsOf(dir, local as never)).toMatchObject({
      log: join(dir, "log.jsonl"),
      views: join(dir, "views.db"),
      device: join(dir, "device.db"),
      agentWorkspace: join(dir, "agent-workspace"),
    });
    expect(readdirSync(dir).sort()).toEqual([...before, "contexts.json"].sort());
    expect(sha(join(dir, "log.jsonl"))).toBe(log);
  });

  it("makes contexts under contexts/<name>/ with permanent, unique names", () => {
    const dir = tmp();
    const registry = ContextRegistry.load(dir);
    const a = registry.create({ name: registry.uniqueName("Long Play!") });
    expect(a.name).toBe("long-play");
    expect(pathsOf(dir, a).log).toBe(join(dir, "contexts", "long-play", "log.jsonl"));
    // A taken name is never reused: the next one is suffixed, and "local" is never handed out.
    expect(registry.uniqueName("long-play")).toBe("long-play-2");
    registry.create({ name: "long-play-2" });
    expect(registry.uniqueName("long-play")).toBe("long-play-3");
    expect(registry.uniqueName("local")).toBe("local-2");
    expect(() => registry.create({ name: "long-play" })).toThrow(RegistryError);
    expect(() => registry.create({ name: "local" })).toThrow(/exists already/);
    expect(() => registry.create({ name: "Not A Segment" })).toThrow(/can't be a context name/);
    expect(slugify("  ~/Code/Longplay.v2 ")).toBe("code-longplay-v2");
    expect(slugify("日本語")).toBe("context");
  });

  it("keeps folders, last activity and what was open across a restart", () => {
    const dir = tmp();
    const clock = () => "2026-11-21T10:00:00.000Z";
    const first = ContextRegistry.load(dir, clock);
    first.create({ name: "longplay", candidate: "/code/longplay" });
    first.setFolder("longplay", { folder: "/code/longplay" });
    first.touch("longplay", "2026-11-21T12:00:00.000Z");
    first.setOpen(["local", "longplay", "gone"]);
    first.flush();
    const second = ContextRegistry.load(dir, clock);
    expect(second.get("longplay")).toMatchObject({
      folder: "/code/longplay",
      candidate: null,
      lastActivity: "2026-11-21T12:00:00.000Z",
    });
    expect(second.byFolder("/code/longplay")?.name).toBe("longplay");
    expect(second.openAtLastExit()).toEqual(["local", "longplay"]);
    // The context used last is first in the list.
    expect(second.recent().map((e) => e.name)).toEqual(["longplay", "local"]);
  });

  it("finds a folder that was asked about but not trusted, so it isn't made again", () => {
    const registry = ContextRegistry.load(tmp());
    registry.create({ name: "x", candidate: "/code/x" });
    expect(registry.byFolder("/code/x")?.name).toBe("x");
    expect(registry.get("x")?.folder).toBeNull();
    registry.setFolder("x", { candidate: null });
    expect(registry.byFolder("/code/x")).toBeNull();
  });

  it("moves a registry it can't read aside and rebuilds the list from the directories", () => {
    const dir = tmp();
    mkdirSync(join(dir, "contexts", "longplay"), { recursive: true });
    writeFileSync(
      join(dir, "contexts", "longplay", "log.jsonl"),
      `${JSON.stringify({ address: "longplay@1" })}\n`,
    );
    writeFileSync(join(dir, "contexts.json"), "{ nope");
    const registry = ContextRegistry.load(dir);
    expect(registry.names().sort()).toEqual(["local", "longplay"]);
    expect(registry.get("longplay")?.logContext).toBe("longplay");
    expect(readdirSync(dir).some((f) => f.startsWith("contexts.json.broken-"))).toBe(true);
  });

  it("refuses a registry with two contexts of one name instead of picking one", () => {
    const dir = tmp();
    const e = {
      name: "a",
      title: "a",
      logContext: "a",
      dir: "contexts/a",
      folder: null,
      candidate: null,
      importedFrom: null,
      createdAt: "2026-11-21T10:00:00.000Z",
      lastActivity: null,
    };
    writeFileSync(
      join(dir, "contexts.json"),
      JSON.stringify({ version: 1, contexts: [e, e], open: [] }),
    );
    const registry = ContextRegistry.load(dir);
    expect(registry.names()).toEqual(["local"]);
  });
});
