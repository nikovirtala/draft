import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGithub, FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, shot, shotOf, test } from "./harness.ts";

/**
 * What Kiro Remote decided, end to end in Electron, read from its change feed (a fake that serves
 * /v1/events and /v1/sessions/{id}): a session waits for a pull request, and the map, its stub
 * agree; the pull request merges and the wake is delivered, and the session says why it woke; a
 * wait ends because the pull request couldn't be read, and one item needs you until it is dismissed;
 * and a type of event draft can't read stops the reader with one notice and marks the waits stale.
 * Screenshots land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");
const agentLog = join(artifacts, "fw-fake-agent.jsonl");

const SESSION = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
const TITLE = "Build the feed view";
const REPO = "nikovirtala/kiro-remote";
const PR = `${REPO}#7`;
const NEVER_READ = `${REPO}#9`;

let kiro: FakeKiroRemote;
let github: FakeGithub;

test.beforeEach(async () => {
  kiro = await new FakeKiroRemote({
    sessions: [{ id: SESSION, title: TITLE, status: "running", repos: [REPO] }],
  }).start();
  github = await new FakeGithub().start();
  github.addPull(REPO, 7, { title: "Publish the change feed", headRef: "feat/feed" });
});

test.afterEach(async () => {
  await kiro.stop();
  await github.stop();
});

async function launch(dataDir: string): Promise<{ electronApp: ElectronApplication; page: Page }> {
  writeFileSync(agentLog, "");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ arkSources: {} }));
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
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script.json"),
      FAKE_ACP_LOG: agentLog,
      DRAFT_KIRO_REMOTE_URL: kiro.baseUrl,
      DRAFT_KIRO_AUTH: "none",
      DRAFT_GITHUB_API_URL: github.baseUrl,
      GITHUB_TOKEN: "fake-token",
      DRAFT_FEED_POLL_MS: "300",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_MAP_POLL_MS: "500",
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1280, height: 1000 });
  return { electronApp, page };
}

async function say(scope: Locator, text: string): Promise<void> {
  const box = scope.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

// biome-ignore lint/suspicious/noExplicitAny: log events, read in assertions
const readLog = (dir: string): Record<string, any>[] =>
  readFileSync(join(dir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

/** Opens the map where the session is in focus, with what it waits for as its neighbour. */
async function openSessionOnMap(main: Locator): Promise<Locator> {
  await say(main, "show the map");
  const graph = main.getByTestId("map").getByTestId("map-graph");
  await expect(graph).toBeVisible();
  const cluster = graph.locator('[data-testid="graph-cluster"][data-kind="kiro-session"]');
  await cluster.click();
  await expect(graph).toHaveAttribute("data-zoom", "kind:kiro-session");
  await graph.locator('[data-testid="graph-item"][data-kind="kiro-session"]').click();
  await expect(graph).toHaveAttribute("data-zoom", /^item:kiro-session:/);
  return graph;
}

