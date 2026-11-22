import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileLogStore } from "@nikovirtala/draft-core";
import { appendMapFixture } from "@nikovirtala/draft-core/testing";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

/**
 * The map, end to end in Electron: "show the map" opens it from a sentence, a context seeded with
 * a recorded log (a fixture) shows counts that match what it holds, a cell opens its items, an item
 * opens where it lives (a stub, a thread), what a person settles moves an item between cells while
 * the map is open, and the map and its open cell are where they were after a restart. An empty
 * context shows what will appear. Screenshots land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");
const agentLog = join(artifacts, "m-fake-agent.jsonl");

async function launch(dataDir: string): Promise<{ electronApp: ElectronApplication; page: Page }> {
  writeFileSync(agentLog, "");
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
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script.json"),
      FAKE_ACP_LOG: agentLog,
      // Nothing answers here: the stubs of the fixture keep the state the log gave them.
      DRAFT_GITHUB_API_URL: "http://127.0.0.1:9",
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

async function say(scope: Locator, text: string): Promise<void> {
  const box = scope.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

const cell = (scope: Locator | Page, kind: string, column: string) =>
  scope.locator(`[data-testid="map-cell"][data-kind="${kind}"][data-column="${column}"]`);

/** A cell's count, and how many of them wait on the person. */
async function counts(scope: Locator | Page, kind: string, column: string) {
  const c = cell(scope, kind, column);
  return {
    count: Number(await c.getAttribute("data-count")),
    waiting: Number(await c.getAttribute("data-waiting")),
  };
}

test("an empty context says what will appear", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-empty-"));
  const { electronApp, page } = await launch(dataDir);
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  await expect(page.getByTestId("empty")).toBeVisible();
  await say(main, "show the map");

  const map = main.getByTestId("map");
  await expect(map).toBeVisible();
  await expect(map.getByTestId("map-summary")).toHaveText("0 open · 0 waiting on you");
  await expect(map.getByTestId("map-empty")).toContainText("Nothing to show yet");
  // The kinds draft runs show as rows even with nothing in them, each cell disabled and zero.
  await expect(map.getByTestId("map-row")).toHaveCount(8);
  await expect(cell(map, "thread", "open")).toBeDisabled();
  // The sentence was for draft: the agent never read it.
  await expect(main.getByTestId("message-user")).toHaveAttribute("data-audience", "people");
  await shot(page, "m01-empty");
  await electronApp.close();
});

