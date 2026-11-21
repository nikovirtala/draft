import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AdrResolver } from "../src/adr.ts";
import { FakeAgentRuntime, type FakeScript } from "../src/agent.ts";
import { type DraftEvent, knownEvents } from "../src/events.ts";
import { GithubClient } from "../src/github.ts";
import { FileLogStore } from "../src/log.ts";
import { PersonTools, personActions } from "../src/person-tools.ts";
import { Projection } from "../src/projection.ts";
import { PullRequestResolver } from "../src/pull-request.ts";
import {
  type AcceptanceFixture,
  createAcceptanceFixture,
  FAKE_GH_PATH,
  FakeGithub,
} from "../src/testing/index.ts";
import { Workspace } from "../src/workspace.ts";
import { USER } from "./helpers.ts";

/**
 * Acceptance against a local bare git repository and a fake GitHub API: an ADR is accepted as a
 * signed commit with the test identity, then its pull request is merged as a second acceptance;
 * changes requested reach the agent; a rejection carries its reason. The person's tools are the
 * real ones (git, adr), with a fake `gh` that forwards `gh api` to the fake GitHub.
 */

const ADR_BIN = fileURLToPath(new URL("../../../node_modules/.bin/adr", import.meta.url));
const REPO = "nikovirtala/draft";
const GREEN = [{ name: "ci", conclusion: "success" }];

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

interface Harness {
  ws: Workspace;
  fixture: AcceptanceFixture;
  github: FakeGithub;
  agent: FakeAgentRuntime;
  events: () => DraftEvent[];
  /** The acceptance requests open in the main conversation. */
  requests: () => { id: string; kind: string; detail: Record<string, unknown> }[];
  /** Make GitHub's view fresh: what a poll would. */
  poll: () => Promise<void>;
  adrTarget: { type: string; id: string };
  prTarget: { type: string; id: string };
  /** The device's data directory: where the clones go, beside contexts/ and never in it. */
  dataDir: string;
}

async function harness(
  o: { checks?: { name: string; conclusion: string }[] } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "draft-acceptance-"));
  const fixture = createAcceptanceFixture({ dir: join(dir, "fixture"), adr: ADR_BIN, repo: REPO });
  const github = await new FakeGithub().start();
  cleanup.push(() => github.stop());
  github.writes = true;
  github.addGitRepo(REPO, fixture.bare);
  github.addPull(REPO, 7, {
    title: "Propose: accept only as the person",
    headRef: fixture.adr.branch,
    checks: o.checks ?? GREEN,
    checksFor: fixture.tip(fixture.adr.branch),
  });
  const client = new GithubClient({ token: "t0ken", baseUrl: github.baseUrl });
  const person = new PersonTools({
    dir: join(dir, "data"),
    gh: [process.execPath, FAKE_GH_PATH],
    adr: [ADR_BIN],
    remotes: { [REPO]: fixture.bare },
    env: { ...fixture.env, GH_FAKE_URL: github.baseUrl, GH_FAKE_USER: "niko" },
  });
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  cleanup.push(() => {
    log.close();
    projection.close();
  });
  const pulls = new PullRequestResolver(client, async () => "niko");
  const adrTarget = { type: "adr", id: `${REPO}:${fixture.adr.id}` };
  const prTarget = { type: "pull-request", id: `${REPO}/pull/7` };
  const script: FakeScript = {
    turns: [
      {
        match: "^start$",
        steps: [
          {
            text: `I proposed ${REPO}:${fixture.adr.id} in ${REPO}#7. It is ready for you.`,
            delayMs: 0,
          },
        ],
      },
    ],
    fallback: "Understood.",
  };
  const agent = new FakeAgentRuntime(
    script,
    { call: async () => ({ isError: true, structured: null, text: "no tools" }) },
    { model: "claude-opus-5-5" },
  );
  const ws = await Workspace.open({
    log,
    projection,
    agent,
    resolvers: [pulls, new AdrResolver(client, pulls, { verifier: person })],
    user: USER,
    acceptance: personActions(person),
    poller: { baseMs: 0 },
  });
  const requests = () =>
    ws.main
      .state()
      .timeline.flatMap((b) =>
        b.kind === "interrupt" && b.cause === "acceptance" && b.state === "open"
          ? [{ id: b.id, kind: String(b.detail.acceptance), detail: b.detail }]
          : [],
      );
  const poll = async () => {
    ws.setVisible([adrTarget, prTarget]);
    await ws.tick();
  };
  return {
    ws,
    fixture,
    github,
    agent,
    events: () => knownEvents(log.events()),
    requests,
    poll,
    adrTarget,
    prTarget,
    dataDir: join(dir, "data"),
  };
}

