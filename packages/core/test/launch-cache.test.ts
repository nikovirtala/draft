import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOB_CONCURRENCY, FIRST_REFRESH_BLOBS } from "../src/ark-records.ts";
import { GithubClient } from "../src/github.ts";
import { foldMap, type MapSnapshot } from "../src/map.ts";
import { ArkMap } from "../src/map-ark.ts";
import { mapRegistry } from "../src/map-kinds.ts";
import { ReadCache } from "../src/read-cache.ts";
import {
  ARK_LEDGER,
  addLedgerEvent,
  DRAFT_LEDGER,
  FakeGithub,
  GITHUB_ENVIRONMENTS_RESPONSE,
  ledgerEvent,
  ledgerFileCount,
  ledgerId,
  seedLedger,
} from "../src/testing/index.ts";

/**
 * What a launch costs (ADR t76jn29d), counted against a fake GitHub that records every request:
 * the first launch with nothing stored, the second with what the first kept, and one with a single
 * new event file. The fixtures are the size of the ledgers of nikovirtala/draft and nikovirtala/ark.
 */

const DRAFT = "nikovirtala/draft";
const ARK = "nikovirtala/ark";
const REPOS = [DRAFT, ARK];
/** What one answer takes, as a network would: the cost of reading one file after another. */
const LATENCY_MS = 4;

let github: FakeGithub;
let dir: string;
const opened: { close(): void }[] = [];

