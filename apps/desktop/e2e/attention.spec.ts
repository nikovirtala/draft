import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGithub, FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

/**
 * What needs you, in one place and one order, end to end in Electron: a scripted ACP agent over
 * real stdio, a fake Kiro Remote, a fake GitHub and a fake artifact server. A hosted session asks
 * permission and the request lands in the thread whose step launched it; you allow it. A pull
 * request that fails a check becomes an interrupt where it is referenced, beside live stubs for an
 * ark issue and an artifact page. A step that draft stopped in the middle of is retried as a new
 * step. A thread wraps up and its conclusion returns to the main conversation. Screenshots and
 * the log excerpts land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const REPO = "nikovirtala/draft";
const ARTIFACT = "01kahx7z1m2n3p4q5r6s7t8v9w";
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-attention-"));
const agentLog = join(artifacts, "a-fake-agent.jsonl");

let kiro: FakeKiroRemote;
let github: FakeGithub;
let artifactServer: ReturnType<typeof createServer>;
let artifactUrl = "";
let artifactVersion = 1;

test.beforeAll(async () => {
  writeFileSync(agentLog, "");
  kiro = await new FakeKiroRemote({ sessions: [] }).start();
  github = await new FakeGithub().start();
  github.viewer = "niko";
  github.addPull(REPO, 7, {
    title: "Add resolvers for pull requests, ark issues and artifact pages",
    checks: [
      { name: "typecheck", conclusion: "success" },
      { name: "e2e", conclusion: "failure" },
    ],
    requestedReviewers: ["niko"],
    // Blocked on the review, so it is not ready to merge: no acceptance request in this scenario.
    mergeableState: "blocked",
  });
  github.addIssue(REPO, "15cxvdep", [
    {
      stamp: "20261120T202043Z",
      type: "opened",
      data: { title: "Add resolvers for GitHub pull requests, ark issues and artifact pages" },
    },
    { stamp: "20261121T080000Z", type: "started" },
  ]);
  artifactServer = createServer((req, res) => {
    if (req.url === `/api/artifacts/${ARTIFACT}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: ARTIFACT,
          title: "Release status page",
          currentVersion: artifactVersion,
          versions: Array.from({ length: artifactVersion }, (_, i) => ({
            version: i + 1,
            createdAt: `2026-11-21T10:0${i}:00Z`,
          })),
          url: `${artifactUrl}/a/${ARTIFACT}/`,
          project: "github.com/nikovirtala/draft",
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => artifactServer.listen(0, "127.0.0.1", resolve));
  artifactUrl = `http://127.0.0.1:${(artifactServer.address() as { port: number }).port}`;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ arkSources: { draft: REPO } }));
});

test.afterAll(async () => {
  await kiro.stop();
  await github.stop();
  await new Promise<void>((resolve) => artifactServer.close(() => resolve()));
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
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script-attention.json"),
      FAKE_ACP_LOG: agentLog,
      DRAFT_KIRO_REMOTE_URL: kiro.baseUrl,
      DRAFT_KIRO_AUTH: "none",
      DRAFT_GITHUB_API_URL: github.baseUrl,
      GITHUB_TOKEN: "fake-token",
      DRAFT_ARTIFACT_URL: artifactUrl,
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });
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

async function say(scope: Locator | Page, text: string): Promise<void> {
  const box = scope.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

test("what needs you arrives in its thread, in one order, and a thread wraps up", async () => {
  let { electronApp, page } = await launch();
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const panel = page.getByTestId("panel");
  const count = page.getByTestId("attention-count");

  // 1. A conversation, and a thread branched off its first answer.
  await say(main, "Let's get going");
  await expect(main.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  const answer = main.getByTestId("message-agent").first();
  await answer.hover();
  await answer.getByTestId("branch").click();
  await answer.getByRole("menuitem", { name: /the agent \(default\)/ }).click();
  await expect(panel).toBeVisible();
  const thread = panel.getByTestId("conversation");
  const threadId = (await thread.getAttribute("data-conversation")) as string;

  // 2. The thread launches a hosted session, with your yes.
  await say(thread, "Please launch a session to fix the flaky test");
  await expect(thread.getByTestId("prompt")).toContainText("launch a Kiro session", {
    timeout: 30_000,
  });
  await expect(count).toHaveText("1 needs you");
  await thread.getByTestId("prompt").getByRole("button", { name: "Allow", exact: true }).click();
  await expect(thread.getByTestId("stub")).toHaveCount(1, { timeout: 30_000 });
  const sessionId = [...kiro.sessions.keys()][0] as string;
  expect(sessionId).toMatch(/^[0-9A-Z]{26}$/);

  // 3. The hosted session asks permission. The request is an interrupt in the thread that
  // launched it, not in the main conversation, and it is the one thing that needs you.
  kiro.update(sessionId, { status: "awaiting_permission", pendingPermissions: 1 });
  const permission = thread.locator('[data-testid="interrupt"][data-cause="permission"]');
  await expect(permission).toContainText("asks to: Run a command (1)", { timeout: 20_000 });
  await expect(permission).toHaveAttribute("data-state", "open");
  await expect(main.locator('[data-testid="interrupt"]')).toHaveCount(0);
  await expect(count).toHaveText("1 needs you");
  await shot(page, "a01-hosted-permission-in-its-thread");

  // 4. You allow it: draft calls Kiro Remote as you, and the interrupt shows who settled it.
  await permission.getByTestId("settle-allowed").click();
  await expect(permission).toHaveAttribute("data-state", "settled", { timeout: 20_000 });
  await expect(permission).toContainText("Allowed by");
  expect(kiro.sessions.get(sessionId)?.permissions[0]?.status).toBe("answered");
  expect(kiro.calls.filter((c) => c.tool === "kiro_answer_permission")).toHaveLength(1);
  await expect(page.getByTestId("attention")).toHaveCount(0);
  await shot(page, "a02-hosted-permission-allowed");

  // 5. A pull request, an ark issue and an artifact page are referenced in the main conversation:
  // live stubs, and the pull request's failed check and requested review are interrupts there.
  await say(main, `Look at ${REPO}#7, draft:15cxvdep and ${artifactUrl}/a/${ARTIFACT}/`);
  const stubs = main.getByTestId("message-user").last().getByTestId("stub");
  await expect(stubs).toHaveCount(3, { timeout: 30_000 });
  await expect(stubs.nth(0)).toHaveAttribute("data-stub-target", `pull-request:${REPO}/pull/7`);
  await expect(stubs.nth(0).getByTestId("stub-checks")).toHaveText("1 failing");
  await expect(stubs.nth(1)).toHaveAttribute("data-status", "in-progress");
  await expect(stubs.nth(2).getByTestId("stub-status")).toHaveText("Version 1");
  const failed = main.locator('[data-testid="interrupt"][data-cause="failed-check"]');
  await expect(failed).toContainText("the check “e2e” failed", { timeout: 20_000 });
  await expect(
    main.locator('[data-testid="interrupt"][data-cause="review-requested"]'),
  ).toBeVisible();
  await expect(count).toHaveText("2 need you");
  for (let i = 0; i < 3; i++) await stubs.nth(i).getByRole("button", { name: "Expand" }).click();
  await shot(page, "a03-live-stubs-and-failed-check");

  // 6. The stubs follow their targets: a republished page, a closed issue and a passing check.
  artifactVersion = 2;
  await expect(stubs.nth(2).getByTestId("stub-status")).toHaveText("Version 2", {
    timeout: 20_000,
  });
  github.addIssue(REPO, "15cxvdep", [
    ...(github.issues.get(`${REPO}:15cxvdep`) ?? []),
    { stamp: "20261121T180000Z", type: "closed", data: { resolution: "done" } },
  ]);
  await expect(stubs.nth(1)).toHaveAttribute("data-status", "closed", { timeout: 20_000 });
  await expect(stubs.nth(1).getByTestId("stub-status")).toHaveText("Closed: done");

  // 7. One count, one order: the list under the count has the failure before the review.
  await count.click();
  const items = page.getByTestId("attention-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-cause", "failed-check");
  await expect(items.nth(1)).toHaveAttribute("data-cause", "review-requested");
  await shot(page, "a04-attention-count-and-order");
  await count.click();

  // 8. The check passes: its interrupt clears by itself. The review stays until you've seen it.
  github.updatePull(REPO, 7, {
    checks: [
      { name: "typecheck", conclusion: "success" },
      { name: "e2e", conclusion: "success" },
    ],
  });
  await expect(failed).toHaveAttribute("data-state", "cleared", { timeout: 20_000 });
  await expect(count).toHaveText("1 needs you");
  await main
    .locator('[data-testid="interrupt"][data-cause="review-requested"]')
    .getByTestId("settle-acknowledged")
    .click();
  await expect(page.getByTestId("attention")).toHaveCount(0, { timeout: 20_000 });

  // 9. draft dies while a launch runs: Kiro Remote takes it, but its answer never comes back.
  const launches = () => kiro.calls.filter((c) => c.tool === "kiro_launch_session").length;
  expect(launches()).toBe(1);
  kiro.hang.add("kiro_launch_session");
  await say(thread, "Please launch another session");
  await thread.getByTestId("prompt").getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(launches, { timeout: 30_000 }).toBe(2);
  const dying = electronApp.process();
  const exited = new Promise((resolve) => dying.once("exit", resolve));
  dying.kill("SIGKILL");
  await exited;
  kiro.hang.clear();

  // 10. After the restart the step is an interrupt in its thread, and you settle it as a retry: a
  // new step with a new key. The old one is never run again.
  ({ electronApp, page } = await launch());
  const panel2 = page.getByTestId("panel");
  const interrupted = panel2.locator('[data-testid="interrupt"][data-cause="unfinished-step"]');
  await expect(interrupted).toContainText("may or may not have happened", { timeout: 30_000 });
  await expect(page.getByTestId("attention-count")).toHaveText("1 needs you");
  await page.waitForTimeout(1500);
  expect(launches()).toBe(2);
  await shot(page, "a05-interrupted-step");
  await interrupted.getByTestId("settle-retry").click();
  await expect(interrupted).toHaveAttribute("data-state", "settled", { timeout: 20_000 });
  await expect(interrupted).toContainText("Run again as a new step");
  expect(launches()).toBe(3);
  await expect(page.getByTestId("attention")).toHaveCount(0);
  await shot(page, "a06-interrupted-step-retried-as-a-new-step");

  // 11. The thread wraps up: its agent drafts a conclusion, you confirm it with one action, and
  // it appears in the main conversation at the thread's stub.
  const thread2 = panel2.getByTestId("conversation");
  await say(thread2, "wrap this up");
  const card = thread2.getByTestId("conclusion-card");
  await expect(card).toContainText("We launched a hosted session", { timeout: 30_000 });
  await expect(page.getByTestId("attention-count")).toHaveText("1 needs you");
  await shot(page, "a07-conclusion-to-confirm");
  await card.getByTestId("conclusion-confirm").click();
  await expect(thread2.getByTestId("thread-ended")).toContainText("wrapped up", {
    timeout: 20_000,
  });
  await panel2.getByRole("button", { name: "Close" }).click();
  const main2 = page.locator('[data-testid="conversation"][data-main="true"]');
  const stub = main2.getByTestId("thread-stub");
  await expect(stub.getByTestId("thread-state")).toHaveText("Wrapped up");
  await expect(stub.getByTestId("thread-conclusion")).toContainText("We launched a hosted session");
  await expect(stub.getByTestId("thread-conclusion").getByTestId("conclusion-cites")).toContainText(
    "From the thread",
  );
  await expect(page.getByTestId("attention")).toHaveCount(0);
  await stub.scrollIntoViewIfNeeded();
  await shot(page, "a08-wrapped-up-thread-conclusion-in-the-main-conversation");
  await electronApp.close();

  // Evidence: each settlement is in the log with you as the actor.
  const log = readLog();
  const user = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).user;
  const mine = log.filter(
    (e) =>
      e.actor.kind === "user" &&
      ["interrupt.settled", "thread.wrapped_up", "step.started", "step.completed"].includes(
        e.type,
      ) &&
      (e.type !== "step.started" ||
        e.data.retryOf !== undefined ||
        /answer_permission/.test(e.data.name)),
  );
  for (const e of mine) expect(e.actor).toEqual({ kind: "user", id: user.id, name: user.name });
  const settled = log.filter((e) => e.type === "interrupt.settled");
  expect(settled.map((e) => [e.data.kind, e.data.outcome, e.actor.kind])).toEqual([
    ["permission", "allowed", "user"],
    ["review-requested", "acknowledged", "user"],
    ["unfinished-step", "retry", "user"],
  ]);
  const retry = log.find((e) => e.type === "step.started" && e.data.retryOf !== undefined);
  const old = log.find((e) => e.address === retry?.data.retryOf);
  expect(retry?.data.idempotencyKey).not.toBe(old?.data.idempotencyKey);
  expect(settled[2]?.data).toMatchObject({ started: old?.address, via: retry?.address });
  const wrapped = log.find((e) => e.type === "thread.wrapped_up");
  expect(wrapped?.actor).toEqual({ kind: "user", id: user.id, name: user.name });
  expect(wrapped?.data.cites.thread).toBe(threadId);
  expect(log.some((e) => e.type === "thread.conclusion_proposed" && e.actor.kind === "agent")).toBe(
    true,
  );
  // The permission request was raised in the thread that launched the session.
  const raised = log.find((e) => e.type === "interrupt.raised" && e.data.kind === "permission");
  expect(raised?.conversation).toBe(threadId);
  expect(raised?.actor).toMatchObject({ kind: "resolver", id: "kiro-session" });
  // The agent never answered a permission request, and draft only ever read from GitHub.
  expect(
    log.some(
      (e) =>
        e.type === "step.started" &&
        e.actor.kind === "agent" &&
        /answer_permission/.test(e.data.name),
    ),
  ).toBe(false);
  expect(github.requests.every((r) => r.method === "GET")).toBe(true);

  const excerpt = (e: Record<string, unknown>) => JSON.stringify(e);
  writeFileSync(
    join(artifacts, "a-log-settlements.jsonl"),
    `${[
      ...log.filter((e) => ["interrupt.raised", "interrupt.cleared"].includes(e.type)).map(excerpt),
      ...log
        .filter(
          (e) =>
            (e.actor.kind === "user" &&
              [
                "step.started",
                "step.completed",
                "interrupt.settled",
                "thread.conclusion_proposed",
                "thread.wrapped_up",
              ].includes(e.type)) ||
            e.type === "thread.conclusion_proposed",
        )
        .map(excerpt),
    ].join("\n")}\n`,
  );
});
