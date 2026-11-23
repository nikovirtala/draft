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
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * A check, end to end in Electron: a pull request merges with two After deploy items, one naming a
 * proposed ADR. Both wait on you as checks. A command copies exactly as written. You fail one with
 * what you saw, and pass the other, which offers the ADR's acceptance in the check. Screenshots
 * and the log excerpts land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const REPO = "nikovirtala/draft";
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");
const ADR_BIN = join(app, "../../node_modules/.bin/adr");
const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-checks-"));
const agentLog = join(artifacts, "k-fake-agent.jsonl");

const COMMAND = `pnpm --filter @nikovirtala/draft-desktop dev -- "$HOME/src/github.com/${REPO}"`;

let github: FakeGithub;
let fixture: AcceptanceFixture;

/** What the merged pull request's description holds: two items, the first naming the ADR. */
const body = (adr: string) =>
  [
    "## Summary",
    "",
    "Shows what a merged pull request still leaves for the person.",
    "",
    "## After deploy",
    "",
    `- **Look at the palette.** Why no test can show it: whether it looks right is a person's judgement. It gates ADR ${adr}.`,
    `  1. In a terminal, run \`${COMMAND}\`. You should see a draft window open on cream.`,
    "  2. Type `show the map` and press Enter. You should see a graph of pale discs.",
    "- **Sign in once.** Why no test can show it: it needs your Kiro account.",
    "  1. Run `kiro-cli login`. You should see a browser tab open.",
    "",
    "## Filed for later",
    "",
    "None",
  ].join("\n");

test.beforeAll(async () => {
  writeFileSync(agentLog, "");
  fixture = createAcceptanceFixture({ dir: join(dataDir, "fixture"), adr: ADR_BIN, repo: REPO });
  github = await new FakeGithub().start();
  github.writes = true;
  github.viewer = "niko";
  github.addGitRepo(REPO, fixture.bare);
  // The decision is proposed on a pull request whose checks have passed.
  github.addPull(REPO, 7, {
    title: "Propose: accept only as the person",
    headRef: fixture.adr.branch,
    checks: [{ name: "ci", conclusion: "success" }],
    checksFor: fixture.tip(fixture.adr.branch),
  });
  // The pull request that merges. A draft until then, so nothing about it asks to be merged.
  github.addPull(REPO, 8, {
    title: "Show what a merged pull request leaves for you",
    body: body(fixture.adr.id),
    draft: true,
  });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ arkSources: { draft: REPO } }));
});

test.afterAll(async () => {
  await github.stop();
});

