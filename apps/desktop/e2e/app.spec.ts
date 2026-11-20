import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * draft end to end, in Electron, against the scripted fake agent and the fake Kiro Remote MCP
 * server. Screenshots and the log/trace evidence land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const RUNNING = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
const WAITING = "01KAHX8A1B2C3D4E5F6G7H8J9K";

let kiro: FakeKiroRemote;
const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-"));
const spanFile = join(artifacts, "spans.jsonl");

test.beforeAll(async () => {
  writeFileSync(spanFile, "");
  kiro = await new FakeKiroRemote({
    sessions: [
      {
        id: RUNNING,
        title: "Fix the flaky end-to-end test",
        status: "running",
        repos: ["nikovirtala/draft"],
      },
      {
        id: WAITING,
        title: "Write the release notes",
        status: "awaiting_permission",
        pendingPermissions: 1,
        repos: ["nikovirtala/draft"],
      },
    ],
  }).start();
});

test.afterAll(async () => {
  await kiro.stop();
});

async function launch(): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const electronApp = await electron.launch({
    args: [join(app, "out/main/index.js"), "--no-sandbox", "--disable-gpu"],
    cwd: app,
    env: {
      ...process.env,
      DRAFT_DATA_DIR: dataDir,
      DRAFT_AGENT: "fake",
      DRAFT_FAKE_SCRIPT: join(here, "fake-script.json"),
      DRAFT_KIRO_REMOTE_URL: kiro.baseUrl,
      DRAFT_KIRO_AUTH: "none",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_SPAN_FILE: spanFile,
      DRAFT_MODEL: "claude-opus-5-5",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1120, height: 840 });
  return { electronApp, page };
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(artifacts, `${name}.png`) });

test("one conversation with live Kiro session stubs, restored from the log", async () => {
  // 1. An empty conversation.
  let { electronApp, page } = await launch();
  await expect(page.getByTestId("empty")).toBeVisible();
  await shot(page, "01-empty-conversation");

  // 2. The reply streams in.
  await page.getByLabel("Message").fill("Which Kiro sessions are open right now?");
  await page.keyboard.press("Enter");
  const streaming = page.getByTestId("message-streaming");
  await expect(streaming).toContainText("Two sessions are open", { timeout: 20_000 });
  await shot(page, "02-reply-streaming");

  // 3. The reply names two sessions; each gets a live stub.
  await expect(page.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  const stubs = page.getByTestId("message-agent").getByTestId("stub");
  await expect(stubs).toHaveCount(2);
  await expect(stubs.nth(0)).toHaveAttribute("data-status", "running");
  await expect(stubs.nth(1)).toHaveAttribute("data-status", "awaiting_permission");
  await expect(stubs.nth(1).getByTestId("stub-pending")).toHaveText("1 permission waiting");
  // Only expand and minimize: no panel or pop-out icons.
  await expect(stubs.nth(0).getByRole("button")).toHaveCount(1);
  await expect(stubs.nth(0).getByRole("button", { name: "Expand" })).toBeVisible();
  await shot(page, "03-two-session-stubs");

  // 4. The session changes; the stub on screen follows.
  kiro.update(RUNNING, { status: "awaiting_permission", pendingPermissions: 2 });
  await expect(stubs.nth(0)).toHaveAttribute("data-status", "awaiting_permission");
  await expect(stubs.nth(0).getByTestId("stub-pending")).toHaveText("2 permissions waiting");
  await stubs.nth(0).getByRole("button", { name: "Expand" }).click();
  await expect(stubs.nth(0).getByTestId("stub-details")).toContainText("When mentioned");
  await shot(page, "04-stub-updated-after-status-change");

  // 5. A tool that changes things asks first, inside the conversation.
  await page.getByLabel("Message").fill("Please launch a session to update the README.");
  await page.keyboard.press("Enter");
  const prompt = page.getByTestId("prompt");
  await expect(prompt).toContainText("launch a Kiro session");
  expect(kiro.calls.some((c) => c.tool === "kiro_launch_session")).toBe(false);
  await shot(page, "05-permission-prompt");
  await prompt.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByTestId("message-agent")).toHaveCount(2, { timeout: 30_000 });
  expect(kiro.calls.some((c) => c.tool === "kiro_launch_session")).toBe(true);
  // A valid view description renders; an invalid one falls back to plain text.
  await expect(page.getByTestId("message-agent").nth(1)).toContainText("Launched from draft.");
  await expect(page.getByTestId("view-fallback")).toHaveCount(1);
  await electronApp.close();

  // 6. After a restart, the conversation comes back from the log.
  ({ electronApp, page } = await launch());
  await expect(page.getByTestId("message-user")).toHaveCount(2);
  await expect(page.getByTestId("message-agent")).toHaveCount(2);
  await expect(page.getByTestId("message-agent").nth(0).getByTestId("stub")).toHaveCount(2);
  await expect(page.getByTestId("stub").nth(0)).toHaveAttribute(
    "data-status",
    "awaiting_permission",
  );
  // Placement is per-device view state and survives too.
  await expect(page.getByTestId("stub").nth(0).getByTestId("stub-details")).toBeVisible();
  await page.getByTestId("message-agent").nth(0).scrollIntoViewIfNeeded();
  await shot(page, "06-restored-after-restart");
  await electronApp.close();

  // Evidence: five consecutive events of the chain.
  const lines = readFileSync(join(dataDir, "log.jsonl"), "utf8").trim().split("\n");
  writeFileSync(join(artifacts, "log-excerpt.jsonl"), `${lines.slice(2, 7).join("\n")}\n`);
  writeFileSync(join(artifacts, "log.jsonl"), `${lines.join("\n")}\n`);

  // 7. A tampered log is refused, and the window says why.
  const tampered = lines.map((l) =>
    l.replace("Which Kiro sessions are open right now?", "Which sessions are open?"),
  );
  writeFileSync(join(dataDir, "log.jsonl"), `${tampered.join("\n")}\n`);
  ({ electronApp, page } = await launch());
  await expect(page.getByTestId("refused")).toContainText("was changed after it was written");
  await expect(page.getByTestId("refused")).toContainText("event 3");
  await shot(page, "07-tampered-log-refused");
  await electronApp.close();
});
