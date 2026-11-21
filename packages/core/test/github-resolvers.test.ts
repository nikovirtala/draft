import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ArkIssueResolver, dataField } from "../src/ark-issue.ts";
import { ArtifactPageResolver } from "../src/artifact-page.ts";
import type { Target } from "../src/events.ts";
import { GithubClient, GithubError, githubNote, resolveGithubAuth } from "../src/github.ts";
import { PullRequestResolver } from "../src/pull-request.ts";
import { type Resolver, StubPoller } from "../src/resolver.ts";
import { FakeGithub } from "../src/testing/index.ts";

const REPO = "nikovirtala/draft";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function github() {
  const fake = await new FakeGithub().start();
  cleanup.push(() => fake.stop());
  const client = new GithubClient({ token: "t0ken", baseUrl: fake.baseUrl });
  return { fake, client };
}

describe("how draft reaches GitHub", () => {
  it("uses GITHUB_TOKEN first, then gh, otherwise none", async () => {
    const calls: string[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push(`${file} ${args.join(" ")}`);
      return "from-gh\n";
    };
    expect(await resolveGithubAuth({ GITHUB_TOKEN: " from-env " }, exec)).toEqual({
      token: "from-env",
      source: "env",
    });
    expect(calls).toEqual([]);
    expect(await resolveGithubAuth({}, exec)).toEqual({ token: "from-gh", source: "gh" });
    expect(calls).toEqual(["gh auth token"]);
    const none = await resolveGithubAuth({}, async () => {
      throw new Error("gh: not found");
    });
    expect(none).toEqual({ token: null, source: "none" });
    expect(await resolveGithubAuth({}, async () => "  \n")).toEqual({
      token: null,
      source: "none",
    });
  });

  it("says so plainly when it has no token, and says nothing about a token it has", () => {
    expect(githubNote({ token: null, source: "none" })).toMatch(
      /no GitHub token.*public repositories/,
    );
    expect(githubNote({ token: null, source: "none" })).toMatch(/only reads/);
    expect(githubNote({ token: "x", source: "env" })).toBeNull();
    expect(githubNote({ token: "x", source: "gh" })).toBeNull();
  });

  it("sends the token as a bearer, and only ever GETs", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 1);
    await client.getJson(`/repos/${REPO}/pulls/1`);
    expect(fake.requests.map((r) => [r.method, r.authorization])).toEqual([
      ["GET", "Bearer t0ken"],
    ]);
    const anon = new GithubClient({ token: null, baseUrl: fake.baseUrl });
    await anon.getJson(`/repos/${REPO}/pulls/1`);
    expect(fake.requests.at(-1)?.authorization).toBeNull();
    // There is no method to write with.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client)).sort()).toEqual([
      "authenticated",
      "constructor",
      "getJson",
      "getText",
      "request",
      "retryAfter",
    ]);
  });

  it("asks again with the ETag it saw, so an unchanged resource costs nothing", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 1);
    const a = await client.getJson(`/repos/${REPO}/pulls/1`);
    const b = await client.getJson(`/repos/${REPO}/pulls/1`);
    expect(b).toEqual(a);
    expect(client.notModified).toBe(1);
    fake.updatePull(REPO, 1, { title: "Changed" });
    expect(await client.getJson<{ title: string }>(`/repos/${REPO}/pulls/1`)).toMatchObject({
      title: "Changed",
    });
  });

  it("reports a missing resource as null, and a rate limit with when to come back", async () => {
    const { fake, client } = await github();
    expect(await client.getJson(`/repos/${REPO}/pulls/404`)).toBeNull();
    fake.rateLimited = 1;
    const err = await client.getJson(`/repos/${REPO}/pulls/1`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err).toMatchObject({ status: 403, retryAfterMs: 1000 });
  });
});