const start = async (h: Harness) => {
  await h.ws.main.submit("start");
};

describe("an acceptance request waits for green evidence", () => {
  it("is not raised while a check is red or running, and shows once every check has passed", async () => {
    const h = await harness({ checks: [{ name: "ci", conclusion: "failure" }] });
    await start(h);
    // The pull request has a red check: neither request is shown. The failing check is, as before.
    expect(h.requests()).toEqual([]);
    expect(h.ws.main.attention().map((a) => a.cause)).toEqual(["failed-check"]);

    h.github.updatePull(REPO, 7, { checks: [{ name: "ci", status: "in_progress" }] });
    await h.poll();
    expect(h.requests()).toEqual([]);

    h.github.updatePull(REPO, 7, { checks: GREEN });
    await h.poll();
    expect(
      h
        .requests()
        .map((r) => r.kind)
        .sort(),
    ).toEqual(["adr", "pull-request"]);
    // They rank after failures and before everything left to resolve: here they are alone.
    expect(h.ws.main.attention().map((a) => a.cause)).toEqual(["acceptance", "acceptance"]);
  });

  it("withdraws the request when evidence goes red again, saying which", async () => {
    const h = await harness();
    await start(h);
    expect(h.requests()).toHaveLength(2);
    h.github.updatePull(REPO, 7, { checks: [{ name: "ci", conclusion: "failure" }] });
    await h.poll();
    expect(h.requests()).toEqual([]);
    const cleared = h
      .events()
      .filter((e) => e.type === "interrupt.cleared" && e.data.kind === "acceptance");
    expect(cleared).toHaveLength(2);
    for (const c of cleared)
      expect((c.data as { reason: string }).reason).toMatch(/Checks is red|Checks is red/);
    // It comes back as a new episode when the evidence is green again.
    h.github.updatePull(REPO, 7, { checks: GREEN });
    await h.poll();
    expect(h.requests()).toHaveLength(2);
    // The same key, a new episode: it can be answered.
    const pr = h.requests().find((r) => r.kind === "pull-request") as { id: string };
    await h.ws.main.settleInterrupt(pr.id, "rejected", { reason: "Not now." });
    expect(h.github.pulls.get(`${REPO}#7`)?.state).toBe("closed");
  });

  it("carries the evidence the kind declares: adr verify and the checks, or the pull request's own", async () => {
    const h = await harness();
    await start(h);
    const adr = h.requests().find((r) => r.kind === "adr");
    const pr = h.requests().find((r) => r.kind === "pull-request");
    expect(
      (
        (adr as { detail: Record<string, unknown> }).detail.evidence as {
          id: string;
          status: string;
        }[]
      ).map((e) => [e.id, e.status]),
    ).toEqual([
      ["verify", "green"],
      ["checks", "green"],
    ]);
    expect(
      ((pr as { detail: Record<string, unknown> }).detail.evidence as { id: string }[]).map(
        (e) => e.id,
      ),
    ).toEqual(["ready", "checks", "mergeable", "reviews"]);
  });

  it("does not show a pull request that is a draft, conflicted or has changes requested", async () => {
    const h = await harness();
    await start(h);
    h.github.updatePull(REPO, 7, { draft: true });
    await h.poll();
    expect(h.requests().filter((r) => r.kind === "pull-request")).toEqual([]);
    h.github.updatePull(REPO, 7, { draft: false, mergeableState: "dirty", mergeable: false });
    await h.poll();
    expect(h.requests().filter((r) => r.kind === "pull-request")).toEqual([]);
    h.github.updatePull(REPO, 7, {
      mergeableState: "clean",
      mergeable: true,
      reviews: [{ id: 1, user: "juho", state: "CHANGES_REQUESTED" }],
    });
    await h.poll();
    expect(h.requests().filter((r) => r.kind === "pull-request")).toEqual([]);
  });
});

