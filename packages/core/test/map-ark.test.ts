import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubClient } from "../src/github.ts";
import { foldMap, KindRegistry, type MapSnapshot } from "../src/map.ts";
import { ArkMap } from "../src/map-ark.ts";
import { mapRegistry } from "../src/map-kinds.ts";
import {
  ADR_IDS,
  ARK_FIXTURE_START,
  ARK_PULL,
  ARK_REPO,
  FakeGithub,
  ISSUE_IDS,
  seedArk,
} from "../src/testing/index.ts";

let github: FakeGithub;
let clock = Date.UTC(2026, 10, 22, 12, 0, 0);

beforeEach(async () => {
  github = await new FakeGithub().start();
  clock = Date.UTC(2026, 10, 22, 12, 0, 0);
});
afterEach(async () => {
  await github.stop();
});

function open(repos: string[] = [ARK_REPO]) {
  const client = new GithubClient({ token: "t", baseUrl: github.baseUrl, now: () => clock });
  const registry = mapRegistry.fork();
  const ark = new ArkMap(registry, {
    github: client,
    repos: () => repos,
    intervalMs: 0,
    now: () => clock,
  });
  ark.setVisible("window", true);
  const map = (): MapSnapshot => foldMap([], registry, { sources: ark.sources() });
  return { client, registry, ark, map };
}

const row = (m: MapSnapshot, kind: string) => m.rows.find((r) => r.kind === kind);
const counts = (m: MapSnapshot, kind: string) =>
  Object.fromEntries(
    (row(m, kind)?.cells ?? []).filter((c) => c.count > 0).map((c) => [c.column, c.count]),
  );
const waiting = (m: MapSnapshot, kind: string) =>
  Object.fromEntries(
    (row(m, kind)?.cells ?? [])
      .filter((c) => c.waitingOnPerson > 0)
      .map((c) => [c.column, c.waitingOnPerson]),
  );
const paths = (r: FakeGithub["requests"], from = 0) =>
  r.slice(from).map((x) => x.path.split("?")[0] as string);
const blobs = (r: FakeGithub["requests"], from = 0) =>
  paths(r, from).filter((p) => p.includes("/git/blobs/")).length;

