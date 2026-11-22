import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileLogStore } from "@nikovirtala/draft-core";
import {
  ADR_IDS,
  ARK_REPO,
  appendMapFixture,
  FakeGithub,
  seedArk,
} from "@nikovirtala/draft-core/testing";
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

/** A fake GitHub with a repository of ark records: decisions, issues and deployments. */
let github: FakeGithub;

test.beforeAll(async () => {
  github = await new FakeGithub().start();
  // The records of the last hour, so the arrows between cells show.
  seedArk(github, ARK_REPO, Date.now() - 50 * 60_000);
});

test.afterAll(async () => {
  await github.stop();
});

async function launch(
  dataDir: string,
  arkSources: Record<string, string> = { draft: ARK_REPO },
): Promise<{ electronApp: ElectronApplication; page: Page }> {
  writeFileSync(agentLog, "");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ arkSources }));
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
      // The stubs of the fixture find no pull request here and keep the state the log gave them;
      // the map reads the ark records of ARK_REPO from it.
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

/** The map opens as a graph; the grid is "By state". */
async function showGrid(scope: Locator | Page): Promise<void> {
  // The radio is visually hidden, as the range lenses are: a person clicks its label.
  await scope.getByTestId("map-layout").getByText("By state").click();
  await expect(scope.getByTestId("map-graph")).toHaveCount(0);
}

