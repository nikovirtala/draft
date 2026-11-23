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
  GITHUB_ENVIRONMENTS_RESPONSE,
  seedArk,
} from "@nikovirtala/draft-core/testing";
import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, shot, shotOf, test } from "./harness.ts";

/**
 * The map, end to end in Electron: "show the map" opens it from a sentence, a context seeded with
 * a recorded log (a fixture) shows counts that match what it holds, a cell opens its items, an item
 * opens where it lives (a stub, a thread), what a person settles moves an item between cells while
 * the map is open, and the map and its open cell are where they were after a restart. An empty
 * context shows what will appear. Screenshots land in e2e/artifacts.
 */

/** GitHub's environments answer, cut to the one environment of kiro-remote. */
const GITHUB_ENVIRONMENTS_RESPONSE_ONE = {
  total_count: 1,
  environments: GITHUB_ENVIRONMENTS_RESPONSE.environments.filter((e) => e.name === "production"),
};

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
  // The empty state names every kind the context has, the ark kinds too, and no row of zeros
  // stands in for them.
  const empty = map.getByTestId("map-empty");
  await expect(empty).toContainText("Nothing to show yet");
  for (const name of [
    "Threads",
    "Steps",
    "Interrupts",
    "Acceptance requests",
    "Kiro sessions",
    "Pull requests",
    "Decisions",
    "Issues",
  ])
    await expect(empty).toContainText(name);
  await showGrid(map);
  await expect(map.getByTestId("map-row")).toHaveCount(0);
  // Reading the repositories says so once, if it says so at all.
  await expect(map.getByTestId("map-problems")).toHaveCount(0);
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
  // Names have boxes of their own: none touches another name.
  const names = await graph
    .getByTestId("graph-name")
    .evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.top, r.right, r.bottom]),
    );
  expect(names.length).toBeGreaterThanOrEqual(6);
  for (const [i, a] of names.entries())
    for (const b of names.slice(i + 1))
      expect(
        (a?.[0] ?? 0) < (b?.[2] ?? 0) &&
          (b?.[0] ?? 0) < (a?.[2] ?? 0) &&
          (a?.[1] ?? 0) < (b?.[3] ?? 0) &&
          (b?.[1] ?? 0) < (a?.[3] ?? 0),
      ).toBe(false);
  await shotOf(graph, "m02-graph");

  // Moving about changes the viewport and nothing else: every node keeps its place.
  const stage = graph.getByTestId("graph-stage");
  const scale = async () => Number(await stage.getAttribute("data-scale"));
  const offset = async () => ({
    x: Number(await stage.getAttribute("data-x")),
    y: Number(await stage.getAttribute("data-y")),
  });
  // Where each node is, as a percentage of the panel, by what it is.
  const places = () =>
    graph
      .locator(
        '[data-testid="graph-cluster"][style*="left"], [data-testid="graph-item"][style*="left"]',
      )
      .evaluateAll((els) =>
        Object.fromEntries(
          els.map((e) => {
            const at = (e.getAttribute("style") ?? "").match(
              /left:\s*([\d.]+)%.*?top:\s*([\d.]+)%/,
            );
            const key = [
              e.getAttribute("data-testid"),
              e.getAttribute("data-kind"),
              e.getAttribute("data-item") ?? e.getAttribute("data-state"),
            ].join("|");
            return [key, [Number(at?.[1]), Number(at?.[2])]];
          }),
        ),
      );
  // The map may gain nodes while it is open, and a neighbour that grows can nudge a node a little
  // (never more than the layout's own limit); a viewport moves none of them.
  const samePlaces = (now: Record<string, number[]>, was: Record<string, number[]>) => {
    const shared = Object.keys(was).filter((k) => k in now);
    expect(shared.length).toBeGreaterThan(3);
    for (const k of shared) {
      expect(Math.abs((now[k]?.[0] ?? 0) - (was[k]?.[0] ?? 0))).toBeLessThan(1.5);
      expect(Math.abs((now[k]?.[1] ?? 0) - (was[k]?.[1] ?? 0))).toBeLessThan(2.5);
    }
  };
  const placed = await places();
  expect(Object.keys(placed).length).toBeGreaterThan(3);
  // The map is still filling in from GitHub, and the view follows the fit as it does: wait for
  // the framing to hold still before measuring against it.
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = await scale();
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [600] },
    )
    .toBe(true);
  const fitted = await scale();
  await expect(stage).toHaveAttribute("data-moved", "false");
  await shotOf(graph, "m02a-graph-fitted");
  // Buttons.
  await graph.getByTestId("graph-zoom-in").click();
  expect(await scale()).toBeGreaterThan(fitted);
  await graph.getByTestId("graph-zoom-in").click();
  await shotOf(graph, "m02b-graph-zoomed");
  await graph.getByTestId("graph-zoom-out").click();
  await expect(graph.getByTestId("graph-scale")).toHaveText(
    `${Math.round((await scale()) * 100)}%`,
  );
  await graph.getByTestId("graph-zoom-out").click();
  expect(await scale()).toBeCloseTo(fitted, 3);
  // Keys, with the stage in focus: Ctrl (Cmd on a Mac) and plus or minus, and the arrow keys.
  await stage.focus();
  await page.keyboard.press("Control+Equal");
  expect(await scale()).toBeGreaterThan(fitted);
  await page.keyboard.press("Control+Minus");
  expect(await scale()).toBeCloseTo(fitted, 3);
  await page.keyboard.press("Control+Equal");
  const zoomed = await scale();
  const at = await offset();
  await page.keyboard.press("ArrowRight");
  expect((await offset()).x).toBeLessThan(at.x);
  await page.keyboard.press("ArrowDown");
  expect((await offset()).y).toBeLessThan(at.y);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  expect((await offset()).x).toBeCloseTo(at.x, 1);
  expect((await offset()).y).toBeCloseTo(at.y, 1);
  expect(await scale()).toBeCloseTo(zoomed, 3);
  await expect(stage).toHaveAttribute("data-moved", "true");
  // Dragging while Space is held.
  const box = (await stage.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const beforeDrag = await offset();
  await page.keyboard.down("Space");
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const afterDrag = await offset();
  expect(afterDrag.x).toBeGreaterThan(beforeDrag.x);
  expect(afterDrag.y).toBeGreaterThan(beforeDrag.y);
  // The drag was no click: the graph is still at the context.
  await expect(graph).toHaveAttribute("data-zoom", "context");
  // A two-finger scroll pans, now the view has been moved.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(40, 0);
  expect((await offset()).x).toBeLessThan(afterDrag.x);
  // A pinch (a wheel with the control key down) zooms.
  const pinched = await scale();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -40);
  await page.keyboard.up("Control");
  expect(await scale()).toBeGreaterThan(pinched);
  // Fit goes back to the framing, and nothing moved while it was away.
  await graph.getByTestId("graph-fit").click();
  expect(await scale()).toBeCloseTo(fitted, 3);
  await expect(stage).toHaveAttribute("data-moved", "false");
  samePlaces(await places(), placed);
  // A new level of the semantic zoom is fitted again, whatever the view was.
  await graph.getByTestId("graph-zoom-in").click();
  await clusterOf("pull-request").click();
  await expect(graph).toHaveAttribute("data-zoom", "kind:pull-request");
  await expect(stage).toHaveAttribute("data-moved", "false");
  await graph.getByTestId("graph-crumb").first().click();
  await expect(graph).toHaveAttribute("data-zoom", "context");
  samePlaces(await places(), placed);
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