describe("the ark kinds on the map", () => {
  it("shows every decision by the state adr folds it to, one of them only on a pull request", async () => {
    seedArk(github);
    const { ark, map } = open();
    await ark.tick();
    const m = map();
    expect(counts(m, "decision")).toEqual({
      proposed: 2,
      accepted: 1,
      rejected: 1,
      withdrawn: 1,
      deprecated: 1,
      superseded: 1,
    });
    expect(row(m, "decision")?.columns.map((c) => c.id)).toEqual([
      "proposed",
      "accepted",
      "rejected",
      "withdrawn",
      "deprecated",
      "superseded",
    ]);
    // Proposed waits on the person; the rest is over.
    expect(waiting(m, "decision")).toEqual({ proposed: 2 });
    const proposed = row(m, "decision")?.cells.find((c) => c.column === "proposed")?.items;
    const branch = proposed?.find((i) => i.id.endsWith(ADR_IDS.onBranch));
    expect(branch?.label).toBe("Show ark records on the map · draft");
    expect(branch?.open).toEqual({
      kind: "links",
      links: [
        {
          label: "Decision",
          url: `https://github.com/${ARK_REPO}/tree/adr-ark-records/docs/adr/events/${ADR_IDS.onBranch}`,
        },
        {
          label: `Pull request #${ARK_PULL}`,
          url: `https://github.com/${ARK_REPO}/pull/${ARK_PULL}`,
        },
      ],
    });
    // The decision on the default branch links to its files there.
    const main = proposed?.find((i) => i.id.endsWith(ADR_IDS.proposed));
    expect(main?.open).toMatchObject({ links: [{ url: expect.stringContaining("/tree/HEAD/") }] });
  });

  it("follows a decision through the states its events moved it to, with their times", async () => {
    seedArk(github);
    const { ark, map } = open();
    await ark.tick();
    const t = map()
      .transitions.filter((x) => x.item.endsWith(ADR_IDS.superseded))
      .map((x) => [x.from, x.to, x.at]);
    const at = (minute: number) => new Date(ARK_FIXTURE_START + minute * 60_000).toISOString();
    expect(t).toEqual([
      [null, "proposed", at(3)],
      ["proposed", "accepted", at(4)],
      ["accepted", "superseded", at(5)],
    ]);
  });

  it("shows every issue, and says how a closed one was closed in its cell", async () => {
    seedArk(github);
    const { ark, map } = open();
    await ark.tick();
    const m = map();
    expect(counts(m, "issue")).toEqual({ open: 2, "in-progress": 1, closed: 3 });
    expect(row(m, "issue")?.columns.map((c) => c.id)).toEqual(["open", "in-progress", "closed"]);
    const closed = row(m, "issue")?.cells.find((c) => c.column === "closed");
    expect(closed?.notes).toEqual([
      { note: "done", count: 1 },
      { note: "obsolete", count: 1 },
      { note: "wontfix", count: 1 },
    ]);
    // A reopened issue is open again and carries no resolution.
    const reopened = row(m, "issue")?.cells[0]?.items.find((i) =>
      i.id.endsWith(ISSUE_IDS.reopened),
    );
    expect(reopened).toMatchObject({ state: "open", note: null });
    expect(waiting(m, "issue")).toEqual({});
  });

  it("makes a row for each repository and environment, from the latest status", async () => {
    seedArk(github);
    const { ark, map, registry } = open();
    await ark.tick();
    const m = map();
    expect(m.rows.filter((r) => r.kind.startsWith("deployment:")).map((r) => r.kind)).toEqual([
      `deployment:${ARK_REPO}:production`,
      `deployment:${ARK_REPO}:staging`,
    ]);
    expect(counts(m, `deployment:${ARK_REPO}:production`)).toEqual({ success: 1, inactive: 1 });
    expect(counts(m, `deployment:${ARK_REPO}:staging`)).toEqual({ failure: 1 });
    // A failed run freezes the pipeline until a person acts: it waits on them.
    expect(waiting(m, `deployment:${ARK_REPO}:staging`)).toEqual({ failure: 1 });
    expect(waiting(m, `deployment:${ARK_REPO}:production`)).toEqual({});
    // An item opens the deployment's commit and its run.
    const failed = row(m, `deployment:${ARK_REPO}:staging`)?.cells.find(
      (c) => c.column === "failure",
    );
    expect(failed?.items[0]?.open).toEqual({
      kind: "links",
      links: [
        { label: "Commit", url: `https://github.com/${ARK_REPO}/commit/${"3".repeat(40)}` },
        { label: "Run", url: "https://github.com/nikovirtala/draft/actions/runs/3" },
      ],
    });
    // These rows are this workspace's own: another context doesn't get them.
    expect(mapRegistry.list().some((k) => k.id.startsWith("deployment:"))).toBe(false);
    expect(registry.list().some((k) => k.id === "decision")).toBe(true);
    expect(mapRegistry.list().some((k) => k.id === "decision")).toBe(false);
  });

  it("marks a deployment's moves as arrows: queued, in progress, succeeded, inactive", async () => {
    seedArk(github);
    const { ark, map } = open();
    await ark.tick();
    const path = map()
      .transitions.filter((t) => t.kind.endsWith(":production") && t.item === "101")
      .map((t) => `${t.from}>${t.to}`);
    expect(path).toEqual([
      "null>queued",
      "queued>in_progress",
      "in_progress>success",
      "success>inactive",
    ]);
  });

  it("has no rows for a repository with no ark records", async () => {
    github.addFiles("someone/else", "main", { "README.md": "hello" });
    const { ark, map } = open(["someone/else"]);
    await ark.tick();
    const m = map();
    expect(m.rows.filter((r) => /^(decision|issue|deployment)/.test(r.kind))).toEqual([]);
    expect(m.problems).toEqual([]);
  });

  it("says when a repository can't be read, instead of showing nothing as if it were empty", async () => {
    const { ark, map } = open(["someone/missing"]);
    await ark.tick();
    const problems = map().problems;
    expect(problems.map((p) => p.kind).sort()).toEqual(["decision", "issue"]);
    expect(problems.every((p) => p.message.includes("someone/missing is not there"))).toBe(true);
  });

  it("says it is still reading before the first read ends", () => {
    seedArk(github);
    const { map } = open();
    expect(
      map()
        .problems.map((p) => p.kind)
        .sort(),
    ).toEqual(["decision", "issue"]);
    expect(map().problems[0]?.message).toContain("still reading");
  });

  it("reads nothing while no map is on screen", async () => {
    seedArk(github);
    const { ark } = open();
    ark.setVisible("window", false);
    expect(await ark.tick()).toBe(false);
    expect(github.requests).toHaveLength(0);
  });
});

