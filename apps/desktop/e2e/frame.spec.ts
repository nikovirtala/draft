import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { launchApp, shot, test } from "./harness.ts";

/**
 * The window's frame, end to end in Electron: what the top bar holds and what the footer holds,
 * what the composer says in the main conversation, in a thread and while the agent is paused, the
 * aside hint that waits for a second person, and the divider between the conversation and a
 * thread: dragged, moved with the arrow keys and restored after a restart. Screenshots land in
 * e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-frame-"));
const agentLog = join(artifacts, "f-fake-agent.jsonl");
let kiro: FakeKiroRemote;

test.beforeAll(async () => {
  writeFileSync(agentLog, "");
  kiro = await new FakeKiroRemote({ sessions: [] }).start();
});

test.afterAll(async () => {
  await kiro.stop();
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
      DRAFT_AGENT_ARGS: JSON.stringify([join(app, "test/fake-acp-agent.ts")]),
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script-attention.json"),
      FAKE_ACP_LOG: agentLog,
      DRAFT_KIRO_REMOTE_URL: kiro.baseUrl,
      DRAFT_KIRO_AUTH: "none",
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

const MAIN_WORDS = "Ask, describe, or type @ to reference anything";
const THREAD_WORDS = "Reply in thread…";
const PAUSED_WORDS = /The agent is paused and isn’t listening/;

/** The thread column's width as the divider reports it, and as the column is. */
async function widths(page: Page): Promise<{ value: number; box: number }> {
  const value = Number(await page.getByTestId("panel-divider").getAttribute("aria-valuenow"));
  const box = (await page.getByTestId("panel").boundingBox())?.width ?? 0;
  return { value, box };
}