test("a failed deployment fixed by a later one is settled by a supersedes edge, in the environment it ran in", async () => {
  // A repository like kiro-remote: one environment, production, whose failed drill deployment was
  // followed by a successful one. GitHub lists the environment and deploy.toml names it.
  const repo = "nikovirtala/kiro-remote";
  github.addFiles(repo, "main", {
    "deploy.toml": '[project]\nname = "kiro-remote"\nenvironment = "production"\n',
  });
  github.environments.set(repo, GITHUB_ENVIRONMENTS_RESPONSE_ONE);
  const t = (m: number) => new Date(Date.now() - (60 - m) * 60_000).toISOString();
  github.addDeployment(repo, {
    id: 9001,
    sha: `fd81077${"0".repeat(33)}`,
    ref: "main",
    environment: "production",
    createdAt: t(10),
    statuses: [
      { state: "queued", at: t(10) },
      { state: "in_progress", at: t(11) },
      { state: "failure", at: t(12) },
    ],
  });
  github.addDeployment(repo, {
    id: 9002,
    sha: `48e7f4c${"0".repeat(33)}`,
    ref: "main",
    environment: "production",
    createdAt: t(30),
    statuses: [
      { state: "queued", at: t(30) },
      { state: "in_progress", at: t(31) },
      { state: "success", at: t(32) },
    ],
  });
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-env-"));
  const { electronApp, page } = await launch(dataDir, { remote: repo });
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  await say(main, "show the map");
  const graph = main.getByTestId("map").getByTestId("map-graph");
  const production = graph.locator(
    `[data-testid="graph-cluster"][data-kind="deployment:${repo}:production"]`,
  );
  await expect(production).toHaveAttribute("data-count", "2");
  // Nothing waits on the person: the failure is settled.
  await expect(production).not.toHaveClass(/waiting/);
  await expect(main.getByTestId("map-summary")).toHaveText("0 open · 0 waiting on you");
  await shotOf(graph, "m06-kiro-remote-context");
  await production.click();
  await expect(graph).toHaveAttribute("data-zoom", `kind:deployment:${repo}:production`);
  const failed = graph.locator('[data-testid="graph-item"][data-item="9001"]');
  const fixed = graph.locator('[data-testid="graph-item"][data-item="9002"]');
  await expect(failed).toHaveAttribute("aria-label", /Failed, then succeeded/);
  await expect(fixed).toHaveAttribute("aria-label", /Succeeded/);
  // The edge runs from the run that fixed to the failure it fixed, and is drawn like any other.
  const edge = graph.getByTestId("graph-edge");
  await expect(edge).toHaveCount(1);
  await expect(edge).toHaveAttribute("data-from", `item:deployment:${repo}:production:9002`);
  await expect(edge).toHaveAttribute("data-to", `item:deployment:${repo}:production:9001`);
  await graph.locator("summary").click();
  await expect(graph.locator(".graph-words")).toContainText("supersedes");
  await shot(page, "m07-supersedes-edge");
  await electronApp.close();
});

