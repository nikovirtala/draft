import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdrResolver,
  FileLogStore,
  GithubClient,
  PersonTools,
  Projection,
  PullRequestResolver,
  personActions,
  Workspace,
} from "@nikovirtala/draft-core";
import {
  type AcceptanceFixture,
  createAcceptanceFixture,
  FAKE_GH_PATH,
  FakeGithub,
} from "@nikovirtala/draft-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AcpRuntime } from "../src/main/acp/runtime.ts";
import { fakeKiro, fakeSpec, recorded, type Script, USER } from "./acp-helpers.ts";

/**
 * The agent hears what the person decided and what draft resolved, in its next prompt: a scripted
 * agent over real stdio, an acceptance against a local bare repository and a fake GitHub (the
 * person's tools are the real git and adr), and the prompt blocks the agent recorded.
 */

const ADR_BIN = fileURLToPath(new URL("../../../node_modules/.bin/adr", import.meta.url));
const REPO = "nikovirtala/draft";
const GREEN = [{ name: "ci", conclusion: "success" }];

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

const scriptFor = (adr: string): Script => ({
  turns: [
    {
      match: "^start$",
      steps: [
        { text: `I proposed ${REPO}:${adr} in ${REPO}#7. It is ready.`, chunk: 40, delayMs: 0 },
      ],
    },
  ],
  fallback: "Understood.",
});

interface Rig {
  ws: Workspace;
  fixture: AcceptanceFixture;
  github: FakeGithub;
  logPath: string;
  dir: string;
  requests(): { id: string; kind: string }[];
  poll(): Promise<void>;
  /** The blocks of every prompt the agent was sent, in order. */
  prompts(): string[][];
  adrTarget: { type: string; id: string };
  prTarget: { type: string; id: string };
  reopen(): Promise<Rig>;
}

async function open(dirIn?: string, reuse?: { fixture: AcceptanceFixture; github: FakeGithub }) {
  const dir = dirIn ?? mkdtempSync(join(tmpdir(), "draft-acp-note-"));
  const fixture =
    reuse?.fixture ??
    createAcceptanceFixture({ dir: join(dir, "fixture"), adr: ADR_BIN, repo: REPO });
  let github = reuse?.github;
  if (github === undefined) {
    github = await new FakeGithub().start();
    cleanup.push(() => github?.stop());
    github.writes = true;
    github.addGitRepo(REPO, fixture.bare);
    github.addPull(REPO, 7, {
      title: "Propose: tell the agent",
      headRef: fixture.adr.branch,
      checks: GREEN,
      checksFor: fixture.tip(fixture.adr.branch),
    });
  }
  const gh = github;
  const client = new GithubClient({ token: "t0ken", baseUrl: gh.baseUrl });
  const person = new PersonTools({
    dir: join(dir, "data"),
    gh: [process.execPath, FAKE_GH_PATH],
    adr: [ADR_BIN],
    remotes: { [REPO]: fixture.bare },
    env: { ...fixture.env, GH_FAKE_URL: gh.baseUrl, GH_FAKE_USER: "niko" },
  });
  const kiro = await fakeKiro().start();
  const { spec, logPath } = fakeSpec(dir, scriptFor(fixture.adr.id));
  const runtime = new AcpRuntime({
    spec,
    cwd: join(dir, "agent-workspace"),
    env: { PATH: process.env.PATH ?? "" },
    dataDir: dir,
    clientInfo: { name: "draft", version: "0.0.0-test" },
    kiro: { url: kiro.mcpUrl, baseUrl: kiro.baseUrl, token: async () => "test-token-1" },
  });
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const pulls = new PullRequestResolver(client, async () => "niko");
  const ws = await Workspace.open({
    log,
    projection,
    agent: runtime,
    resolvers: [pulls, new AdrResolver(client, pulls, { verifier: person })],
    user: USER,
    acceptance: personActions(person),
    poller: { baseMs: 0 },
  });
  const adrTarget = { type: "adr", id: `${REPO}:${fixture.adr.id}` };
  const prTarget = { type: "pull-request", id: `${REPO}/pull/7` };
  const rig: Rig = {
    ws,
    fixture,
    github: gh,
    logPath,
    dir,
    adrTarget,
    prTarget,
    requests: () =>
      ws.main
        .state()
        .timeline.flatMap((b) =>
          b.kind === "interrupt" && b.cause === "acceptance" && b.state === "open"
            ? [{ id: b.id, kind: String(b.detail.acceptance) }]
            : [],
        ),
    poll: async () => {
      ws.setVisible([adrTarget, prTarget]);
      await ws.tick();
    },
    prompts: () =>
      recorded(logPath)
        .filter((e) => e.event === "session/prompt")
        .map((e) => e.blocks as string[]),
    reopen: async () => {
      await shut();
      return open(dir, { fixture, github: gh });
    },
  };
  let shutDown = false;
  const shut = async () => {
    if (shutDown) return;
    shutDown = true;
    await runtime.close();
    log.close();
    projection.close();
    await kiro.stop();
  };
  cleanup.push(shut);
  return rig;
}

