import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubClient } from "../src/github.ts";
import { READ_CACHE_MAX_BYTES, ReadCache } from "../src/read-cache.ts";

const sentEtag = (init: RequestInit | undefined): string | null =>
  ((init?.headers ?? {}) as Record<string, string>)["if-none-match"] ?? null;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the read cache", () => {
  it("keeps content by address, responses with their ETag and sources, across opens", () => {
    const path = join(dir, "cache.db");
    const a = new ReadCache(path);
    a.putBlob("abc", "text");
    a.putResponse("GET /x", '"e1"', '{"a":1}');
    a.putSource("feed:kiro", "cursor-9", "2026-11-24T06:00:00.000Z", "derived");
    a.close();

    const b = new ReadCache(path);
    expect(b.blob("abc")).toBe("text");
    expect(b.blob("missing")).toBeNull();
    expect(b.response("GET /x")).toEqual({ etag: '"e1"', body: '{"a":1}' });
    expect(b.source("feed:kiro")).toEqual({
      marker: "cursor-9",
      data: "derived",
      at: "2026-11-24T06:00:00.000Z",
    });
    b.close();
  });

  it("moves a source's time and marker without losing what was derived", () => {
    const c = ReadCache.memory();
    c.putSource("s", "m1", "t1", "data");
    c.putSource("s", "m2", "t2");
    expect(c.source("s")).toEqual({ marker: "m2", data: "data", at: "t2" });
  });

  it("drops the least recently used entries beyond its bound", () => {
    const c = ReadCache.memory({ maxBytes: 100 });
    c.putBlob("a", "x".repeat(30));
    c.putBlob("b", "x".repeat(30));
    c.putBlob("c", "x".repeat(30));
    expect(c.blob("a")).not.toBeNull(); // a is used again, so b is the oldest
    c.putBlob("d", "x".repeat(30));
    expect(c.blob("b")).toBeNull();
    expect(c.blob("a")).not.toBeNull();
    expect(c.blob("d")).not.toBeNull();
    expect(c.size).toBeLessThanOrEqual(100);
  });

  it("is bounded at 50 MB, and keeps nothing larger than that", () => {
    expect(READ_CACHE_MAX_BYTES).toBe(50 * 1024 * 1024);
    const c = ReadCache.memory({ maxBytes: 10 });
    c.putBlob("big", "x".repeat(11));
    expect(c.blob("big")).toBeNull();
  });

  it("starts again from a file that is not a database, and from one of an older shape", () => {
    const path = join(dir, "cache.db");
    writeFileSync(path, "not a database at all");
    const a = new ReadCache(path);
    a.putBlob("k", "v");
    expect(a.blob("k")).toBe("v");
    a.close();

    const other = join(dir, "old.db");
    const old = new DatabaseSync(other);
    old.exec("create table entries (junk text); pragma user_version = 0");
    old.close();
    const b = new ReadCache(other);
    b.putBlob("k", "v");
    expect(b.blob("k")).toBe("v");
    b.close();
  });

  it("never throws once it is closed: it remembers nothing", () => {
    const c = ReadCache.memory();
    c.close();
    c.putBlob("a", "b");
    expect(c.blob("a")).toBeNull();
    expect(c.source("s")).toBeNull();
    expect(c.working).toBe(false);
  });
});

describe("a client with a store", () => {
  it("asks with the ETag it kept in an earlier launch, and takes a 304 as the same answer", async () => {
    const seen: (string | null)[] = [];
    const answer: typeof fetch = async (_url, init) => {
      const sent = sentEtag(init);
      seen.push(sent);
      return sent === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify({ n: 1 }), { status: 200, headers: { etag: '"v1"' } });
    };
    const cache = new ReadCache(join(dir, "cache.db"));
    const first = new GithubClient({ token: null, fetch: answer, store: cache });
    expect(await first.getJson("/x")).toEqual({ n: 1 });
    const second = new GithubClient({ token: null, fetch: answer, store: cache });
    expect(await second.getJson("/x")).toEqual({ n: 1 });
    expect(seen).toEqual([null, '"v1"']);
    expect(second.notModified).toBe(1);
    cache.close();
  });

  it("reads a file named by its content without an ETag, and keeps nothing of it", async () => {
    const seen: (string | null)[] = [];
    const answer: typeof fetch = async (_url, init) => {
      seen.push(sentEtag(init));
      return new Response("text", { status: 200, headers: { etag: '"b"' } });
    };
    const cache = ReadCache.memory();
    const client = new GithubClient({ token: null, fetch: answer, store: cache });
    await client.getText("/blob", { immutable: true });
    await client.getText("/blob", { immutable: true });
    expect(seen).toEqual([null, null]);
    expect(cache.size).toBe(0);
  });
});