/** What the window's frame measures: the document, the title bar and the footer. */
async function frameOf(page: Page) {
  return page.locator("html").evaluate((html) => {
    const doc = html.ownerDocument;
    const scrolling = doc.scrollingElement ?? html;
    const rect = (selector: string) => doc.querySelector(selector)?.getBoundingClientRect();
    return {
      scrollHeight: scrolling.scrollHeight,
      scrollTop: scrolling.scrollTop,
      innerHeight: doc.defaultView?.innerHeight ?? 0,
      titleTop: rect("header.titlebar")?.top ?? null,
      footerBottom: rect('[data-testid="footer"]')?.bottom ?? null,
      blockBottom: rect('[data-testid="block-full"]')?.bottom ?? null,
    };
  });
}

test("the window never scrolls: a long conversation, and a long map in a window of its own, scroll inside it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-scroll-"));
  const log = FileLogStore.open(join(dataDir, "log.jsonl"), { context: "local" });
  await appendMapFixture(log, Date.now() - 40 * 60_000);
  log.close();
  const { electronApp, page } = await launch(dataDir);
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  await expect(main.getByTestId("message-user").first()).toBeVisible();
  await say(main, "Show me the map");
  await expect(main.getByTestId("map")).toBeVisible();
  await showGrid(main);
  await expect(main.getByTestId("map-row").first()).toBeVisible();

  // A window about 1960 px wide and low, so that the conversation is much taller than it.
  await page.setViewportSize({ width: 1960, height: 560 });
  const conversation = main.locator("main.conversation");
  const overflow = await conversation.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the conversation is taller than the window").toBeGreaterThan(500);

  // Scrolled to the end, by script and then by the wheel (which chains to the window when the
  // conversation has nothing left to scroll).
  await conversation.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await conversation.hover();
  await page.mouse.wheel(0, 4000);
  await page.mouse.wheel(0, 4000);
  const frame = await frameOf(page);
  expect(frame.scrollHeight).toBe(frame.innerHeight);
  expect(frame.scrollTop).toBe(0);
  expect(frame.titleTop).toBe(0);
  expect(frame.footerBottom).toBe(frame.innerHeight);
  expect(
    await conversation.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
  ).toBeLessThan(2);
  await shot(page, "w01-window-scrolled-to-the-end");

  // The same map popped out into a window of its own: its body scrolls, its header and the
  // title bar stay.
  await main.getByTestId("map-block").getByRole("button", { name: "Pop out" }).click();
  await expect.poll(() => electronApp.windows().length).toBe(2);
  const popped = electronApp.windows().find((w) => w !== page) as Page;
  await popped.setViewportSize({ width: 1960, height: 460 });
  await expect(popped.getByTestId("map")).toBeVisible();
  await showGrid(popped);
  const block = popped.getByTestId("block-full");
  expect(await block.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await block.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await block.hover();
  await popped.mouse.wheel(0, 4000);
  const inWindow = await frameOf(popped);
  expect(inWindow.scrollHeight).toBe(inWindow.innerHeight);
  expect(inWindow.scrollTop).toBe(0);
  expect(inWindow.titleTop).toBe(0);
  expect(inWindow.blockBottom).toBe(inWindow.innerHeight);
  // The block's header is still at the top of its window.
  const header = (await block.locator(".block-header").boundingBox()) as { y: number };
  const bar = (await popped.locator("header.titlebar").boundingBox()) as {
    y: number;
    height: number;
  };
  expect(Math.abs(header.y - (bar.y + bar.height))).toBeLessThan(1);
  await shot(popped, "w02-block-window-scrolled-to-the-end");
  await electronApp.close();
});