/** The note of the last prompt: the block before the person's text, when there is one. */
function lastNote(r: Rig): string | null {
  const blocks = r.prompts().at(-1) ?? [];
  const note = blocks.find((b) => b.startsWith("[draft's record"));
  return note ?? null;
}

describe("the next prompt carries what the person decided", () => {
  it("after an accept: the ADR accepted, the pull request merged at a commit, by the person", async () => {
    const r = await open();
    await r.ws.main.submit("start");
    expect(lastNote(r)).toBeNull();
    const adr = r.requests().find((x) => x.kind === "adr") as { id: string };
    await r.ws.main.settleInterrupt(adr.id, "accepted");
    const tip = r.fixture.tip(r.fixture.adr.branch);
    r.github.updatePull(REPO, 7, { checks: GREEN, checksFor: tip, mergeableState: "clean" });
    await r.poll();
    const pr = r.requests().find((x) => x.kind === "pull-request") as { id: string };
    await r.ws.main.settleInterrupt(pr.id, "accepted");

    await r.ws.main.submit(`is ${REPO}#7 still open?`);
    const note = lastNote(r) ?? "";
    expect(note).toContain("not the person's words");
    expect(note).toContain("Test User accepted ADR");
    expect(note).toContain("Test User accepted pull request");
    expect(note).toContain(`commit ${tip.slice(0, 7)}`);
    expect(note).toMatch(/pull request nikovirtala\/draft#7 .*: merged;/);
    // It comes before the person's own words, which are the last block, untouched.
    const blocks = r.prompts().at(-1) ?? [];
    expect(blocks.at(-1)).toBe(`is ${REPO}#7 still open?`);
    expect(blocks.indexOf(note)).toBe(blocks.length - 2);
  });

  it("after a rejection: the reason", async () => {
    const r = await open();
    await r.ws.main.submit("start");
    const pr = r.requests().find((x) => x.kind === "pull-request") as { id: string };
    await r.ws.main.settleInterrupt(pr.id, "rejected", { reason: "Superseded by #9." });
    await r.ws.main.submit("what now?");
    const note = lastNote(r) ?? "";
    expect(note).toContain("Test User rejected pull request");
    expect(note).toContain("Their reason: “Superseded by #9.”");
  });

  it("after a request for changes: the person's text, in the very prompt that carries it", async () => {
    const r = await open();
    await r.ws.main.submit("start");
    const adr = r.requests().find((x) => x.kind === "adr") as { id: string };
    await r.ws.main.settleInterrupt(adr.id, "changes-requested", {
      note: "Name the alternatives.",
    });
    const note = lastNote(r) ?? "";
    expect(note).toContain("Test User requested changes on ADR");
    expect(note).toContain("Their note: “Name the alternatives.”");
    expect(r.prompts().at(-1)?.at(-1)).toMatch(/^Changes requested on /);
  });

  it("a referenced pull request's resolved state reaches the next prompt, and a restart does not repeat it", async () => {
    let r = await open();
    await r.ws.main.submit("start");
    r.github.updatePull(REPO, 7, { checks: [{ name: "ci", status: "in_progress" }] });
    await r.poll();
    await r.ws.main.submit(`what do the checks of ${REPO}#7 say?`);
    const note = lastNote(r) ?? "";
    expect(note).toContain("pull request nikovirtala/draft#7");
    expect(note).toContain("1 still running (ci)");
    expect(note).toContain("mergeable:");

    // The process restarts: the log says the agent was told, so the new session is not told again.
    r = await r.reopen();
    await r.ws.main.submit("anything new?");
    expect(lastNote(r)).toBeNull();
  });
});