describe("the pull request resolver", () => {
  it("finds pull requests by link and by owner/repo#number, once each", () => {
    const r = new PullRequestResolver(new GithubClient({ token: null }));
    expect(
      r.detect(
        "see https://github.com/nikovirtala/draft/pull/12, and nikovirtala/draft#12, also nikovirtala/ark#3.",
      ),
    ).toEqual(["nikovirtala/draft/pull/12", "nikovirtala/ark/pull/3"]);
    expect(r.detect("issue #4 and a/b/c#9 and v1.2#3 and path/to/file#12x")).toEqual([]);
    expect(r.detect("github.com/o/r/pull/7/files")).toEqual(["o/r/pull/7"]);
  });

  it("carries check runs with conclusions, review state and mergeability", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 7, {
      title: "Add resolvers",
      draft: true,
      checks: [
        { name: "typecheck", conclusion: "success" },
        { name: "e2e", conclusion: "failure" },
        { name: "lint", status: "in_progress" },
        { name: "docs", conclusion: "skipped" },
      ],
      statuses: [{ context: "ci/legacy", state: "failure" }],
      mergeable: false,
      mergeableState: "dirty",
      reviews: [
        { id: 1, user: "a", state: "APPROVED" },
        { id: 2, user: "b", state: "CHANGES_REQUESTED" },
        { id: 3, user: "b", state: "COMMENTED" },
        { id: 4, user: "c", state: "CHANGES_REQUESTED" },
        { id: 5, user: "c", state: "DISMISSED" },
      ],
      requestedReviewers: ["niko", "z"],
    });
    const r = new PullRequestResolver(client, async () => "niko");
    const state = (await r.fetch(`${REPO}/pull/7`)) as Record<string, unknown>;
    expect(state).toMatchObject({
      repo: REPO,
      number: 7,
      title: "Add resolvers",
      state: "open",
      draft: true,
      mergeable: false,
      mergeableState: "dirty",
      checksSummary: { total: 5, passed: 2, failed: 2, pending: 1 },
      review: {
        decision: "changes_requested",
        reviews: [
          { user: "a", state: "APPROVED", id: 1 },
          { user: "b", state: "CHANGES_REQUESTED", id: 2 },
        ],
        requested: ["niko", "z"],
      },
      viewerReviewRequested: true,
    });
    expect(
      (state.checks as { name: string; conclusion: string | null }[]).map((c) => [
        c.name,
        c.conclusion,
      ]),
    ).toEqual([
      ["ci/legacy", "failure"],
      ["docs", "skipped"],
      ["e2e", "failure"],
      ["lint", null],
      ["typecheck", "success"],
    ]);
  });

  it("is missing when GitHub doesn't know it, and is merged once merged", async () => {
    const { fake, client } = await github();
    const r = new PullRequestResolver(client);
    expect(await r.fetch(`${REPO}/pull/1`)).toBeNull();
    fake.addPull(REPO, 1, { state: "closed", merged: true });
    expect(await r.fetch(`${REPO}/pull/1`)).toMatchObject({
      state: "merged",
      viewerReviewRequested: false,
    });
    expect(await r.fetch("not-an-id")).toBeNull();
  });

  it("raises each failing check, a conflict, requested changes and a review requested; nothing for a closed PR", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 7, {
      checks: [
        { name: "e2e", conclusion: "failure" },
        { name: "build", conclusion: "timed_out" },
        { name: "ok", conclusion: "success" },
        { name: "cancelled", conclusion: "cancelled" },
      ],
      mergeableState: "dirty",
      reviews: [{ id: 9, user: "r", state: "CHANGES_REQUESTED" }],
      requestedReviewers: ["niko"],
    });
    const r = new PullRequestResolver(client, async () => "niko");
    const target: Target = { type: "pull-request", id: `${REPO}/pull/7` };
    const state = (await r.fetch(target.id)) as Record<string, unknown>;
    const out = r.interrupts(target, state);
    expect(out.map((i) => [i.kind, i.detail.check ?? null])).toEqual([
      ["failed-check", "build"],
      ["failed-check", "e2e"],
      ["merge-conflict", null],
      ["changes-requested", null],
      ["review-requested", null],
    ]);
    // Keys name what they are about, so the same thing is the same interrupt next time.
    expect(new Set(out.map((i) => i.key)).size).toBe(5);
    expect(r.interrupts(target, state)).toEqual(out);
    expect(r.interrupts(target, { ...state, state: "closed" })).toEqual([]);
    expect(r.interrupts(target, { ...state, state: "merged" })).toEqual([]);
  });

  it("changes its state, so a status event, only when something changes", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 7, { checks: [{ name: "e2e", status: "in_progress" }] });
    const r = new PullRequestResolver(client);
    const a = await r.fetch(`${REPO}/pull/7`);
    expect(await r.fetch(`${REPO}/pull/7`)).toEqual(a);
    fake.updatePull(REPO, 7, { checks: [{ name: "e2e", conclusion: "failure" }] });
    expect(await r.fetch(`${REPO}/pull/7`)).not.toEqual(a);
  });
});