test("a session waits for a pull request, wakes when it merges, and a wait that couldn't be read needs you", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-feed-"));
  const { electronApp, page } = await launch(dataDir);
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const count = page.getByTestId("attention-count");
  const sessionStub = main
    .locator(`[data-testid="stub"][data-stub-target="kiro-session:${SESSION}"]`)
    .first();
  const prStub = main
    .locator(`[data-testid="stub"][data-stub-target="pull-request:${REPO}/pull/7"]`)
    .first();

  // 1. The conversation mentions the session and the pull request it will wait for.
  await say(main, `${SESSION} is waiting for ${PR}`);
  await expect(sessionStub).toBeVisible({ timeout: 30_000 });
  await expect(prStub).toBeVisible({ timeout: 30_000 });
  await expect(sessionStub.getByTestId("stub-waits")).toHaveCount(0);
  // The feed is read for the session, from its own state: the starting state comes from the service.
  await expect.poll(() => kiro.rest.some((r) => r.path === `/v1/sessions/${SESSION}`)).toBe(true);

  // 2. Kiro Remote registers the wait: the stub says so, and so does the map.
  kiro.startWaiting(SESSION, PR);
  await expect(sessionStub.getByTestId("stub-waits")).toHaveText(`Waiting for ${PR}`, {
    timeout: 30_000,
  });
  const graph = await openSessionOnMap(main);
  const wait = graph.locator('[data-testid="graph-edge"][data-waits="true"]');
  await expect(wait).toHaveCount(1);
  await expect(graph.getByTestId("graph-refs")).toContainText("waits for");
  await expect(graph.getByTestId("graph-legend")).toContainText(
    "a session waits for a pull request",
  );
  // The view says which feed and which cursor it was built from.
  const built = main.getByTestId("map-feed");
  await expect(built).toContainText("Built from the kiro-remote feed, cursor 1");
  await shotOf(graph, "fw01-session-waits-on-a-pull-request-map");
  await sessionStub.getByRole("button", { name: "Expand" }).click();
  await expect(sessionStub.getByTestId("stub-details")).toContainText(
    "the kiro-remote feed, cursor 1",
  );
  await expect(sessionStub.getByTestId("stub-details")).toContainText(PR);
  await shotOf(sessionStub, "fw02-session-waits-on-a-pull-request-stub");

  // 3. The pull request merges and the wake is delivered: the wait is gone and the session says
  // why it woke.
  github.updatePull(REPO, 7, { state: "closed", merged: true });
  const wake = kiro.endWait(SESSION, PR, "merged") as string;
  kiro.deliverWake(SESSION, wake);
  await expect(sessionStub.getByTestId("stub-waits")).toHaveCount(0, { timeout: 30_000 });
  await expect(sessionStub.getByTestId("stub-last-wake")).toHaveText(
    `Woke: a pull request it waited for ${PR} merged`,
  );
  await expect(wait).toHaveCount(0);
  await expect(graph.getByTestId("graph-focus")).toContainText(
    `woke: a pull request it waited for ${PR} merged`,
  );
  await expect(built).toContainText("cursor 4");
  await expect(prStub.getByTestId("stub-status")).toHaveText("Merged", { timeout: 30_000 });
  await shotOf(graph, "fw03-the-pull-request-merged-and-the-session-woke-map");
  await shotOf(sessionStub, "fw04-the-pull-request-merged-and-the-session-woke-stub");
  // A merge and its wake are no one's to answer.
  await expect(count).toHaveCount(0);

  // 4. A wait whose pull request Kiro Remote couldn't read ends: one item needs you.
  kiro.startWaiting(SESSION, NEVER_READ);
  await expect(sessionStub.getByTestId("stub-waits")).toHaveText(`Waiting for ${NEVER_READ}`, {
    timeout: 30_000,
  });
  kiro.endWait(SESSION, NEVER_READ, "unreadable");
  await expect(count).toHaveText("1 needs you", { timeout: 30_000 });
  const item = main.locator('[data-testid="interrupt"][data-cause="wait-ended"]');
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("interrupt-summary")).toHaveText(
    `${TITLE} stopped waiting for ${NEVER_READ}: it couldn't be read`,
  );
  await expect(sessionStub.getByTestId("stub-waits")).toHaveCount(0);
  await count.click();
  await expect(page.getByTestId("attention-item").filter({ hasText: "Wait ended" })).toHaveCount(1);
  await shot(page, "fw05-a-wait-that-couldnt-be-read-needs-you");
  await count.click();

  // 5. The person dismisses it. It does not come back, and nothing else changed.
  await item.getByTestId("settle-dismissed").click();
  await expect(count).toHaveCount(0);
  await expect(item.getByTestId("interrupt-closed")).toContainText("Dismissed");
  await electronApp.close();

  // The facts are in the context's own log, as typed payloads and no free text, and the item is
  // raised once. Nothing was written to Kiro Remote.
  const log = readLog(dataDir);
  const feed = log.filter((e) => e.type.startsWith("feed."));
  expect(feed.map((e) => e.type)).toContain("feed.baseline");
  expect(
    feed.filter((e) => e.type === "feed.event").map((e) => [e.data.event.seq, e.data.event.type]),
  ).toEqual([
    [1, "wait.registered"],
    [2, "wait.removed"],
    [3, "wake.queued"],
    [4, "wake.delivered"],
    [5, "wait.registered"],
    [6, "wait.removed"],
    [7, "wake.queued"],
  ]);
  expect(
    log.filter((e) => e.type === "interrupt.raised" && e.data.kind === "wait-ended"),
  ).toHaveLength(1);
  expect(
    log.filter((e) => e.type === "interrupt.settled").map((e) => [e.data.outcome, e.actor.kind]),
  ).toEqual([["dismissed", "user"]]);
  expect(kiro.rest.every((r) => r.method === "GET")).toBe(true);
});

test("a type of event draft can't read stops the feed, once, and marks what it shows as out of date", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-feed-stop-"));
  const { electronApp, page } = await launch(dataDir);
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const sessionStub = main
    .locator(`[data-testid="stub"][data-stub-target="kiro-session:${SESSION}"]`)
    .first();

  await say(main, `${SESSION} is waiting for ${PR}`);
  await expect(sessionStub).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => kiro.rest.some((r) => r.path === `/v1/sessions/${SESSION}`)).toBe(true);
  kiro.startWaiting(SESSION, PR);
  await expect(sessionStub.getByTestId("stub-waits")).toHaveText(`Waiting for ${PR}`, {
    timeout: 30_000,
  });
  // An annotation draft doesn't know is skipped without a word.
  kiro.emit({ type: "wake.rescheduled", effect: "annotation", sessionId: SESSION, pr: PR });
  // A state change it doesn't know stops it.
  kiro.emit({ type: "wait.paused", effect: "state", sessionId: SESSION, pr: PR });
  kiro.endWait(SESSION, PR, "stopped");

  const note = main.getByTestId("note").filter({ hasText: "wait.paused" });
  await expect(note).toHaveCount(1, { timeout: 30_000 });
  await expect(sessionStub.getByTestId("stub-feed-stale")).toHaveText("Waits may be out of date");
  // What it knew is still shown, as out of date: it never saw the wait end.
  await expect(sessionStub.getByTestId("stub-waits")).toHaveText(`Waiting for ${PR}`);
  const graph = await openSessionOnMap(main);
  await expect(main.getByTestId("map-feed-stale")).toContainText("wait.paused");
  await expect(main.getByTestId("map-problems")).toContainText("wait.paused");
  await expect(graph.locator('[data-testid="graph-edge"][data-waits="true"]')).toHaveCount(1);
  await shot(page, "fw06-the-feed-stopped-at-a-type-draft-cant-read");

  // It stays stopped: nothing more is read, and no second notice comes.
  const reads = kiro.rest.filter((r) => r.path.startsWith("/v1/events")).length;
  await page.waitForTimeout(1500);
  expect(kiro.rest.filter((r) => r.path.startsWith("/v1/events")).length).toBe(reads);
  await expect(note).toHaveCount(1);
  await electronApp.close();

  const log = readLog(dataDir);
  expect(log.filter((e) => e.type === "feed.stopped").map((e) => e.data)).toEqual([
    { feed: "kiro-remote", seq: 3, type: "wait.paused", reason: "type" },
  ]);
  expect(
    log.filter((e) => e.type === "notice.posted" && e.data.what === "kiro-feed-stopped"),
  ).toHaveLength(1);
});