describe("accepting", () => {
  it("makes the accept commit as the person, signed, on the proposing branch, and merging is a second acceptance", async () => {
    const h = await harness();
    await start(h);
    const before = h.fixture.tip(h.fixture.adr.branch);
    const adr = h.requests().find((r) => r.kind === "adr");
    expect(adr).toBeDefined();
    await h.ws.main.settleInterrupt((adr as { id: string }).id, "accepted");

    // The commit is on the branch, on top of what the person saw, with their identity and a
    // signature that verifies against their key.
    const tip = h.fixture.tip(h.fixture.adr.branch);
    expect(tip).not.toBe(before);
    const shown = h.fixture.log(h.fixture.adr.branch, 1);
    expect(shown).toContain(`Good "git" signature for ${h.fixture.identity.email}`);
    expect(shown).toContain(`Author:     ${h.fixture.identity.name} <${h.fixture.identity.email}>`);
    expect(shown).toContain(`Commit:     ${h.fixture.identity.name} <${h.fixture.identity.email}>`);
    expect(
      execFileSync("git", ["-C", h.fixture.bare, "rev-parse", `${tip}^`], {
        encoding: "utf8",
      }).trim(),
    ).toBe(before);
    // ark recorded the person, not the agent.
    const files = execFileSync(
      "git",
      ["-C", h.fixture.bare, "show", "--stat", "--format=%s", tip],
      { encoding: "utf8" },
    );
    expect(files).toMatch(/^docs\(adr\): decide to accept only as the person/);
    const accepted = execFileSync(
      "git",
      [
        "-C",
        h.fixture.bare,
        "ls-tree",
        "-r",
        "--name-only",
        tip,
        `docs/adr/events/${h.fixture.adr.id}`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .find((f) => f.endsWith("-accepted.yaml")) as string;
    const event = execFileSync("git", ["-C", h.fixture.bare, "show", `${tip}:${accepted}`], {
      encoding: "utf8",
    });
    expect(event).toContain(h.fixture.identity.email);
    expect(event).not.toMatch(/kind: agent/);

    // The log: a step of the person's (started, completed), then the settlement.
    const ev = h.events();
    const started = ev.find(
      (e) => e.type === "step.started" && e.data.name === "draft.adr.accept",
    ) as DraftEvent<"step.started">;
    expect(started.actor).toMatchObject({ kind: "user" });
    expect(started.data.idempotencyKey).toMatch(/\S/);
    const completed = ev.find(
      (e) => e.type === "step.completed" && e.data.started === started.address,
    ) as DraftEvent<"step.completed">;
    expect(completed.actor).toMatchObject({ kind: "user" });
    expect(completed.data.idempotencyKey).toBe(started.data.idempotencyKey);
    expect(completed.data.effect).toMatchObject({
      kind: "adr.accept",
      target: h.adrTarget,
      sha: tip,
      inverse: { kind: "compensable", step: "adr.supersede" },
    });
    expect(completed.data.effect?.evidence.map((e) => e.status)).toEqual(["green", "green"]);
    const settled = ev.find(
      (e) => e.type === "interrupt.settled" && e.data.kind === "acceptance",
    ) as DraftEvent<"interrupt.settled">;
    expect(settled.actor).toMatchObject({ kind: "user" });
    expect(settled.data).toMatchObject({ outcome: "accepted", via: started.address });
    expect(settled.data.detail).toMatchObject({ effect: "adr.accept", sha: before });

    // Nothing was written to GitHub by draft's own client, and nothing was merged yet.
    expect(h.github.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(h.github.merges).toEqual([]);

    // CI is running on the new head, and GitHub says the pull request is blocked until it is done:
    // no request to merge. When it has run, there is one, and merging it is a second, separate
    // acceptance.
    h.github.updatePull(REPO, 7, {
      checks: [{ name: "ci", status: "in_progress" }],
      checksFor: tip,
      mergeableState: "blocked",
    });
    await h.poll();
    expect(h.requests().filter((r) => r.kind === "pull-request")).toEqual([]);
    h.github.updatePull(REPO, 7, { checks: GREEN, checksFor: tip, mergeableState: "clean" });
    await h.poll();
    const pr = h.requests().find((r) => r.kind === "pull-request");
    expect(pr).toBeDefined();
    // The ADR is accepted on the branch now: no second request for it.
    expect(h.requests().filter((r) => r.kind === "adr")).toEqual([]);
    await h.ws.main.settleInterrupt((pr as { id: string }).id, "accepted");

    expect(h.github.merges).toEqual([{ repo: REPO, number: 7, method: "rebase", sha: tip }]);
    expect(h.fixture.tip("main")).toBe(tip);
    // The merge went through gh as the person.
    const write = h.github.requests.find((r) => r.method === "PUT");
    expect(write?.user).toBe("niko");
    expect(JSON.parse(write?.body ?? "{}")).toEqual({ merge_method: "rebase", sha: tip });
    const merged = h
      .events()
      .find(
        (e) => e.type === "step.completed" && e.data.effect?.kind === "pull-request.merge",
      ) as DraftEvent<"step.completed">;
    expect(merged.data.effect).toMatchObject({
      sha: tip,
      inverse: { kind: "compensable", step: "pull-request.revert" },
    });
    expect(merged.data.effect?.evidence.map((e) => [e.id, e.status])).toEqual([
      ["ready", "green"],
      ["checks", "green"],
      ["mergeable", "green"],
      ["reviews", "green"],
    ]);
    expect(h.requests()).toEqual([]);

    // Merged, the decision is read from the default branch: accepted, with nothing proposing it.
    await h.poll();
    const stub = h.ws.main.state().stubs[`adr:${h.adrTarget.id}`]?.state;
    expect(stub).toMatchObject({
      status: "accepted",
      statusAt: { where: "default-branch" },
      proposedBy: null,
      title: h.fixture.adr.title,
    });
  });

  it("refuses when the evidence changed since the request was shown, and does nothing", async () => {
    const h = await harness();
    await start(h);
    const adr = h.requests().find((r) => r.kind === "adr") as { id: string };
    const before = h.fixture.tip(h.fixture.adr.branch);
    // The agent pushes a fix while the person looks: the request they see is for an older commit.
    const pushed = h.fixture.push(h.fixture.adr.branch, "notes.md", "more\n", "docs: add notes");
    h.github.updatePull(REPO, 7, { checks: GREEN, checksFor: pushed });
    await expect(h.ws.main.settleInterrupt(adr.id, "accepted")).rejects.toThrow(/evidence changed/);
    expect(h.fixture.tip(h.fixture.adr.branch)).toBe(pushed);
    expect(pushed).not.toBe(before);
    expect(h.events().filter((e) => e.type === "step.started")).toEqual([]);
    // The request for the new commit replaces it.
    await h.poll();
    expect(h.requests().find((r) => r.kind === "adr")?.id).toContain(pushed);
  });

  it("is refused without the person's tools, and nothing is started", async () => {
    const h = await harness();
    await start(h);
    const log = h.events();
    expect(log.some((e) => e.type === "step.started")).toBe(false);
    // An answer that is not one of the three.
    const adr = h.requests().find((r) => r.kind === "adr") as { id: string };
    await expect(h.ws.main.settleInterrupt(adr.id, "acknowledged")).rejects.toThrow(
      /not an answer to an acceptance request/,
    );
  });
});

describe("request changes", () => {
  it("puts the note into the thread as a message to the agent, and waits for new evidence", async () => {
    const h = await harness();
    await start(h);
    const adr = h.requests().find((r) => r.kind === "adr") as { id: string };
    await h.ws.main.settleInterrupt(adr.id, "changes-requested", {
      note: "Name the alternatives you rejected.",
    });
    const received = h.agent.received.at(-1);
    expect(received?.text).toMatch(/^Changes requested on Accept only as the person/);
    expect(received?.text).toContain("Name the alternatives you rejected.");
    const messages = h.ws.main.state().messages;
    expect(messages.at(-2)).toMatchObject({ role: "user", audience: { agent: true } });
    expect(messages.at(-2)?.text).toContain("Name the alternatives");
    // Settled by the person, with their note; nothing was committed or merged.
    const settled = h
      .events()
      .find(
        (e) => e.type === "interrupt.settled" && e.data.outcome === "changes-requested",
      ) as DraftEvent<"interrupt.settled">;
    expect(settled.actor).toMatchObject({ kind: "user" });
    expect(settled.data.detail).toMatchObject({ note: "Name the alternatives you rejected." });
    expect(h.events().some((e) => e.type === "step.started")).toBe(false);
    expect(h.requests().filter((r) => r.kind === "adr")).toEqual([]);

    // The same evidence does not bring it back; a new push, once it is green, does.
    await h.poll();
    expect(h.requests().filter((r) => r.kind === "adr")).toEqual([]);
    const pushed = h.fixture.push(h.fixture.adr.branch, "x.md", "x\n", "docs: address review");
    h.github.updatePull(REPO, 7, { checks: GREEN, checksFor: pushed });
    await h.poll();
    expect(h.requests().find((r) => r.kind === "adr")?.id).toContain(pushed);
  });

  it("needs a note", async () => {
    const h = await harness();
    await start(h);
    const adr = h.requests().find((r) => r.kind === "adr") as { id: string };
    await expect(h.ws.main.settleInterrupt(adr.id, "changes-requested", {})).rejects.toThrow(
      /needs a reason/,
    );
  });
});

describe("rejecting", () => {
  it("records an ADR's rejection with its reason, signed, through the adr tool", async () => {
    const h = await harness();
    await start(h);
    const adr = h.requests().find((r) => r.kind === "adr") as { id: string };
    await expect(h.ws.main.settleInterrupt(adr.id, "rejected", {})).rejects.toThrow(
      /needs a reason/,
    );
    await h.ws.main.settleInterrupt(adr.id, "rejected", { reason: "We keep the read client." });
    const tip = h.fixture.tip(h.fixture.adr.branch);
    expect(h.fixture.log(h.fixture.adr.branch, 1)).toContain(
      `Good "git" signature for ${h.fixture.identity.email}`,
    );
    const rejected = execFileSync(
      "git",
      [
        "-C",
        h.fixture.bare,
        "ls-tree",
        "-r",
        "--name-only",
        tip,
        `docs/adr/events/${h.fixture.adr.id}`,
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .find((f) => f.endsWith("-rejected.yaml")) as string;
    expect(
      execFileSync("git", ["-C", h.fixture.bare, "show", `${tip}:${rejected}`], {
        encoding: "utf8",
      }),
    ).toContain("We keep the read client.");
    const completed = h
      .events()
      .find(
        (e) => e.type === "step.completed" && e.data.effect?.kind === "adr.reject",
      ) as DraftEvent<"step.completed">;
    expect(completed.data.effect).toMatchObject({
      sha: tip,
      inverse: { kind: "compensable", step: "adr.propose-again" },
    });
  });

  it("closes a pull request with the person's reason as a comment, as them", async () => {
    const h = await harness();
    await start(h);
    const pr = h.requests().find((r) => r.kind === "pull-request") as { id: string };
    await h.ws.main.settleInterrupt(pr.id, "rejected", { reason: "Superseded by #9." });
    expect(h.github.comments).toEqual([{ repo: REPO, number: 7, body: "Superseded by #9." }]);
    expect(h.github.pulls.get(`${REPO}#7`)?.state).toBe("closed");
    expect(h.github.requests.filter((r) => r.method !== "GET").map((r) => r.user)).toEqual([
      "niko",
      "niko",
    ]);
    expect(h.github.merges).toEqual([]);
    const completed = h
      .events()
      .find(
        (e) => e.type === "step.completed" && e.data.effect?.kind === "pull-request.close",
      ) as DraftEvent<"step.completed">;
    expect(completed.data.effect).toMatchObject({
      sha: null,
      inverse: { kind: "reversible", step: "pull-request.reopen" },
    });
  });
});

describe("what the person's tools never do", () => {
  const tools = (h: Harness, env: NodeJS.ProcessEnv) =>
    new PersonTools({
      dir: mkdtempSync(join(tmpdir(), "draft-tools-")),
      adr: [ADR_BIN],
      remotes: { [REPO]: h.fixture.bare },
      env,
    });
  const target = (h: Harness) => ({
    repo: REPO,
    adr: h.fixture.adr.id,
    headRef: h.fixture.adr.branch,
    headSha: h.fixture.tip(h.fixture.adr.branch),
  });

  it("commit without a git identity", async () => {
    const h = await harness();
    const noone = tools(h, {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    await expect(noone.acceptAdr(target(h))).rejects.toThrow(/no user\.name and user\.email/);
    expect(h.fixture.tip(h.fixture.adr.branch)).toBe(target(h).headSha);
  });

  it("push a commit that could not be signed", async () => {
    const h = await harness();
    // The person's config names a key that is not there: signing fails, and nothing is pushed.
    const config = join(mkdtempSync(join(tmpdir(), "draft-badkey-")), "gitconfig");
    writeFileSync(
      config,
      `[user]\n\tname = Niko Test\n\temail = niko.test@example.com\n\tsigningkey = /nonexistent/key\n[gpg]\n\tformat = ssh\n`,
    );
    const unsigned = tools(h, { ...h.fixture.env, GIT_CONFIG_GLOBAL: config });
    await expect(unsigned.acceptAdr(target(h))).rejects.toThrow();
    expect(h.fixture.tip(h.fixture.adr.branch)).toBe(target(h).headSha);
  });

  it("push onto a branch that moved since the person looked", async () => {
    const h = await harness();
    const seen = target(h);
    h.fixture.push(h.fixture.adr.branch, "later.md", "later\n", "docs: a later change");
    const person = tools(h, h.fixture.env);
    await expect(person.acceptAdr(seen)).rejects.toThrow(/moved from/);
    expect(h.fixture.tip(h.fixture.adr.branch)).not.toBe(seen.headSha);
    expect(h.fixture.log(h.fixture.adr.branch, 1)).not.toMatch(/accept/);
  });

  it("start with the agent's identity: ARK_AGENT and ARK_ON_BEHALF_OF are removed", async () => {
    const h = await harness();
    const seen: NodeJS.ProcessEnv[] = [];
    const person = new PersonTools({
      dir: mkdtempSync(join(tmpdir(), "draft-env-")),
      env: { ...h.fixture.env, ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "someone@example.com" },
      run: async (_argv, o) => {
        seen.push(o.env);
        return { stdout: "Niko\n", stderr: "" };
      },
    });
    await person.identity();
    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) {
      expect(env.ARK_AGENT).toBeUndefined();
      expect(env.ARK_ON_BEHALF_OF).toBeUndefined();
    }
  });
});

describe("acceptance beside contexts", () => {
  it("keeps its clones in the device's data directory, apart from contexts and from any working copy", async () => {
    const h = await harness();
    await start(h);
    const adr = h.requests().find((r) => r.kind === "adr") as { id: string };
    const before = readdirSync(h.fixture.bare).sort();
    await h.ws.main.settleInterrupt(adr.id, "accepted");
    // Everything draft made is under <dataDir>/acceptance: not in contexts/, not in the remote's
    // directory, and the only worktrees are gone.
    expect(readdirSync(h.dataDir)).toEqual(["acceptance"]);
    expect(existsSync(join(h.dataDir, "contexts"))).toBe(false);
    const clones = readdirSync(join(h.dataDir, "acceptance")).filter((n) => n !== "worktrees");
    expect(clones).toEqual([REPO.replace("/", "__")]);
    expect(readdirSync(join(h.dataDir, "acceptance", "worktrees"))).toEqual([]);
    // The remote was pushed to and nothing else was added to it.
    expect(readdirSync(h.fixture.bare).sort()).toEqual(before);
  });

  it("writes a request's events to the log of the context it lives in, and to no other", async () => {
    const a = await harness();
    const b = await harness();
    await start(a);
    const adr = a.requests().find((r) => r.kind === "adr") as { id: string };
    await a.ws.main.settleInterrupt(adr.id, "accepted");
    const types = (h: Harness) => h.events().map((e) => e.type);
    expect(types(a)).toEqual(
      expect.arrayContaining(["interrupt.raised", "step.started", "interrupt.settled"]),
    );
    expect(types(b).filter((t) => /^(interrupt|step)\./.test(t))).toEqual([]);
    const conversations = new Set(
      a
        .events()
        .filter((e) => /^(interrupt|step)\./.test(e.type))
        .map((e) => e.conversation),
    );
    expect([...conversations]).toEqual([a.ws.mainConversation]);
  });
});