beforeEach(async () => {
  github = await new FakeGithub().start();
  dir = mkdtempSync(join(tmpdir(), "draft-launch-"));
  seedLedger(github, DRAFT, DRAFT_LEDGER, "draft ");
  seedLedger(github, ARK, ARK_LEDGER, "ark ");
  for (const repo of REPOS) github.environments.set(repo, GITHUB_ENVIRONMENTS_RESPONSE);
});
afterEach(async () => {
  for (const o of opened.splice(0)) o.close();
  await github.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface LaunchOptions {
  /** Keep what is read in this file, across launches; none: nothing is kept. */
  cache?: boolean;
  token?: string | null;
  blobConcurrency?: number;
  firstRefreshBlobs?: number;
  maxBlobsPerRefresh?: number;
}

/** One launch of the app: a new client, a new map, and the cache file if there is one. */
function launch(o: LaunchOptions = {}) {
  const cache = o.cache === true ? new ReadCache(join(dir, "cache.db")) : undefined;
  if (cache !== undefined) opened.push(cache);
  const client = new GithubClient({
    token: o.token === undefined ? "t" : o.token,
    baseUrl: github.baseUrl,
    ...(cache === undefined ? {} : { store: cache }),
  });
  const registry = mapRegistry.fork();
  const ark = new ArkMap(registry, {
    github: client,
    repos: () => REPOS,
    intervalMs: 0,
    cacheKey: "context",
    ...(cache === undefined ? {} : { cache }),
    ...(o.blobConcurrency === undefined ? {} : { blobConcurrency: o.blobConcurrency }),
    ...(o.firstRefreshBlobs === undefined ? {} : { firstRefreshBlobs: o.firstRefreshBlobs }),
    ...(o.maxBlobsPerRefresh === undefined ? {} : { maxBlobsPerRefresh: o.maxBlobsPerRefresh }),
  });
  ark.setVisible("window", true);
  const map = (): MapSnapshot => foldMap([], registry, { sources: ark.sources() });
  return { ark, map, cache };
}

const isBlob = (path: string) => path.includes("/git/blobs/");
const blobRequests = (from = 0) => github.requests.slice(from).filter((r) => isBlob(r.path)).length;
const total = (m: MapSnapshot, kind: string) =>
  (m.rows.find((r) => r.kind === kind)?.cells ?? []).reduce((n, c) => n + c.count, 0);

/** Reads until every title is in, as the 30 s refresh does; returns what that cost. */
async function readAll(l: ReturnType<typeof launch>) {
  const from = github.requests.length;
  const started = performance.now();
  let refreshes = 0;
  do {
    await l.ark.tick();
    refreshes++;
  } while (l.ark.records.unfinished);
  return {
    refreshes,
    requests: github.requests.length - from,
    blobs: blobRequests(from),
    ms: Math.round(performance.now() - started),
  };
}

const files = ledgerFileCount(DRAFT_LEDGER) + ledgerFileCount(ARK_LEDGER);

describe("the sizes measured", () => {
  it("are those of draft's and ark's ledgers", () => {
    expect(ledgerFileCount(DRAFT_LEDGER)).toBe(212);
    expect(ledgerFileCount(ARK_LEDGER)).toBe(269);
  });
});

describe("the first launch, with nothing stored", () => {
  it("reads the ledgers several files at once, in one refresh, instead of one by one over several", async () => {
    github.latencyMs = LATENCY_MS;
    const before = await readAll(
      launch({ blobConcurrency: 1, firstRefreshBlobs: 100, maxBlobsPerRefresh: 100 }),
    );
    const peakBefore = github.peak;
    github.peak = 0;
    github.requests.length = 0;
    const l = launch();
    const after = await readAll(l);

    console.info(
      `first launch, ${files} event files in two repositories, ${LATENCY_MS} ms an answer\n` +
        `  sequential, 100 files a refresh: ${before.requests} requests in ${before.refreshes} refreshes, ${before.ms} ms\n` +
        `  ${BLOB_CONCURRENCY} at once, ${FIRST_REFRESH_BLOBS} files in the first refresh: ${after.requests} requests in ${after.refreshes} refresh, ${after.ms} ms`,
    );
    expect(peakBefore).toBe(1);
    expect(github.peak).toBeGreaterThan(1);
    expect(github.peak).toBeLessThanOrEqual(BLOB_CONCURRENCY);
    expect(before.refreshes).toBeGreaterThan(1);
    expect(after.refreshes).toBe(1);
    // The same files are read; only how they are read differs.
    expect(after.blobs).toBe(before.blobs);
    expect(after.ms).toBeLessThan(before.ms / 2);
    const m = l.map();
    expect(total(m, "decision")).toBe(DRAFT_LEDGER.decisions + ARK_LEDGER.decisions);
    expect(total(m, "issue")).toBe(DRAFT_LEDGER.issues + ARK_LEDGER.issues);
  });

  it("spends at most the first refresh's budget, and the rest at the pace of later refreshes", async () => {
    github.files.clear();
    seedLedger(github, DRAFT, { decisions: 200, issues: 200 });
    const l = launch();
    await l.ark.tick();
    expect(blobRequests()).toBe(FIRST_REFRESH_BLOBS);
    const from = github.requests.length;
    await l.ark.tick();
    expect(blobRequests(from)).toBe(100);
  });

  it("says a token is needed when it can't finish without one", async () => {
    github.rateLimited = 1000;
    const l = launch({ token: null });
    await l.ark.tick();
    const stale = l
      .map()
      .problems.map((p) => p.message)
      .join(" ");
    expect(stale).toContain("rate limit");
    expect(stale).toContain("a token is needed for the first load to finish");
  });
});

describe("the second launch", () => {
  it("shows the stored snapshot before any request completes, as of when it was read", async () => {
    await readAll(launch({ cache: true }));
    const first = github.requests.length;
    let release: () => void = () => {};
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const l = launch({ cache: true });
    const refresh = l.ark.tick();
    const m = l.map();
    expect(github.requests.slice(first).every((r) => r.status === null)).toBe(true);
    expect(total(m, "decision")).toBe(DRAFT_LEDGER.decisions + ARK_LEDGER.decisions);
    expect(total(m, "issue")).toBe(DRAFT_LEDGER.issues + ARK_LEDGER.issues);
    const stale = m.rows.find((r) => r.kind === "decision")?.stale ?? "";
    expect(stale).toMatch(/^as of 20\d\d-\d\d-\d\d \d\d:\d\d UTC/);
    expect(l.ark.records.snapshot().loading).toBe(false);

    release();
    await refresh;
    expect(l.map().rows.find((r) => r.kind === "decision")?.stale ?? null).toBeNull();
    expect(l.ark.records.snapshot().asOf).toBeNull();
  });

  it("asks only for what may have changed, each answered 304, and reads no file", async () => {
    github.latencyMs = LATENCY_MS;
    const first = await readAll(launch({ cache: true }));
    const from = github.requests.length;
    const started = performance.now();
    const l = launch({ cache: true });
    await l.ark.tick();
    const ms = Math.round(performance.now() - started);
    const second = github.requests.slice(from);

    console.info(
      `second launch: ${second.length} requests in ${ms} ms, ${blobRequests(from)} for files, all ${second.every((r) => r.status === 304) ? "304" : "not 304"}\n` +
        `  without the cache a second launch costs what the first did: ${first.requests} requests in ${first.ms} ms`,
    );
    expect(blobRequests(from)).toBe(0);
    expect(second.map((r) => r.status)).toEqual(second.map(() => 304));
    const kinds = second.map((r) => r.path.split("?")[0]?.split("/").slice(4).join("/"));
    expect(new Set(kinds)).toEqual(
      new Set(["git/trees/HEAD", "pulls", "deployments", "environments"]),
    );
    expect(second).toHaveLength(REPOS.length * 4);
  });

  it("without the cache starts over: every file is read again", async () => {
    const first = await readAll(launch());
    const from = github.requests.length;
    const again = await readAll(launch());
    expect(again.blobs).toBe(first.blobs);
    expect(blobRequests(from)).toBeGreaterThan(0);
  });

  it("reads exactly one file when one event file is new", async () => {
    await readAll(launch({ cache: true }));
    const record = ledgerId("d", 3);
    addLedgerEvent(
      github,
      DRAFT,
      ledgerEvent("docs/adr", record, 9999, 9, "linked", {
        to: ledgerId("d", 7),
        rel: "supersedes",
      }),
    );
    const from = github.requests.length;
    const l = launch({ cache: true });
    await l.ark.tick();

    expect(blobRequests(from)).toBe(1);
    const tree = github.requests.slice(from).find((r) => r.path.includes("/git/trees/HEAD"));
    expect(tree?.status).toBe(200);
    const adr = l.ark.records.snapshot().adrs.find((a) => a.repo === DRAFT && a.id === record);
    expect(adr?.links.map((x) => x.to)).toContain(ledgerId("d", 7));
  });
});

describe("deleting cache.db", () => {
  it("loses time and nothing else", async () => {
    const first = launch({ cache: true });
    await readAll(first);
    const shown = (l: ReturnType<typeof launch>) => {
      const { version: _v, readAt: _r, asOf: _a, ...rest } = l.ark.records.snapshot();
      return rest;
    };
    const before = shown(first);
    first.cache?.close();
    for (const f of ["cache.db", "cache.db-wal", "cache.db-shm"])
      rmSync(join(dir, f), { force: true });

    const from = github.requests.length;
    const l = launch({ cache: true });
    expect(l.ark.records.snapshot().adrs).toEqual([]);
    expect(l.ark.records.snapshot().loading).toBe(true);
    await readAll(l);
    expect(shown(l)).toEqual(before);
    expect(blobRequests(from)).toBe(blobRequests(0) / 2);
  });

  it("is not a problem when the file is garbage", async () => {
    writeFileSync(join(dir, "cache.db"), "this is not a database");
    const l = launch({ cache: true });
    await readAll(l);
    expect(total(l.map(), "decision")).toBe(DRAFT_LEDGER.decisions + ARK_LEDGER.decisions);
  });
});