describe("the ark issue resolver", () => {
  const sources = { draft: REPO, ark: "nikovirtala/ark" };

  it("finds qualified ids by source name, and links to an issue's files", () => {
    const r = new ArkIssueResolver(new GithubClient({ token: null }), { sources });
    expect(
      r.detect(
        "draft:15cxvdep blocks ark:rydjwgb1; other:0act2kg7, draft:15cxvdep, and draft:notanid1 or draft:15cxvdepx. https://github.com/nikovirtala/draft/blob/main/docs/issues/items/0act2kg7-return-a-threads.md",
      ),
    ).toEqual([`${REPO}:15cxvdep`, "nikovirtala/ark:rydjwgb1", `${REPO}:0act2kg7`]);
    expect(r.detect("an unqualified 15cxvdep")).toEqual([]);
  });

  it("folds the event files into a status, a title and, once closed, a resolution", async () => {
    const { fake, client } = await github();
    fake.addIssue(REPO, "15cxvdep", [
      {
        stamp: "20261120T202043Z",
        type: "opened",
        data: { title: "Add resolvers", template: "task" },
      },
      { stamp: "20261120T202044Z", type: "labeled" },
      { stamp: "20261121T080000Z", type: "started" },
    ]);
    const r = new ArkIssueResolver(client, { sources });
    const id = `${REPO}:15cxvdep`;
    expect(await r.fetch(id)).toMatchObject({
      repo: REPO,
      id: "15cxvdep",
      title: "Add resolvers",
      status: "in-progress",
      resolution: null,
      eventCount: 3,
      events: [
        { type: "opened", at: "2026-11-20T20:20:43Z" },
        { type: "labeled", at: "2026-11-20T20:20:44Z" },
        { type: "started", at: "2026-11-21T08:00:00Z" },
      ],
    });
    fake.addIssue(REPO, "15cxvdep", [
      ...(fake.issues.get(`${id}`) ?? []),
      { stamp: "20261121T090000Z", type: "stopped" },
      { stamp: "20261121T100000Z", type: "closed", data: { resolution: "done" } },
    ]);
    expect(await r.fetch(id)).toMatchObject({
      status: "closed",
      resolution: "done",
      eventCount: 5,
    });
    fake.addIssue(REPO, "15cxvdep", [
      ...(fake.issues.get(id) ?? []),
      { stamp: "20261122T100000Z", type: "reopened" },
    ]);
    expect(await r.fetch(id)).toMatchObject({ status: "open", resolution: null });
    expect(await r.fetch(`${REPO}:zzzzzzzz`)).toBeNull();
    expect(await r.fetch("garbage")).toBeNull();
  });

  it("reads quoted titles", () => {
    expect(dataField('data:\n  title: "Add: resolvers"\n', "title")).toBe("Add: resolvers");
    expect(dataField("data:\n  resolution: done\n", "resolution")).toBe("done");
    expect(dataField("data:\n  other: x\n", "resolution")).toBeNull();
  });
});