test("a selected stub is never filled: a click shows no ring, the keyboard shows one", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-selected-"));
  const { electronApp, page } = await launch(dataDir);
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  await say(main, "show the map");
  const stub = main.getByTestId("map-block");
  await expect(stub.getByTestId("map")).toBeVisible();
  await stub.locator(".stub-title").click();
  await expect(stub).toHaveAttribute("data-selected", "true");
  const RAISED = "rgb(255, 253, 247)";
  const CLEAR = "rgba(0, 0, 0, 0)";
  // Selected by a click: the map stub, its header and its body are on their own ground, and
  // nothing is drawn around it.
  await expect(stub).toHaveCSS("background-color", RAISED);
  await expect(stub.locator(":scope > .stub-line")).toHaveCSS("background-color", CLEAR);
  await expect(stub.getByTestId("map")).toHaveCSS("background-color", CLEAR);
  await expect(stub.locator(".stub-title")).toHaveCSS("color", "rgb(0, 86, 97)");
  await expect(stub).toHaveCSS("outline-style", "none");
  await shotOf(stub, "m08-selected-map-stub");

  // Minimized, the same stub is one line, and as unfilled.
  await stub.getByRole("button", { name: "Minimize" }).click();
  await expect(stub).toHaveAttribute("data-placement", "minimized");
  await stub.locator(".stub-title").click();
  await expect(stub).toHaveAttribute("data-selected", "true");
  await expect(stub).toHaveCSS("background-color", RAISED);
  await expect(stub.locator(":scope > .stub-line")).toHaveCSS("background-color", CLEAR);
  await expect(stub).toHaveCSS("outline-style", "none");
  await shotOf(stub, "m09-selected-one-line-stub");

  // The keyboard: Tab moves into the stub's controls and Shift+Tab back to the stub, which then
  // shows the focus ring (1.5px moved-mark, no fill).
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(stub).toBeFocused();
  await expect(stub).toHaveCSS("outline-style", "solid");
  await expect(stub).toHaveCSS("outline-color", "rgb(158, 110, 247)");
  await expect(stub).toHaveCSS("background-color", RAISED);
  await shotOf(stub, "m12-stub-with-keyboard-focus");
  await electronApp.close();
});

test("the arcs between states start and end on the cells, share one arrowhead and stack", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-map-arcs-"));
  const { electronApp, page } = await launch(dataDir);
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  await say(main, "show the map");
  const map = main.getByTestId("map");
  await expect(map).toBeVisible();
  await showGrid(map);
  const rowOf = (kind: string) => map.locator(`[data-testid="map-row"][data-kind="${kind}"]`);
  const heads = new Set<string>();
  for (const [kind, columns] of [
    ["issue", 3],
    ["decision", 6],
  ] as const) {
    const row = rowOf(kind);
    await expect(row.getByTestId("map-arrow").first()).toBeVisible();
    await expect(row.getByTestId("map-cell")).toHaveCount(columns);
    const strip = (await row.getByTestId("map-arrows").boundingBox()) as {
      y: number;
      height: number;
    };
    const cells = (await row.getByTestId("map-cell").first().boundingBox()) as { y: number };
    // The strip ends where the cells begin: the arcs run down to the cells' top edge, and no
    // part of any arc is below it, over a label.
    expect(Math.abs(strip.y + strip.height - cells.y)).toBeLessThan(1.5);
    // Every arrowhead is the same size, in pixels, whatever the arc or its stroke.
    const marker = await row.locator("marker").evaluate((m) => ({
      units: m.getAttribute("markerUnits"),
      width: m.getAttribute("markerWidth"),
      height: m.getAttribute("markerHeight"),
    }));
    expect(marker.units).toBe("userSpaceOnUse");
    heads.add(`${marker.width}x${marker.height}`);
    await shotOf(row, kind === "issue" ? "m10-arcs-issues" : "m11-arcs-decisions");
  }
  expect(heads.size).toBe(1);
  await electronApp.close();
});