test("show the map on a recorded log: counts, a cell, an item, live moves, and a restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-busy-"));
  // The context's log, as a previous session left it: the whole story is in the last hour.
  const log = FileLogStore.open(join(dataDir, "log.jsonl"), { context: "local" });
  await appendMapFixture(log, Date.now() - 40 * 60_000);
  log.close();

  let { electronApp, page } = await launch(dataDir);
  let main = page.locator('[data-testid="conversation"][data-main="true"]');
  const panel = page.getByTestId("panel");
  await expect(main.getByTestId("message-user").first()).toBeVisible();
  await expect(main.getByTestId("map")).toHaveCount(0);

  // 1. The sentence opens the map, inline, where it was asked.
  await say(main, "Show me the map");
  const map = main.getByTestId("map");
  await expect(map).toBeVisible();
  await expect(main.getByTestId("map-block")).toHaveAttribute("data-placement", "inline");

  // 2. Its counts are what the log holds.
  expect(await counts(map, "thread", "open")).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, "thread", "concluding")).toEqual({ count: 1, waiting: 1 });
  expect(await counts(map, "thread", "withdrawn")).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, "step", "completed")).toEqual({ count: 2, waiting: 0 });
  expect(await counts(map, "step", "failed")).toEqual({ count: 1, waiting: 1 });
  // A step that never finished, with no process running it, is interrupted.
  expect(await counts(map, "step", "interrupted")).toEqual({ count: 1, waiting: 1 });
  expect(await counts(map, "interrupt:unasked-call", "open")).toEqual({ count: 1, waiting: 1 });
  expect(await counts(map, "acceptance", "requested")).toEqual({ count: 1, waiting: 1 });
  expect(await counts(map, "acceptance", "accepted")).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, "pull-request", "ready")).toEqual({ count: 1, waiting: 1 });
  expect(await counts(map, "pull-request", "merged")).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, "pull-request", "failing")).toEqual({ count: 1, waiting: 1 });
  expect(await counts(map, "kiro-session", "awaiting_permission")).toEqual({
    count: 1,
    waiting: 1,
  });
  // What waits on the person is lit, and the moves of the last hour are arrows in their rows.
  await expect(cell(map, "thread", "concluding")).toHaveClass(/lit/);
  await expect(cell(map, "thread", "open")).not.toHaveClass(/lit/);
  await expect(
    map.locator('[data-testid="map-arrow"][data-kind="pull-request"][data-to="merged"]'),
  ).toHaveCount(1);
  await expect(map.getByTestId("map-move").first()).toBeVisible();
  const summary = await map.getByTestId("map-summary").innerText();
  expect(summary).toMatch(/^\d+ open · \d+ waiting on you$/);
  await map.scrollIntoViewIfNeeded();
  await shot(page, "m02-busy");

  // 3. A cell opens its items.
  await cell(map, "pull-request", "failing").click();
  const list = map.getByTestId("map-items");
  await expect(list).toBeVisible();
  await expect(list.getByTestId("map-item")).toHaveCount(1);
  await expect(list.getByTestId("map-item")).toContainText("nikovirtala/draft#3");
  await expect(cell(map, "pull-request", "failing")).toHaveAttribute("aria-pressed", "true");
  await list.scrollIntoViewIfNeeded();
  await shot(page, "m03-cell-opened");

  // 4. An item opens where it lives: a pull request at its stub, in the panel.
  await expect(panel).toHaveCount(0);
  await list.getByTestId("map-item").click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("block-full")).toHaveAttribute("data-kind", "status");
  await expect(panel.getByTestId("block-full")).toHaveAttribute(
    "data-stub-target",
    "pull-request:nikovirtala/draft/pull/3",
  );
  await shot(page, "m04-item-opened");

  // 5. What a person settles moves an item between cells while the map is open.
  const unasked = main.locator('[data-testid="interrupt"][data-cause="unasked-call"]');
  await expect(unasked).toHaveCount(1);
  await unasked.scrollIntoViewIfNeeded();
  await unasked.getByTestId("settle-acknowledged").click();
  await expect(cell(map, "interrupt:unasked-call", "open")).toHaveAttribute("data-count", "0");
  await expect(cell(map, "interrupt:unasked-call", "settled")).toHaveAttribute("data-count", "1");
  // The moves list says so too, and the waiting count came down by one.
  await expect(
    map.getByTestId("map-move").filter({ hasText: "Interrupts: call without asking" }),
  ).toHaveCount(1);
  const [open0, waiting0] = (summary.match(/\d+/g) ?? []).map(Number);
  await expect(map.getByTestId("map-summary")).toHaveText(
    `${open0 === undefined ? "" : open0 - 1} open · ${waiting0 === undefined ? "" : waiting0 - 1} waiting on you`,
  );

  // 6. A thread's item opens the thread: it takes the panel.
  await cell(map, "thread", "concluding").click();
  await expect(map.getByTestId("map-items")).toContainText("Fix the build");
  await map.getByTestId("map-item").click();
  await expect(panel.getByTestId("block-full")).toHaveAttribute("data-kind", "thread");
  await expect(panel.getByTestId("block-full")).toContainText("Fix the build");

  // 7. After a restart the map is where it was, with the same cell open.
  await electronApp.close();
  ({ electronApp, page } = await launch(dataDir));
  main = page.locator('[data-testid="conversation"][data-main="true"]');
  await expect(main.getByTestId("map")).toBeVisible();
  await expect(main.getByTestId("map-items")).toHaveAttribute("data-column", "concluding");
  expect(await counts(main, "interrupt:unasked-call", "settled")).toEqual({ count: 1, waiting: 0 });

  // 8. Popped out, the map is a window like any other block, and it stays live.
  await main.getByTestId("map-block").getByRole("button", { name: "Pop out" }).click();
  await expect.poll(() => electronApp.windows().length).toBe(2);
  const popped = electronApp.windows().find((w) => w !== page) as Page;
  await expect(popped.getByTestId("map")).toBeVisible();
  await expect(main.getByTestId("map-block")).toHaveAttribute("data-placement", "window");
  expect(await counts(popped, "pull-request", "failing")).toEqual({ count: 1, waiting: 1 });
  await expect(popped.getByTestId("map-summary")).toHaveText(
    `${(open0 ?? 0) - 1} open · ${(waiting0 ?? 0) - 1} waiting on you`,
  );
  await shot(popped, "m05-window");
  await electronApp.close();
});