async function launch(): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const display = process.env.DISPLAY === undefined ? ["--ozone-platform=headless"] : [];
  const electronApp = await electron.launch({
    args: [join(app, "out/main/index.js"), "--no-sandbox", "--disable-gpu", ...display],
    cwd: app,
    env: {
      ...process.env,
      DRAFT_DATA_DIR: dataDir,
      DRAFT_AGENT: "fake",
      DRAFT_AGENT_COMMAND: process.execPath,
      DRAFT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script-checks.json"),
      FAKE_ACP_LOG: agentLog,
      DRAFT_GITHUB_API_URL: github.baseUrl,
      GITHUB_TOKEN: "fake-token",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
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

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(artifacts, `${name}.png`) });

// biome-ignore lint/suspicious/noExplicitAny: log events, read in assertions
const readLog = (): Record<string, any>[] =>
  readFileSync(join(dataDir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

// Whatever happened, the facts it left in the log are evidence.
test.afterEach(() => {
  try {
    writeFileSync(
      join(artifacts, "k-log-checks.jsonl"),
      `${readLog()
        .filter((e) => e.type.startsWith("check.") || e.type === "reference.made")
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
  } catch {
    // No log was written: the run stopped before anything was.
  }
});

test("a merged pull request's After deploy items wait on you as checks, and passing one offers its ADR", async () => {
  const { electronApp, page } = await launch();
  // What the window and the main process say about themselves must be clean.
  const complaints: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") complaints.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => complaints.push(`pageerror: ${e.message}`));
  electronApp.process().stderr?.on("data", (d: Buffer) => {
    if (/deprecat/i.test(String(d))) complaints.push(`main: ${String(d)}`);
  });

  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const count = page.getByTestId("attention-count");
  const checks = main.getByTestId("check");
  const palette = checks.filter({ hasText: "Look at the palette" });
  const signIn = checks.filter({ hasText: "Sign in once" });

  // 1. The pull request is mentioned while it is open: nothing waits on you.
  const box = main.getByLabel("Message");
  await box.fill(`Look at ${REPO}#8`);
  await box.press("Enter");
  const stub = main.locator(`[data-testid="stub"][data-stub-target="pull-request:${REPO}/pull/8"]`);
  await expect(stub.first()).toBeVisible({ timeout: 30_000 });
  await expect(checks).toHaveCount(0);

  // 2. It merges. Both of its After deploy items appear as checks that need you.
  github.updatePull(REPO, 8, { state: "closed", merged: true });
  await expect(checks).toHaveCount(2, { timeout: 30_000 });
  await expect(count).toHaveText("2 need you");
  await expect(palette.getByTestId("check-state")).toHaveText("Waiting for you");
  await expect(palette.getByTestId("check-gate")).toContainText("Gates the decision");
  await count.click();
  const items = page.getByTestId("attention-item").filter({ hasText: "Check for you" });
  await expect(items).toHaveCount(2);
  await shot(page, "k01-two-checks-need-you");
  await count.click();

  // 3. A check opens to its reason, then its steps, each with what you should see.
  await expect(palette.getByTestId("check-reason")).toContainText("whether it looks right");
  await expect(palette.getByTestId("check-step")).toHaveCount(2);
  await expect(palette.getByTestId("check-see").first()).toContainText(
    "You should see a draft window open on cream.",
  );
  await palette.scrollIntoViewIfNeeded();
  await shot(page, "k02-a-check-opened-to-its-steps");

  // 4. A command copies exactly as written, with one action.
  await expect(palette.getByTestId("check-command-text").first()).toHaveText(COMMAND);
  await palette.getByTestId("check-copy").first().click();
  await expect(palette.getByTestId("check-copy").first()).toHaveText("Copied");
  expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(COMMAND);

  // 5. Failing one asks what you saw, and records it.
  await signIn.getByTestId("check-fail").click();
  await expect(signIn.getByTestId("check-error")).toHaveText(
    "Say what you saw, so whoever fixes it knows.",
  );
  await signIn.getByTestId("check-note").fill("No browser tab opened.");
  await signIn.getByTestId("check-fail").click();
  await expect(signIn.getByTestId("check-state")).toHaveText("Failed");
  await expect(signIn.getByTestId("check-answer")).toContainText("No browser tab opened.");
  await expect(count).toHaveText("1 needs you");
  // Nothing offers the decision for a check that failed, and the failed one is not the gate.
  await expect(signIn.getByTestId("check-gate")).toHaveCount(0);
  await signIn.scrollIntoViewIfNeeded();
  await shot(page, "k03-a-failed-check-with-its-note");

  // 6. Passing the other, with a note, offers the ADR's acceptance inside the check.
  await expect(palette.locator('[data-cause="acceptance"]')).toHaveCount(0);
  await palette.getByTestId("check-note").fill("It looks right.");
  await palette.getByTestId("check-pass").click();
  await expect(palette.getByTestId("check-state")).toHaveText("Passed");
  const offer = palette.locator('[data-testid="interrupt"][data-cause="acceptance"]');
  await expect(offer).toContainText("is ready to accept", { timeout: 30_000 });
  await expect(offer.getByTestId("settle-accepted")).toBeVisible();
  // It is offered once: the conversation leaves it to the check.
  await expect(main.getByTestId("settle-accepted")).toHaveCount(1);
  await expect(count).toHaveText("1 needs you");
  await palette.scrollIntoViewIfNeeded();
  await shot(page, "k04-a-passed-check-offers-its-adr-acceptance");
  await electronApp.close();

  // The facts are in draft's own log, with you as the actor, and nothing was written to GitHub.
  const log = readLog();
  const user = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).user;
  const requested = log.filter((e) => e.type === "check.requested");
  expect(requested.map((e) => [e.data.index, e.data.title, e.data.gates, e.actor.kind])).toEqual([
    [0, "Look at the palette", [{ type: "adr", id: `${REPO}:${fixture.adr.id}` }], "system"],
    [1, "Sign in once", [], "system"],
  ]);
  expect(requested[0]?.data.source).toMatchObject({
    type: "merged-pull-request",
    ref: `${REPO}#8`,
    target: { type: "pull-request", id: `${REPO}/pull/8` },
  });
  const answers = log.filter((e) => e.type === "check.passed" || e.type === "check.failed");
  expect(answers.map((e) => [e.type, e.data.note, e.actor.id])).toEqual([
    ["check.failed", "No browser tab opened.", user.id],
    ["check.passed", "It looks right.", user.id],
  ]);
  expect(github.requests.every((r) => r.method === "GET")).toBe(true);
  expect(complaints).toEqual([]);
});
