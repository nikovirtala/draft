import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcceptanceFixture,
  createAcceptanceFixture,
  FAKE_GH_PATH,
  FakeGithub,
} from "@nikovirtala/draft-core/testing";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, shot, test } from "./harness.ts";

/**
 * Acceptance, end to end in Electron: a scripted ACP agent over real stdio, a fake GitHub API
 * backed by a local bare git repository, and the person's own tools (git with a test identity and
 * an SSH signing key, the adr program, a fake gh that forwards to the fake GitHub).
 *
 * A pull request with a red check proposes an ADR: neither is offered for acceptance. Once the
 * check is green both are, each with its evidence. You ask for changes on the ADR and the note
 * reaches the agent in the thread. The agent pushes; you accept the ADR, which is a signed commit
 * as the test identity on the pull request's branch; the pull request's checks run again; you
 * merge it as a second acceptance. Screenshots and the log excerpts land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const REPO = "nikovirtala/draft";
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");
const ADR_BIN = join(app, "../../node_modules/.bin/adr");
const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-acceptance-"));
const agentLog = join(artifacts, "c-fake-agent.jsonl");

let github: FakeGithub;
let fixture: AcceptanceFixture;
const GREEN = [{ name: "ci", conclusion: "success" }];

test.beforeAll(async () => {
  writeFileSync(agentLog, "");
  fixture = createAcceptanceFixture({ dir: join(dataDir, "fixture"), adr: ADR_BIN, repo: REPO });
  github = await new FakeGithub().start();
  github.writes = true;
  github.viewer = "niko";
  github.addGitRepo(REPO, fixture.bare);
  github.addPull(REPO, 7, {
    title: "Propose: accept only as the person",
    headRef: fixture.adr.branch,
    checks: [{ name: "ci", conclusion: "failure" }],
    checksFor: fixture.tip(fixture.adr.branch),
  });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ arkSources: { draft: REPO } }));
});

test.afterAll(async () => {
  await github.stop();
});

async function launch(): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const display = process.env.DISPLAY === undefined ? ["--ozone-platform=headless"] : [];
  const electronApp = await launchApp({
    args: [join(app, "out/main/index.js"), "--no-sandbox", "--disable-gpu", ...display],
    cwd: app,
    env: {
      ...process.env,
      DRAFT_DATA_DIR: dataDir,
      DRAFT_AGENT: "fake",
      DRAFT_AGENT_COMMAND: process.execPath,
      DRAFT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script-acceptance.json"),
      FAKE_ACP_LOG: agentLog,
      DRAFT_GITHUB_API_URL: github.baseUrl,
      GITHUB_TOKEN: "fake-token",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      // The person's own tools: their git config (identity and signing key), the real adr, and a
      // gh that forwards `gh api` to the fake GitHub.
      GIT_CONFIG_GLOBAL: fixture.env.GIT_CONFIG_GLOBAL as string,
      GIT_CONFIG_NOSYSTEM: "1",
      DRAFT_GIT_REMOTES: JSON.stringify({ [REPO]: fixture.bare }),
      DRAFT_ADR_COMMAND: JSON.stringify([ADR_BIN]),
      DRAFT_GH_COMMAND: JSON.stringify([process.execPath, FAKE_GH_PATH]),
      GH_FAKE_URL: github.baseUrl,
      GH_FAKE_USER: "niko",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1280, height: 1100 });
  return { electronApp, page };
}

// biome-ignore lint/suspicious/noExplicitAny: log events, read in assertions
const readLog = (): Record<string, any>[] =>
  readFileSync(join(dataDir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

async function say(scope: Locator | Page, text: string): Promise<void> {
  const box = scope.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

test("an ADR is accepted as you, signed, and its pull request merged as a second acceptance", async () => {
  const { electronApp, page } = await launch();
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const count = page.getByTestId("attention-count");
  const request = main.locator('[data-testid="interrupt"][data-cause="acceptance"]');
  const adrRequest = request.filter({ hasText: "is ready to accept" });
  const prRequest = request.filter({ hasText: "ready to merge" });
  const branch = fixture.adr.branch;

  // 1. The ADR and its pull request are mentioned. A check is red: the failure is what needs
  // you, and nothing is offered for acceptance.
  await say(main, `Look at ${REPO}:${fixture.adr.id} and ${REPO}#7`);
  const stubs = main.getByTestId("message-user").last().getByTestId("stub");
  await expect(stubs).toHaveCount(2, { timeout: 30_000 });
  const stubOf = (target: string) =>
    main.locator(`[data-testid="stub"][data-stub-target="${target}"]`).first();
  const adrStub = stubOf(`adr:${REPO}:${fixture.adr.id}`);
  const prStub = stubOf(`pull-request:${REPO}/pull/7`);
  await expect(adrStub.getByTestId("stub-status")).toHaveText("Proposed");
  await expect(prStub.getByTestId("stub-checks")).toHaveText("1 failing");
  const failed = main.locator('[data-testid="interrupt"][data-cause="failed-check"]');
  await expect(failed).toContainText("the check “ci” failed", { timeout: 20_000 });
  await expect(request).toHaveCount(0);
  await expect(count).toHaveText("1 needs you");
  await shot(page, "c01-red-check-no-acceptance-request");

  // 2. The check passes: both requests appear, each with its evidence, green.
  github.updatePull(REPO, 7, { checks: GREEN });
  await expect(request).toHaveCount(2, { timeout: 30_000 });
  await expect(failed).toHaveAttribute("data-state", "cleared");
  await expect(adrRequest.getByTestId("evidence-verify")).toContainText("no findings");
  await expect(adrRequest.getByTestId("evidence-checks")).toContainText("1 of 1 passed");
  await expect(adrRequest.locator(".evidence-green")).toHaveCount(2);
  await expect(prRequest.locator(".evidence-green")).toHaveCount(4);
  await expect(count).toHaveText("2 need you");
  await adrRequest.scrollIntoViewIfNeeded();
  await shot(page, "c02-acceptance-requests-with-green-evidence");

  // An attention item opens the acceptance request it counts: scrolled to, and with the keyboard
  // on it. Enter on the item does it too.
  await main.getByTestId("message-user").first().scrollIntoViewIfNeeded();
  await count.click();
  const toAccept = page
    .getByTestId("attention-item")
    .filter({ hasText: "Ready for you to accept" })
    .first();
  await toAccept.getByTestId("attention-open").focus();
  await page.keyboard.press("Enter");
  await expect(request.first()).toBeFocused();
  await expect(request.first()).toBeInViewport();

  // 3. Request changes: your note goes to the agent in the thread, and the request is settled
  // until there is new evidence.
  await adrRequest.getByTestId("settle-changes-requested").click();
  await adrRequest.getByTestId("acceptance-words").fill("Name the alternatives you rejected.");
  await adrRequest.getByTestId("acceptance-send").click();
  await expect(main.getByTestId("message-user").last()).toContainText(
    "Changes requested on Accept only as the person",
    { timeout: 20_000 },
  );
  await expect(main.getByTestId("message-agent").last()).toContainText("name the alternatives", {
    timeout: 30_000,
  });
  await expect(request).toHaveCount(2);
  await expect(
    main.locator('[data-testid="interrupt"][data-cause="acceptance"][data-state="settled"]'),
  ).toContainText("Changes requested by");
  await main.getByTestId("message-agent").last().scrollIntoViewIfNeeded();
  await shot(page, "c03-request-changes-in-the-thread");

  // 4. The agent pushes and the checks pass on the new commit: a new request for it.
  const pushed = fixture.push(
    branch,
    "alternatives.md",
    "Alternatives\n",
    "docs: name alternatives",
  );
  github.updatePull(REPO, 7, { checks: GREEN, checksFor: pushed });
  const open = main.locator(
    '[data-testid="interrupt"][data-cause="acceptance"][data-state="open"]',
  );
  await expect(open).toHaveCount(2, { timeout: 30_000 });
  const adrOpen = open.filter({ hasText: "is ready to accept" });
  const prOpen = open.filter({ hasText: "ready to merge" });
  await expect(adrOpen).toHaveCount(1);

  // 5. Accept the ADR: a commit as you, signed, on the pull request's branch.
  await adrOpen.getByTestId("settle-accepted").click();
  const accepted = main
    .locator('[data-testid="interrupt"][data-cause="acceptance"][data-state="settled"]')
    .filter({ hasText: "Accepted by" });
  await expect(accepted).toHaveCount(1, { timeout: 60_000 });
  const acceptSha = fixture.tip(branch);
  expect(acceptSha).not.toBe(pushed);
  const signed = fixture.log(branch, 1);
  expect(signed).toContain(`Good "git" signature for ${fixture.identity.email}`);
  expect(signed).toContain(`Author:     ${fixture.identity.name} <${fixture.identity.email}>`);
  writeFileSync(join(artifacts, "c-accept-commit-show-signature.txt"), signed);
  await accepted.scrollIntoViewIfNeeded();
  await shot(page, "c04-adr-accepted");

  // 6. The pull request has a new head, so its request is for that commit: CI runs, and once it
  // has passed, merging it is a second, separate acceptance.
  // Until CI has run on it GitHub says the pull request is blocked, so there is no request yet.
  // Stubs are polled while they are on screen: bring the pull request's into view.
  await prStub.scrollIntoViewIfNeeded();
  await expect(prOpen).toHaveCount(0, { timeout: 30_000 });
  github.updatePull(REPO, 7, { checks: GREEN, checksFor: acceptSha, mergeableState: "clean" });
  await expect(prOpen).toHaveCount(1, { timeout: 30_000 });
  await expect(prOpen).toContainText("Merge nikovirtala/draft#7 into main by rebase");
  await prOpen.scrollIntoViewIfNeeded();
  await shot(page, "c05-merge-is-a-second-acceptance");
  await prOpen.getByTestId("settle-accepted").click();
  await expect(
    main
      .locator('[data-testid="interrupt"][data-cause="acceptance"][data-state="settled"]')
      .filter({ hasText: "Accepted by" }),
  ).toHaveCount(2, { timeout: 60_000 });
  expect(fixture.tip("main")).toBe(acceptSha);
  expect(github.merges).toEqual([{ repo: REPO, number: 7, method: "rebase", sha: acceptSha }]);
  await expect(page.getByTestId("attention")).toHaveCount(0, { timeout: 20_000 });
  await main
    .locator('[data-testid="interrupt"][data-cause="acceptance"]')
    .last()
    .scrollIntoViewIfNeeded();
  await shot(page, "c06-merged");
  await electronApp.close();

  // Evidence: each acceptance is in the log with you as the actor, the evidence as it was, the
  // resulting commit and the declared inverse.
  const log = readLog();
  const user = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).user;
  const me = { kind: "user", id: user.id, name: user.name };
  const steps = log.filter(
    (e) => e.type === "step.started" && /^draft\.(adr|pull-request)\./.test(e.data.name as string),
  );
  expect(steps.map((e) => e.data.name)).toEqual(["draft.adr.accept", "draft.pull-request.merge"]);
  for (const s of steps) expect(s.actor).toEqual(me);
  const done = log.filter((e) => e.type === "step.completed" && e.data.effect !== undefined);
  expect(
    done.map((e) => [e.data.effect.kind, e.data.effect.sha, e.data.effect.inverse.kind]),
  ).toEqual([
    ["adr.accept", acceptSha, "compensable"],
    ["pull-request.merge", acceptSha, "compensable"],
  ]);
  for (const d of done) {
    expect(d.actor).toEqual(me);
    expect(d.data.effect.evidence.every((x: { status: string }) => x.status === "green")).toBe(
      true,
    );
  }
  const settled = log.filter((e) => e.type === "interrupt.settled" && e.data.kind === "acceptance");
  expect(settled.map((e) => [e.data.outcome, e.actor.kind])).toEqual([
    ["changes-requested", "user"],
    ["accepted", "user"],
    ["accepted", "user"],
  ]);
  // The agent never accepted, rejected or merged anything, and draft's own client only read.
  expect(
    log.some(
      (e) =>
        e.type === "step.started" && e.actor.kind === "agent" && /accept|merge/.test(e.data.name),
    ),
  ).toBe(false);
  expect(github.requests.filter((r) => r.method !== "GET").every((r) => r.user === "niko")).toBe(
    true,
  );
  expect(
    execFileSync("git", ["-C", fixture.bare, "rev-parse", "main"], { encoding: "utf8" }).trim(),
  ).toBe(acceptSha);

  const relevant = log.filter(
    (e) =>
      (e.type === "interrupt.raised" && e.data.kind === "acceptance") ||
      (e.type === "interrupt.cleared" && e.data.kind === "acceptance") ||
      settled.includes(e) ||
      steps.includes(e) ||
      done.includes(e),
  );
  writeFileSync(
    join(artifacts, "c-log-acceptances.jsonl"),
    `${relevant.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
});
