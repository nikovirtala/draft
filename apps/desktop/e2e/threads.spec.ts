import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

/**
 * Blocks, threads, the panel, real windows and focus, end to end in Electron against two scripted
 * ACP agents (real stdio processes) and the fake Kiro Remote. One conversation branches into two
 * threads on two agents; a status made in a thread is popped out into a real window; focus
 * folds the rest and leaving it restores the layout; and after a restart every placement and
 * window is where it was. Screenshots, the log and the agents' transcripts land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

const RUNNING = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
const WAITING = "01KAHX8A1B2C3D4E5F6G7H8J9K";

const dataDir = mkdtempSync(join(tmpdir(), "draft-e2e-threads-"));
const logA = join(artifacts, "t-fake-agent-a.jsonl");
const logB = join(artifacts, "t-fake-agent-b.jsonl");
const transcript = join(artifacts, "t-acp-transcript.jsonl");
const scriptA = join(here, "fake-acp-script.json");
const scriptB = join(here, "fake-acp-script-b.json");
const FAKE_AGENT = join(app, "test/fake-acp-agent.ts");

let kiro: FakeKiroRemote;

test.beforeAll(async () => {
  for (const f of [logA, logB, transcript]) writeFileSync(f, "");
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
  // A second agent a thread can run on: configured, the way a person would, in config.json.
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      agents: {
        "fake-b": {
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_ACP_SCRIPT: scriptB, FAKE_ACP_LOG: logB },
        },
      },
    }),
  );
});

test.afterAll(async () => {
  await kiro.stop();
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
      DRAFT_ACP_TRANSCRIPT: transcript,
      FAKE_ACP_SCRIPT: scriptA,
      FAKE_ACP_LOG: logA,
      DRAFT_KIRO_REMOTE_URL: kiro.baseUrl,
      DRAFT_KIRO_AUTH: "none",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1280, height: 840 });
  return { electronApp, page };
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(artifacts, `${name}.png`) });

// biome-ignore lint/suspicious/noExplicitAny: JSON records written by the fake agents, read in assertions
const records = (file: string): Record<string, any>[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

// biome-ignore lint/suspicious/noExplicitAny: log events, read in assertions
const readLog = (): Record<string, any>[] =>
  readFileSync(join(dataDir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

/** Where every block the page shows is placed, by block address. */
async function placements(page: Page): Promise<Record<string, string>> {
  const blocks = page.locator("[data-block][data-placement]");
  const out: Record<string, string> = {};
  for (let i = 0; i < (await blocks.count()); i++) {
    const block = blocks.nth(i);
    out[(await block.getAttribute("data-block")) ?? ""] =
      (await block.getAttribute("data-placement")) ?? "";
  }
  return out;
}

/** The pop-out windows of the app (every page but the main one), by their window titles. */
async function popped(electronApp: ElectronApplication, main: Page): Promise<Page[]> {
  return electronApp.windows().filter((w) => w !== main);
}

const windowTitles = (electronApp: ElectronApplication) =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map((w) => w.getTitle())
      .sort(),
  );

