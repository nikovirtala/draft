import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARK_REPO, FakeGithub, seedArk } from "@nikovirtala/draft-core/testing";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { launchApp, shot, test } from "./harness.ts";

/**
 * A second launch opens the map from what the first one read (ADR t76jn29d): the counts are on
 * screen while GitHub has not answered a single request, the map says when they are from, and the
 * first refresh replaces them. The request counts of the same thing are measured in core's
 * launch-cache test; this is the app doing it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
mkdirSync(join(here, "artifacts"), { recursive: true });
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");

let github: FakeGithub;
test.beforeAll(async () => {
  github = await new FakeGithub().start();
  seedArk(github, ARK_REPO, Date.now() - 50 * 60_000);
});
test.afterAll(async () => {
  await github.stop();
});

async function launch(dataDir: string): Promise<{ electronApp: ElectronApplication; page: Page }> {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ arkSources: { draft: ARK_REPO } }));
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
      FAKE_ACP_LOG: join(here, "artifacts", "mc-fake-agent.jsonl"),
      DRAFT_GITHUB_API_URL: github.baseUrl,
      DRAFT_MAP_POLL_MS: "500",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1280, height: 1000 });
  return { electronApp, page };
}

const cell = (scope: Page, kind: string, column: string) =>
  scope.locator(`[data-testid="map-cell"][data-kind="${kind}"][data-column="${column}"]`);

test("the second launch shows the map from the first one's reading, saying when, before GitHub answers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-cache-"));

  // The first launch reads GitHub, with nothing stored.
  let { electronApp, page } = await launch(dataDir);
  let main = page.locator('[data-testid="conversation"][data-main="true"]');
  const box = main.getByLabel("Message");
  await box.fill("show the map");
  await box.press("Enter");
  await main.getByTestId("map-layout").getByText("By state").click();
  await expect(cell(page, "decision", "accepted")).toHaveAttribute("data-count", "1");
  await expect(cell(page, "issue", "in-progress")).toHaveAttribute("data-count", "1");
  await electronApp.close();

  // The second one: GitHub answers nothing until it is told to. What is on screen is what the
  // first launch read.
  let release: () => void = () => {};
  github.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = github.requests.length;
  try {
    ({ electronApp, page } = await launch(dataDir));
    main = page.locator('[data-testid="conversation"][data-main="true"]');
    await expect(main.getByTestId("map")).toBeVisible();
    await main.getByTestId("map-layout").getByText("By state").click();
    await expect(cell(page, "decision", "accepted")).toHaveAttribute("data-count", "1");
    await expect(cell(page, "issue", "in-progress")).toHaveAttribute("data-count", "1");
    await expect(main.getByTestId("map-problems")).toContainText(
      /as of 20\d\d-\d\d-\d\d \d\d:\d\d UTC/,
    );
    await shot(page, "mc01-from-the-last-launch");
    // Nothing was answered while that was on screen.
    expect(github.requests.slice(before).every((r) => r.status === null)).toBe(true);
  } finally {
    github.gate = null;
    release();
  }

  // The first refresh replaces it.
  await expect(main.getByTestId("map-problems")).toHaveCount(0);
  await expect(cell(page, "decision", "accepted")).toHaveAttribute("data-count", "1");
  const blobs = github.requests.slice(before).filter((r) => r.path.includes("/git/blobs/"));
  expect(blobs).toHaveLength(0);
  await electronApp.close();
});