test("an empty context says what will appear", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-empty-"));
  const { electronApp, page } = await launch(dataDir, {});
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  await expect(page.getByTestId("empty")).toBeVisible();
  await say(main, "show the map");

  const map = main.getByTestId("map");
  await expect(map).toBeVisible();
  await expect(map.getByTestId("map-summary")).toHaveText("0 open · 0 waiting on you");
  await expect(map.getByTestId("map-empty")).toContainText("Nothing to show yet");
  await showGrid(map);
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

  // The graph is the default: a cluster for each kind with items, counted, and the references
  // between them. A cluster zooms into its kind, the crumb and Escape go back out.
  const graph = map.getByTestId("map-graph");
  await expect(graph).toHaveAttribute("data-zoom", "context");
  await expect(map.getByTestId("map-layout-graph")).toBeChecked();
  const clusterOf = (kind: string) =>
    graph.locator(`[data-testid="graph-cluster"][data-kind="${kind}"]`);
  await expect(clusterOf("thread")).toHaveAttribute("data-count", "3");
  await expect(clusterOf("pull-request")).toHaveAttribute("data-count", "3");
  await expect(clusterOf("acceptance")).toHaveAttribute("data-count", "3");
  await expect(graph.getByTestId("graph-edge").first()).toBeVisible();
  await expect(graph.getByTestId("graph-legend")).toContainText("Open loop");
  await shot(page, "m02-graph");
  await clusterOf("pull-request").click();
  await expect(graph).toHaveAttribute("data-zoom", "kind:pull-request");
  await expect(graph.getByTestId("graph-item")).toHaveCount(3);
  await shot(page, "m03-graph-kind");
  await graph.getByTestId("graph-item").first().click();
  await expect(graph).toHaveAttribute("data-zoom", /^item:pull-request:/);
  await expect(graph.getByTestId("graph-refs")).toContainText("asks about");
  await page.keyboard.press("Escape");
  await expect(graph).toHaveAttribute("data-zoom", "kind:pull-request");
  await graph.getByTestId("graph-crumb").first().click();
  await expect(graph).toHaveAttribute("data-zoom", "context");

  // The same nodes as a grid: one row for each kind.
  await showGrid(map);

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
  // 2b. The ark records of the repository the context covers arrive from GitHub: every decision
  // by state (one of them only on an open pull request's branch), every issue, and a row for each
  // environment of the repository's deployments.
  await expect(cell(map, "decision", "proposed")).toHaveAttribute("data-count", "2");
  expect(await counts(map, "decision", "proposed")).toEqual({ count: 2, waiting: 2 });
  for (const column of ["accepted", "rejected", "withdrawn", "deprecated", "superseded"])
    expect(await counts(map, "decision", column)).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, "issue", "open")).toEqual({ count: 2, waiting: 0 });
  expect(await counts(map, "issue", "in-progress")).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, "issue", "closed")).toEqual({ count: 3, waiting: 0 });
  // How a closed issue was closed is on its cell, not a state of its own.
  await expect(cell(map, "issue", "closed").getByTestId("map-cell-note")).toHaveText(
    "1 done, 1 obsolete, 1 wontfix",
  );
  const production = `deployment:${ARK_REPO}:production`;
  const staging = `deployment:${ARK_REPO}:staging`;
  expect(await counts(map, production, "success")).toEqual({ count: 1, waiting: 0 });
  expect(await counts(map, production, "inactive")).toEqual({ count: 1, waiting: 0 });
  // A failed run freezes the pipeline until you act: it waits on you.
  expect(await counts(map, staging, "failure")).toEqual({ count: 1, waiting: 1 });
  await expect(cell(map, staging, "failure")).toHaveClass(/lit/);
  await expect(map.getByTestId("map-stale")).toHaveCount(0);

  // What waits on the person is lit, and the moves of the last hour are arrows in their rows.
  await expect(cell(map, "thread", "concluding")).toHaveClass(/lit/);
  await expect(cell(map, "thread", "open")).not.toHaveClass(/lit/);
  await expect(
    map.locator('[data-testid="map-arrow"][data-kind="pull-request"][data-to="merged"]'),
  ).toHaveCount(1);
  await expect(map.getByTestId("map-move").first()).toBeVisible();
  const summary = await map.getByTestId("map-summary").innerText();
  expect(summary).toMatch(/^\d+ open · \d+ waiting on you$/);
  await map.getByTestId("map-row").filter({ hasText: "Decisions" }).scrollIntoViewIfNeeded();
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

  // 3b. A decision that is only on a pull request's branch: its items link to the files there and
  // to the pull request; a deployment's link to its commit and its run.
  await cell(map, "decision", "proposed").click();
  await expect(list.getByTestId("map-item")).toHaveCount(2);
  const onBranch = list.getByTestId("map-item").filter({ hasText: "Show ark records on the map" });
  await expect(onBranch.getByTestId("map-item-link")).toHaveText(["Decision", "Pull request #11"]);
  await expect(onBranch.getByTestId("map-item-link").first()).toHaveAttribute(
    "href",
    `https://github.com/${ARK_REPO}/tree/adr-ark-records/docs/adr/events/${ADR_IDS.onBranch}`,
  );
  await list.scrollIntoViewIfNeeded();
  await shot(page, "m03b-decision-cell-opened");
  await cell(map, staging, "failure").click();
  await expect(list.getByTestId("map-item")).toHaveCount(1);
  await expect(list.getByTestId("map-item-link")).toHaveText(["Commit", "Run"]);
  await expect(list.getByTestId("map-item-link").nth(1)).toHaveAttribute(
    "href",
    "https://github.com/nikovirtala/draft/actions/runs/3",
  );
  await cell(map, "pull-request", "failing").click();
  await expect(list.getByTestId("map-item")).toHaveCount(1);

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
  await showGrid(main);
  await expect(main.getByTestId("map-items")).toHaveAttribute("data-column", "concluding");
  expect(await counts(main, "interrupt:unasked-call", "settled")).toEqual({ count: 1, waiting: 0 });

  // 8. Popped out, the map is a window like any other block, and it stays live.
  await main.getByTestId("map-block").getByRole("button", { name: "Pop out" }).click();
  await expect.poll(() => electronApp.windows().length).toBe(2);
  const popped = electronApp.windows().find((w) => w !== page) as Page;
  await expect(popped.getByTestId("map")).toBeVisible();
  await showGrid(popped);
  await expect(main.getByTestId("map-block")).toHaveAttribute("data-placement", "window");
  expect(await counts(popped, "pull-request", "failing")).toEqual({ count: 1, waiting: 1 });
  await expect(popped.getByTestId("map-summary")).toHaveText(
    `${(open0 ?? 0) - 1} open · ${(waiting0 ?? 0) - 1} waiting on you`,
  );
  await shot(popped, "m05-window");
  await electronApp.close();
});