describe("what a refresh costs", () => {
  it("reads one tree per repository, each file once, and nothing when the tree is the same", async () => {
    seedArk(github);
    const { ark, client, map } = open();

    // The first read: the default tree, the open pull requests and the one head that adds
    // something, every title and resolution once, the deployments and their statuses.
    expect(await ark.tick()).toBe(true);
    const first = paths(github.requests);
    expect(first.filter((p) => p.includes("/git/trees/"))).toEqual([
      `/repos/${ARK_REPO}/git/trees/HEAD`,
      `/repos/${ARK_REPO}/git/trees/${"9".repeat(40)}`,
    ]);
    // 7 decisions + 6 issues to name, and 3 closed issues to say how.
    expect(blobs(github.requests)).toBe(16);
    expect(first.filter((p) => p.endsWith("/statuses"))).toHaveLength(3);
    expect(first).toHaveLength(23);
    expect(client.requests).toBe(23);
    const before = github.requests.length;

    // Nothing moved: three conditional requests, all answered "not modified", no file fetched.
    const notModified = client.notModified;
    expect(await ark.tick()).toBe(false);
    const again = paths(github.requests, before);
    expect(again).toEqual([
      `/repos/${ARK_REPO}/git/trees/HEAD`,
      `/repos/${ARK_REPO}/pulls`,
      `/repos/${ARK_REPO}/deployments`,
    ]);
    expect(client.notModified - notModified).toBe(3);
    expect(blobs(github.requests, before)).toBe(0);
    expect(counts(map(), "issue")).toEqual({ open: 2, "in-progress": 1, closed: 3 });
  });

  it("fetches only the file whose blob sha is new when the tree moved", async () => {
    seedArk(github);
    const { ark, client, map } = open();
    await ark.tick();
    const before = github.requests.length;
    // A new issue lands on the default branch.
    const main = github.files.get(ARK_REPO)?.get("main") as Map<string, string>;
    main.set(
      "docs/issues/events/b0000009/20261120T100000Z-0001-opened.yaml",
      "envelope: ledger/v1\nsubject: b0000009\ntype: opened\ndata:\n  title: A new one\n",
    );
    expect(await ark.tick()).toBe(true);
    const moved = paths(github.requests, before);
    // The tree is read again (it changed); the open pull request's head is not (its sha is the same).
    expect(moved.filter((p) => p.includes("/git/trees/"))).toEqual([
      `/repos/${ARK_REPO}/git/trees/HEAD`,
    ]);
    expect(blobs(github.requests, before)).toBe(1);
    expect(counts(map(), "issue")).toEqual({ open: 3, "in-progress": 1, closed: 3 });
    expect(client.requests).toBe(github.requests.length);
  });

  it("asks again for a deployment that is moving, and for a success a newer run may have made inactive", async () => {
    seedArk(github);
    const { ark, map } = open();
    await ark.tick();
    const before = github.requests.length;
    github.addDeployment(ARK_REPO, {
      id: 104,
      sha: "4".repeat(40),
      ref: "main",
      environment: "production",
      createdAt: new Date(clock).toISOString(),
      statuses: [{ state: "in_progress", at: new Date(clock).toISOString() }],
    });
    await ark.tick();
    const asked = paths(github.requests, before).filter((p) => p.endsWith("/statuses"));
    // The new one, and the success that may have become inactive; not the failure, not the inactive one.
    expect(asked.sort()).toEqual([
      `/repos/${ARK_REPO}/deployments/102/statuses`,
      `/repos/${ARK_REPO}/deployments/104/statuses`,
    ]);
    expect(counts(map(), `deployment:${ARK_REPO}:production`)).toEqual({
      in_progress: 1,
      success: 1,
      inactive: 1,
    });
    // A moving deployment is asked about on every refresh until it settles.
    const next = github.requests.length;
    await ark.tick();
    expect(paths(github.requests, next).filter((p) => p.endsWith("/statuses"))).toEqual([
      `/repos/${ARK_REPO}/deployments/104/statuses`,
    ]);
  });
});

describe("GitHub's rate limit", () => {
  it("is reported where the counts are, the old counts stay, and nothing is asked until it resets", async () => {
    seedArk(github);
    const { ark, map } = open();
    await ark.tick();
    const had = counts(map(), "decision");
    const main = github.files.get(ARK_REPO)?.get("main") as Map<string, string>;
    main.set(
      "docs/issues/events/b0000009/20261120T100000Z-0001-opened.yaml",
      "envelope: ledger/v1\nsubject: b0000009\ntype: opened\ndata:\n  title: A new one\n",
    );
    github.rateLimited = 1;
    await ark.tick();
    const m = map();
    // What was read before is still what is drawn, and the row says it is from before.
    expect(counts(m, "decision")).toEqual(had);
    expect(row(m, "decision")?.stale).toContain("rate limit is used up");
    expect(row(m, "issue")?.stale).toContain("from before");
    expect(m.problems.map((p) => p.kind).sort()).toEqual(
      expect.arrayContaining(["decision", "issue", `deployment:${ARK_REPO}:production`]),
    );
    // Not asked again while GitHub says wait.
    const before = github.requests.length;
    expect(await ark.tick()).toBe(false);
    expect(github.requests.length).toBe(before);
    // After the reset it reads again, and the new issue shows, no longer stale.
    clock += 2000;
    expect(await ark.tick()).toBe(true);
    const later = map();
    expect(row(later, "issue")?.stale).toBeNull();
    expect(counts(later, "issue")).toEqual({ open: 3, "in-progress": 1, closed: 3 });
  });
});

describe("a registry of its own", () => {
  it("is how a context gets these rows: the same fold, no map code", () => {
    const registry = new KindRegistry();
    new ArkMap(registry, {
      github: new GithubClient({ token: null, baseUrl: github.baseUrl }),
      repos: () => [],
    });
    expect(registry.list().map((k) => k.id)).toEqual(["decision", "issue"]);
    expect(foldMap([], registry).rows).toEqual([]);
  });
});