describe("the artifact page resolver", () => {
  const ID = "01kahx7z1m2n3p4q5r6s7t8v9w";
  let server: Server;
  let versions = 1;
  let base = "";

  async function artifactServer() {
    server = createServer((req, res) => {
      if (req.url === `/api/artifacts/${ID}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: ID,
            title: "Status page",
            currentVersion: versions,
            versions: Array.from({ length: versions }, (_, i) => ({
              version: i + 1,
              createdAt: `2026-11-21T10:0${i}:00Z`,
            })),
            url: `http://localhost:4400/a/${ID}/`,
            project: "github.com/nikovirtala/draft",
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("finds a page by its path-mode or subdomain-mode link on the configured server", () => {
    const r = new ArtifactPageResolver({ baseUrl: "http://localhost:4400" });
    expect(
      r.detect(
        `http://localhost:4400/a/${ID}/ and http://${ID}.localhost:4400/v/2/ and http://localhost:4401/a/${ID}/ and http://example.com/a/${ID}/`,
      ),
    ).toEqual([ID]);
    expect(r.detect(`http://localhost:4400/a/${ID}x/`)).toEqual([]);
  });

  it("carries the title and the current version, and notices a republish", async () => {
    await artifactServer();
    const r = new ArtifactPageResolver({ baseUrl: base });
    const a = await r.fetch(ID);
    expect(a).toMatchObject({ title: "Status page", currentVersion: 1, versions: 1 });
    versions = 2;
    expect(await r.fetch(ID)).toMatchObject({ currentVersion: 2, versions: 2 });
    expect(await r.fetch("01kahx7z1m2n3p4q5r6s7t8v9x")).toBeNull();
  });
});

describe("polling the new resolvers", () => {
  function pollerFor(resolver: Resolver, known: Map<string, Record<string, unknown>>) {
    let now = 0;
    const outcomes: string[] = [];
    const written: Record<string, unknown>[] = [];
    const poller = new StubPoller(
      new Map([[resolver.type, resolver]]),
      (t) => known.get(t.id) ?? null,
      async (t, state) => {
        written.push(state);
        known.set(t.id, state);
      },
      (o) => outcomes.push(`${o.outcome}:${o.nextIntervalMs}`),
      { baseMs: 1000, maxMs: 8000, now: () => now },
    );
    return { poller, outcomes, written, advance: (ms: number) => (now += ms) };
  }

  it("writes a status only on a change, doubles its interval while nothing changes, and resets on a change", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 7, { checks: [{ name: "e2e", status: "in_progress" }] });
    const r = new PullRequestResolver(client);
    const target: Target = { type: "pull-request", id: `${REPO}/pull/7` };
    const p = pollerFor(r, new Map());
    p.poller.setVisible([target]);
    await p.poller.runDue();
    expect(p.written).toHaveLength(1);
    p.advance(1000);
    await p.poller.runDue();
    p.advance(2000);
    await p.poller.runDue();
    expect(p.written).toHaveLength(1);
    expect(p.outcomes).toEqual(["changed:1000", "unchanged:2000", "unchanged:4000"]);
    fake.updatePull(REPO, 7, { checks: [{ name: "e2e", conclusion: "failure" }] });
    p.advance(4000);
    await p.poller.runDue();
    expect(p.written).toHaveLength(2);
    expect(p.outcomes.at(-1)).toBe("changed:1000");
  });

  it("polls only what is on screen, and not at all when nothing is", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 7);
    const r = new PullRequestResolver(client);
    const p = pollerFor(r, new Map());
    p.advance(10_000);
    await p.poller.runDue();
    expect(fake.requests).toHaveLength(0);
    p.poller.setVisible([{ type: "pull-request", id: `${REPO}/pull/7` }]);
    await p.poller.runDue();
    expect(fake.requests.length).toBeGreaterThan(0);
    const before = fake.requests.length;
    p.poller.setVisible([]);
    p.advance(60_000);
    await p.poller.runDue();
    expect(fake.requests).toHaveLength(before);
  });

  it("counts a failure, and doesn't come back before GitHub says it may", async () => {
    const { fake, client } = await github();
    fake.addPull(REPO, 7);
    const r = new PullRequestResolver(client);
    const p = pollerFor(r, new Map());
    p.poller.setVisible([{ type: "pull-request", id: `${REPO}/pull/7` }]);
    fake.rateLimited = 1;
    await p.poller.runDue();
    // The rate limit asked for a second; the backoff alone would have said one second too, so the
    // interval is the larger of the two and the failure is reported.
    expect(p.outcomes).toEqual(["failed:2000"]);
    p.advance(1000);
    expect(await p.poller.runDue()).toEqual([]);
    p.advance(1000);
    expect((await p.poller.runDue()).map((o) => o.outcome)).toEqual(["changed"]);
  });
});