async function say(scope: Locator, text: string): Promise<void> {
  const box = scope.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

test("branch threads on two agents, pop a status out into a window, focus, and restart", async () => {
  let { electronApp, page } = await launch();
  const main = page.locator('[data-testid="conversation"][data-main="true"]');
  const panel = page.getByTestId("panel");

  // 1. A conversation with two live sessions in it.
  await expect(page.getByTestId("empty")).toBeVisible();
  await say(main, "Which Kiro sessions are open right now?");
  await expect(main.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  const mainStubs = main.getByTestId("message-agent").getByTestId("stub");
  await expect(mainStubs).toHaveCount(2);
  await expect(panel).toHaveCount(0);
  // Every placement is on screen: minimized, then inline once expanded.
  await expect(mainStubs.nth(0)).toHaveAttribute("data-placement", "minimized");
  await shot(page, "t01-minimized");
  await mainStubs.nth(0).getByRole("button", { name: "Expand" }).click();
  await expect(mainStubs.nth(0)).toHaveAttribute("data-placement", "inline");
  await expect(mainStubs.nth(0).getByRole("button")).toHaveCount(3);
  await expect(mainStubs.nth(0).getByRole("button", { name: "Minimize" })).toBeVisible();
  await shot(page, "t02-inline");
  await mainStubs.nth(0).getByRole("button", { name: "Minimize" }).click();
  await expect(mainStubs.nth(0)).toHaveAttribute("data-placement", "minimized");

  // 2. Branch a thread off that answer. It opens in the panel, on the default agent, and the
  // conversation keeps a stub where it branched.
  const answer = main.getByTestId("message-agent").first();
  await answer.hover();
  await answer.getByTestId("branch").click();
  await expect(answer.getByTestId("branch-agents")).toBeVisible();
  await shot(page, "t03-choose-agent");
  await answer.getByRole("menuitem", { name: /the agent \(default\)/ }).click();
  await expect(panel).toBeVisible();
  const threadA = panel.getByTestId("conversation");
  await expect(panel.getByTestId("thread-agent")).toHaveValue("fake");
  await expect(main.getByTestId("thread-stub")).toHaveCount(1);
  await expect(main.getByTestId("thread-stub")).toHaveAttribute("data-placement", "panel");
  await expect(main.getByTestId("thread-stub").getByTestId("stub-where")).toHaveText(
    "In the panel",
  );
  // The main conversation stays on the left, untouched.
  await expect(main.getByTestId("message-agent")).toHaveCount(1);

  // 3. Continue the thread in the panel. Its own agent session answers; a status made in the
  // thread can't take the panel, because the thread holds it.
  await say(threadA, "Give me the detail on the running one");
  await expect(threadA.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  const inThread = threadA.getByTestId("stub");
  await expect(inThread).toHaveCount(1);
  await expect(inThread.getByRole("button", { name: "Open in panel" })).toHaveCount(0);
  await expect(inThread.getByRole("button", { name: "Pop out" })).toBeVisible();
  await expect(main.getByTestId("message-user")).toHaveCount(1);
  await shot(page, "t04-thread-in-panel-with-live-stub");

  // 4. Pop that status out of the thread: a real window, titled with what it is and where it
  // came from, and a stub left behind in the thread.
  const threadTitle = (await panel.getByTestId("panel-title").textContent()) ?? "";
  // A thread is named after the first line of the message it branched off.
  expect(threadTitle).toBe("Let me check Kiro Remote.");
  await inThread.getByRole("button", { name: "Pop out" }).click();
  await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBe(2);
  const [win] = await popped(electronApp, page);
  if (win === undefined) throw new Error("no window");
  await win.waitForLoadState("domcontentloaded");
  const title = `Fix the flaky end-to-end test · from thread “${threadTitle}”`;
  await expect(win.getByTestId("window-title")).toHaveText(title);
  expect(await windowTitles(electronApp)).toContain(title);
  expect(await win.title()).toBe(title);
  await expect(win.getByTestId("block-full")).toContainText("Fix the flaky end-to-end test");
  // A window has one icon: close.
  await expect(win.getByTestId("block-full").getByRole("button")).toHaveCount(1);
  await expect(win.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(inThread).toHaveAttribute("data-placement", "window");
  await expect(inThread.getByTestId("stub-where")).toHaveText("In a window");
  await shot(win, "t05-window-titled-with-its-origin");
  await shot(page, "t06-stub-left-in-the-thread");
  // The window follows the live status.
  kiro.update(RUNNING, { status: "awaiting_permission", pendingPermissions: 1 });
  await expect(win.getByTestId("block-full")).toHaveAttribute("data-kind", "status");
  await expect(win.getByTestId("block-full").getByTestId("stub-status")).toHaveText(
    "Waiting for you",
  );

  // 5. Close the panel: the thread goes back to a one-line stub in the main conversation.
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  const stubA = main.getByTestId("thread-stub").first();
  await expect(stubA).toHaveAttribute("data-placement", "minimized");
  await expect(stubA.getByTestId("thread-artifacts")).toHaveText("1 artifact");
  await shot(page, "t07-thread-minimized-in-the-conversation");

  // 6. A second thread from the same message, on the other agent; it takes the panel.
  await answer.hover();
  await answer.getByTestId("branch").click();
  await answer.getByRole("menuitem", { name: "fake-b" }).click();
  await expect(panel).toBeVisible();
  await expect(main.getByTestId("thread-stub")).toHaveCount(2);
  await expect(panel.getByTestId("thread-agent")).toHaveValue("fake-b");
  const stubB = main.getByTestId("thread-stub").nth(1);
  await expect(stubB).toHaveAttribute("data-placement", "panel");
  const threadB = panel.getByTestId("conversation");
  await say(threadB, "I'd like a second opinion");
  await expect(threadB.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  await expect(threadB.getByTestId("message-agent")).toContainText("second opinion");

  // 7. Live state while the thread is minimized: it works, then has something new.
  await say(threadB, "answer slowly please");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(stubB).toHaveAttribute("data-placement", "minimized");
  await expect(stubB.getByText("Working")).toBeVisible({ timeout: 10_000 });
  await expect(stubB.getByTestId("thread-new")).toHaveText("1 new", { timeout: 30_000 });
  await shot(page, "t08-two-live-thread-stubs");

  // 8. Interrupts arrive in the thread they belong to: a call that ran unasked in thread A, and
  // a permission request in thread B. The first is in A's own conversation, the second in B's.
  await stubA.getByRole("button", { name: "Open in panel" }).click();
  await expect(panel.getByTestId("thread-agent")).toHaveValue("fake");
  await say(panel.getByTestId("conversation"), "Please clean up the old session.");
  const anomaly = panel.locator('[data-testid="interrupt"][data-cause="unasked-call"]');
  await expect(anomaly).toContainText("without asking you first", { timeout: 30_000 });
  // The main conversation has only what arose in it: the two hosted sessions' permission requests.
  await expect(
    main.locator('[data-testid="interrupt"]:not([data-cause="permission"])'),
  ).toHaveCount(0);
  await stubB.getByRole("button", { name: "Open in panel" }).click();
  await expect(panel.getByTestId("thread-agent")).toHaveValue("fake-b");
  await say(panel.getByTestId("conversation"), "Please launch a session to update the README.");
  await expect(panel.getByTestId("prompt")).toContainText("launch a Kiro session", {
    timeout: 30_000,
  });
  await expect(main.getByTestId("prompt")).toHaveCount(0);
  // Two hosted permission requests in the main conversation, the unasked call in thread A and the
  // local permission request in thread B.
  await expect(page.getByTestId("attention-count")).toHaveText("4 need you");
  await shot(page, "t09-interrupts-in-their-threads");

  // 9. Focus on the thread in the panel, with what is selected: everything else folds, only this
  // thread's interrupts show in full, and the count says what is elsewhere.
  const before = await placements(page);
  await panel.getByLabel("Message").focus();
  await page.keyboard.press("Control+.");
  await expect(page.getByTestId("app")).toHaveAttribute("data-focused", "true");
  await expect(page.getByTestId("attention-count")).toHaveText("1 in focus, 3 elsewhere");
  await expect(page.getByTestId("focus-mark")).toContainText("In focus");
  await expect(panel.getByTestId("prompt")).toBeVisible();
  // The window folded with everything else: no real window is left open.
  await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBe(1);
  const inFocus = await placements(page);
  expect(inFocus[stubA ? ((await stubA.getAttribute("data-block")) ?? "") : ""]).toBe("minimized");
  await shot(page, "t10-focus-with-the-filtered-count");
  // Another conversation's interrupt is not shown in full while focused: open A's block can't
  // happen, and nothing outside the focus can be moved.
  await expect(mainStubs.nth(0)).toHaveAttribute("data-placement", "minimized");
  await mainStubs.nth(0).getByRole("button", { name: "Expand" }).click();
  await expect(mainStubs.nth(0)).toHaveAttribute("data-placement", "minimized");
  // Esc leaves focus, and the layout is exactly as it was.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("app")).toHaveAttribute("data-focused", "false");
  await expect.poll(() => placements(page)).toEqual(before);
  await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBe(2);
  await expect(page.getByTestId("attention-count")).toHaveText("4 need you");
  expect(await windowTitles(electronApp)).toContain(title);
  await shot(page, "t11-focus-left-layout-restored");

  // 10. Switch thread A to the other agent: its size is shown first, the switch is explicit, and
  // the new session starts from the log.
  await panel.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(panel.getByTestId("message-agent")).toHaveCount(3, { timeout: 30_000 });
  await stubA.getByRole("button", { name: "Open in panel" }).click();
  await expect(panel.getByTestId("thread-agent")).toHaveValue("fake");
  await panel.getByTestId("thread-agent").selectOption("fake-b");
  const card = panel.getByTestId("switch-card");
  await expect(card.getByTestId("switch-size")).toContainText("4 messages");
  await expect(card.getByTestId("switch-size")).toContainText("1 open item");
  await shot(page, "t12-switch-shows-its-size");
  await card.getByRole("button", { name: "Switch", exact: true }).click();
  await expect(panel.getByTestId("thread-agent")).toHaveValue("fake-b");
  await say(panel.getByTestId("conversation"), "Please continue where we were");
  await expect(panel.getByTestId("message-agent").last()).toContainText("Picking up the thread", {
    timeout: 30_000,
  });
  await shot(page, "t13-thread-continues-on-the-other-agent");

  // 11. Resize the window, then restart: every placement, the window and its bounds are as they were.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== "draft");
    w?.setBounds({ x: 120, y: 90, width: 640, height: 420 });
  });
  await page.waitForTimeout(600);
  const layoutBefore = await placements(page);
  const titlesBefore = await windowTitles(electronApp);
  await electronApp.close();
  // The window's bounds are kept on this device, in the view-state store.
  const device = new DatabaseSync(join(dataDir, "device.db"));
  device.close();

  ({ electronApp, page } = await launch());
  const main2 = page.locator('[data-testid="conversation"][data-main="true"]');
  await expect(main2.getByTestId("thread-stub")).toHaveCount(2);
  await expect(page.getByTestId("panel")).toBeVisible();
  await expect(page.getByTestId("panel").getByTestId("panel-title")).toHaveText(threadTitle);
  await expect.poll(() => electronApp.windows().length, { timeout: 20_000 }).toBe(2);
  await expect.poll(() => placements(page)).toEqual(layoutBefore);
  expect(await windowTitles(electronApp)).toEqual(titlesBefore);
  const bounds = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((x) => x.getTitle() !== "draft")
      ?.getBounds(),
  );
  expect(bounds).toEqual({ x: 120, y: 90, width: 640, height: 420 });
  await expect(page.getByTestId("panel").getByTestId("thread-agent")).toHaveValue("fake-b");
  const [win2] = await popped(electronApp, page);
  if (win2 === undefined) throw new Error("no window after restart");
  await expect(win2.getByTestId("window-title")).toHaveText(title);
  await shot(page, "t14-layout-after-restart");
  await shot(win2, "t15-window-after-restart");

  // Closing a window returns its block to the place it came from.
  await win2.getByRole("button", { name: "Close" }).click();
  await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBe(1);
  // The first answer's status is the one that was in the window; it came from minimized.
  await expect(page.getByTestId("panel").getByTestId("stub").first()).toHaveAttribute(
    "data-placement",
    "minimized",
  );
  await electronApp.close();

  // Evidence. No placement, window or focus event is in the log: that is view state, per device.
  const log = readLog();
  const types = [...new Set(log.map((e) => e.type))].sort();
  writeFileSync(join(artifacts, "t-log-event-types.txt"), `${types.join("\n")}\n`);
  const view = /placement|window|focus|layout|panel|minimi|bounds|pop/i;
  expect(types.filter((t) => view.test(t))).toEqual([]);
  expect(
    readFileSync(join(dataDir, "log.jsonl"), "utf8").match(
      /"type":"[^"]*(placement|window|focus|layout|panel)[^"]*"/gi,
    ),
  ).toBeNull();
  expect(types).toContain("agent.selected");
  writeFileSync(
    join(artifacts, "t-log-grep.txt"),
    [
      '$ grep -ciE \'"type":"[a-z._]*(placement|window|focus|layout|panel|minimi|bounds|pop)\' log.jsonl',
      String(
        readFileSync(join(dataDir, "log.jsonl"), "utf8")
          .split("\n")
          .filter((l) =>
            /"type":"[a-z._]*(placement|window|focus|layout|panel|minimi|bounds|pop)/i.test(l),
          ).length,
      ),
      "",
      "event types in the log:",
      ...types,
      "",
    ].join("\n"),
  );
  writeFileSync(join(artifacts, "t-log.jsonl"), readFileSync(join(dataDir, "log.jsonl"), "utf8"));

  // The agents' transcripts: one ACP session per conversation, and the switch.
  const lineFor = (agent: string, e: Record<string, unknown>): string => {
    const blocks = Array.isArray(e.blocks) ? (e.blocks as string[]) : [];
    const last = blocks.at(-1) ?? "";
    return [
      agent,
      String(e.event),
      e.sessionId === undefined ? "" : `session ${String(e.sessionId)}`,
      e.event === "session/prompt" ? JSON.stringify(last.slice(0, 70)) : "",
    ]
      .filter((x) => x !== "")
      .join("  ");
  };
  const wanted = new Set(["initialize", "session/new", "session/prompt", "session/close"]);
  const summary = [
    ...records(logA)
      .filter((e) => wanted.has(e.event))
      .map((e) => lineFor("fake  ", e)),
    "",
    ...records(logB)
      .filter((e) => wanted.has(e.event))
      .map((e) => lineFor("fake-b", e)),
    "",
  ].join("\n");
  writeFileSync(join(artifacts, "t-acp-sessions.txt"), summary);

  const a = records(logA);
  const b = records(logB);
  const conversations = log
    .filter((e) => e.type === "agent.session_started")
    .map((e) => [e.conversation, e.data.agent]);
  // main + thread A on fake, thread B on fake-b, then thread A again on fake-b after the switch.
  expect(conversations.map((c) => c[1])).toEqual(["fake", "fake", "fake-b", "fake-b"]);
  expect(new Set(conversations.map((c) => c[0])).size).toBe(3);
  expect(a.filter((e) => e.event === "session/new")).toHaveLength(2);
  expect(b.filter((e) => e.event === "session/new")).toHaveLength(2);
  // The switch is in the log, by the person, and the old session was closed.
  const switched = log.filter((e) => e.type === "agent.selected");
  expect(switched.map((e) => [e.data.agent, e.data.reason])).toEqual([
    ["fake", "thread-start"],
    ["fake-b", "thread-start"],
    ["fake-b", "switch"],
  ]);
  expect(switched[2]?.actor.kind).toBe("user");
  expect(a.some((e) => e.event === "session/close")).toBe(true);
  // The session that took over started from the projection of the thread.
  const takeover = b.filter((e) => e.event === "session/prompt").at(-1);
  expect(((takeover?.blocks ?? []) as string[]).join("\n")).toContain(
    "Give me the detail on the running one",
  );
  expect(readFileSync(transcript, "utf8")).not.toMatch(/Bearer [A-Za-z0-9]/);
});