test("the frame is quiet: a lean top bar, a footer, plain words, and a thread column you size", async () => {
  let { electronApp, page } = await launch();
  const bar = page.locator("header.titlebar");
  const footer = page.getByTestId("footer");
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const box = main.getByLabel("Message");

  // 1. The top bar holds the context and what needs you, and nothing the person rarely acts on.
  await expect(bar.getByTestId("context-name")).toBeVisible();
  await expect(bar.getByTestId("contexts-button")).toBeVisible();
  await expect(bar.getByTestId("agent-state")).toHaveCount(0);
  await expect(bar.getByTestId("agent-environment")).toHaveCount(0);
  await expect(bar.getByTestId("context-folder")).toHaveCount(0);
  const barBox = await bar.boundingBox();
  expect(barBox?.height ?? 0).toBeLessThan(60);

  // 2. The footer, under the composer, holds the agent's name and state with Pause, the withheld
  // sign-ins line, and an empty place for what draft is doing.
  await expect(footer.getByTestId("agent-state")).toHaveAttribute("data-state", "active");
  await expect(footer.getByTestId("agent-state")).toContainText("the agent");
  await expect(footer.getByRole("button", { name: "Pause the agent" })).toBeVisible();
  await expect(footer.getByTestId("agent-environment-summary")).toContainText("are withheld");
  await expect(footer.getByTestId("footer-activity")).toBeEmpty();
  const composerBox = await box.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(footerBox?.y ?? 0).toBeGreaterThan((composerBox?.y ?? 0) + (composerBox?.height ?? 0));
  await shot(page, "f01-top-bar-and-footer");

  // The agent's name, state and Pause sit against the footer's right edge, and come last in the
  // keyboard order, after the sign-ins line. At a narrow width the footer wraps and they stay
  // at the right, on a line of their own.
  const rightGap = async () => {
    const f = (await footer.boundingBox()) as { x: number; width: number };
    const a = (await footer.getByTestId("agent-state").boundingBox()) as {
      x: number;
      width: number;
    };
    return f.x + f.width - (a.x + a.width);
  };
  expect(await rightGap()).toBeGreaterThanOrEqual(0);
  expect(await rightGap()).toBeLessThanOrEqual(14);
  const lineOf = async (id: string) =>
    ((await footer.getByTestId(id).boundingBox()) as { y: number }).y;
  expect(
    Math.abs((await lineOf("agent-state")) - (await lineOf("agent-environment-summary"))),
  ).toBeLessThan(12);
  await footer.getByTestId("agent-environment-summary").focus();
  await page.keyboard.press("Tab");
  await expect(footer.getByRole("button", { name: "Pause the agent" })).toBeFocused();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(rightGap).toBeLessThanOrEqual(14);
  expect(await rightGap()).toBeGreaterThanOrEqual(0);
  expect(
    (await lineOf("agent-state")) - (await lineOf("agent-environment-summary")),
  ).toBeGreaterThan(12);
  await shot(page, "f07-footer-narrow");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 3. The composer says what it is for. Paused, it says the agent isn't listening, and Pause
  // works from the keyboard where it moved to.
  await expect(box).toHaveAttribute("placeholder", MAIN_WORDS);
  const pause = footer.getByRole("button", { name: "Pause the agent" });
  await pause.focus();
  await page.keyboard.press("Enter");
  await expect(footer.getByTestId("agent-state")).toHaveAttribute("data-state", "paused");
  await expect(box).toHaveAttribute("placeholder", PAUSED_WORDS);
  await shot(page, "f02-paused-composer");
  await footer.getByRole("button", { name: "Play the agent" }).click();
  await expect(box).toHaveAttribute("placeholder", MAIN_WORDS);

  // 4. With one person, no composer line explains asides; ⌥↵ still sends one.
  await expect(page.getByTestId("composer-hint")).toHaveCount(0);
  await box.fill("Let's get going");
  await box.press("Enter");
  await expect(main.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  await box.fill("A note to myself");
  await page.keyboard.press("Alt+Enter");
  await expect(main.getByTestId("aside-label")).toHaveCount(1);
  await expect(page.getByTestId("composer-hint")).toHaveCount(0);

  // The conversation is wider than it was: 950 px at most, in a column of its own, where 760
  // used to be the limit.
  const column = await main.locator(".column").first().boundingBox();
  expect(column?.width ?? 0).toBeGreaterThan(760);
  expect(column?.width ?? 0).toBeLessThanOrEqual(950);

  // 5. A thread opens in the panel with its own words, and the divider between the columns.
  const answer = main.getByTestId("message-agent").first();
  await answer.hover();
  await answer.getByTestId("branch").click();
  await answer.getByRole("menuitem", { name: /the agent \(default\)/ }).click();
  const panel = page.getByTestId("panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Message")).toHaveAttribute("placeholder", THREAD_WORDS);
  await expect(box).toHaveAttribute("placeholder", MAIN_WORDS);
  const divider = page.getByTestId("panel-divider");
  await expect(divider).toHaveAttribute("role", "separator");
  const before = await widths(page);
  expect(before.value).toBeGreaterThan(320);
  expect(Math.abs(before.value - before.box)).toBeLessThanOrEqual(2);
  await shot(page, "f03-thread-and-divider");

  // 6. Drag the divider 120 px to the left: the thread's column grows by as much.
  const handle = (await divider.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y, { steps: 4 });
  await page.mouse.move(x - 120, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await widths(page)).value).toBeGreaterThan(before.value + 110);
  const dragged = await widths(page);
  expect(Math.abs(dragged.value - (before.value + 120))).toBeLessThanOrEqual(6);
  expect(Math.abs(dragged.value - dragged.box)).toBeLessThanOrEqual(2);

  // 7. The arrow keys move it: Left widens the thread by 16, Right narrows it, Shift moves 64,
  // Home and End go to the narrowest and the widest.
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", String(dragged.value + 16));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", String(dragged.value - 16));
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", String(dragged.value + 48));
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
  expect(Math.abs((await widths(page)).box - 320)).toBeLessThanOrEqual(2);
  await page.keyboard.press("End");
  const max = Number(await divider.getAttribute("aria-valuemax"));
  await expect(divider).toHaveAttribute("aria-valuenow", String(max));
  // The conversation keeps room to read.
  expect((await main.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(400);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  const chosen = max - 4 * 16;
  await expect(divider).toHaveAttribute("aria-valuenow", String(chosen));
  await shot(page, "f04-thread-width-chosen");

  // 8. After a restart the thread opens at the width that was chosen.
  await electronApp.close();
  ({ electronApp, page } = await launch());
  await expect(page.getByTestId("panel")).toBeVisible();
  await expect(page.getByTestId("panel-divider")).toHaveAttribute("aria-valuenow", String(chosen));
  expect(Math.abs((await widths(page)).box - chosen)).toBeLessThanOrEqual(2);
  await shot(page, "f05-width-restored-after-restart");
  await electronApp.close();

  // 9. A second person in the context: the composer now explains asides.
  const file = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    JSON.stringify({ ...config, user: { id: "01KAHX9M8N7P6Q5R4S3T2V1W0X", name: "Sam" } }),
  );
  ({ electronApp, page } = await launch());
  const main2 = page.locator('[data-testid="conversation"][data-main="true"]');
  await expect(page.getByTestId("composer-hint")).toHaveCount(0);
  await main2.getByLabel("Message").fill("Hello, it's Sam");
  await page.keyboard.press("Alt+Enter");
  await expect(main2.getByTestId("aside-label")).toHaveCount(2);
  const hint = main2.getByTestId("composer-hint");
  await expect(hint).toContainText("To people and the agent");
  await expect(hint).toContainText("sends an aside, for people only");
  await shot(page, "f06-aside-hint-with-two-people");
  await electronApp.close();
});
