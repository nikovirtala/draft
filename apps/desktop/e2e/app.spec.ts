import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRawLines, FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * draft end to end, in Electron, against the scripted fake ACP agent (a real stdio process) and the
 * fake Kiro Remote MCP server, which the agent reaches over HTTP. Screenshots and the log, ACP
 * transcript and trace evidence land in e2e/artifacts.
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
const acpTranscript = join(artifacts, "acp-transcript.jsonl");
const agentLog = join(artifacts, "fake-agent.jsonl");
const MARKER = "zanzibar-aside-7731";

test.beforeAll(async () => {
  writeFileSync(spanFile, "");
  writeFileSync(acpTranscript, "");
  writeFileSync(agentLog, "");
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
  // Without a display (a sandbox with no Xvfb), Chromium's headless platform renders offscreen.
  const display = process.env.DISPLAY === undefined ? ["--ozone-platform=headless"] : [];
  const electronApp = await electron.launch({
    args: [join(app, "out/main/index.js"), "--no-sandbox", "--disable-gpu", ...display],
    cwd: app,
    env: {
      ...process.env,
      DRAFT_DATA_DIR: dataDir,
      // The scripted ACP agent, started the way draft starts kiro-cli: a process on stdio.
      DRAFT_AGENT: "fake",
      DRAFT_AGENT_COMMAND: process.execPath,
      DRAFT_AGENT_ARGS: JSON.stringify([join(app, "test/fake-acp-agent.ts")]),
      DRAFT_ACP_TRANSCRIPT: acpTranscript,
      FAKE_ACP_SCRIPT: join(here, "fake-acp-script.json"),
      FAKE_ACP_LOG: agentLog,
      DRAFT_KIRO_REMOTE_URL: kiro.baseUrl,
      DRAFT_KIRO_AUTH: "none",
      DRAFT_POLL_BASE_MS: "300",
      DRAFT_POLL_MAX_MS: "1200",
      DRAFT_SPAN_FILE: spanFile,
      DRAFT_ENVIRONMENT: "e2e",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    },
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1120, height: 840 });
  return { electronApp, page };
}

// biome-ignore lint/suspicious/noExplicitAny: JSON records written by the fake agent, read in assertions
const agentRecords = (): Record<string, any>[] =>
  readFileSync(agentLog, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

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
  // Minimized, a status has the model's three icons: expand, open in panel, pop out.
  await expect(stubs.nth(0).getByRole("button")).toHaveCount(3);
  await expect(stubs.nth(0).getByRole("button", { name: "Expand" })).toBeVisible();
  await expect(stubs.nth(0).getByRole("button", { name: "Open in panel" })).toBeVisible();
  await expect(stubs.nth(0).getByRole("button", { name: "Pop out" })).toBeVisible();
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
  await page.getByTestId("message-agent").nth(1).scrollIntoViewIfNeeded();
  await shot(page, "05b-step-completed-after-permission");

  // The agent is named with the model it reports, and is active.
  const agentState = page.getByTestId("agent-state");
  await expect(agentState).toHaveAttribute("data-state", "active");
  await expect(agentState).toContainText("fake-model-1");

  // 6. An aside (⌥↵) is for people only: no turn starts, and the agent never reads it.
  const promptsBefore = agentRecords().filter((e) => e.event === "session/prompt").length;
  await page.getByLabel("Message").fill(`${MARKER}: should we ask about the README first?`);
  await page.keyboard.press("Alt+Enter");
  await expect(page.getByTestId("aside-label")).toHaveCount(1);
  await expect(page.getByTestId("message-user").last()).toHaveAttribute("data-audience", "people");
  await page.waitForTimeout(500);
  expect(agentRecords().filter((e) => e.event === "session/prompt")).toHaveLength(promptsBefore);

  // 7. Paused: messages go to people only, until @agent reaches through for one message.
  await agentState.getByRole("button", { name: "Pause the agent" }).click();
  await expect(agentState).toHaveAttribute("data-state", "paused");
  await expect(page.getByTestId("composer-hint")).toContainText("paused");
  await page.getByLabel("Message").fill("Let's agree on the README wording before anything else.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("aside-label")).toHaveCount(2);
  await page.getByLabel("Message").fill("@agent which one is waiting for me?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("message-agent")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("message-agent").nth(2)).toContainText("release notes session");
  await expect(agentState).toHaveAttribute("data-state", "paused");
  await shot(page, "06-aside-and-paused");
  await agentState.getByRole("button", { name: "Play the agent" }).click();
  await expect(agentState).toHaveAttribute("data-state", "active");
  // Nothing of the aside or the paused talk reached the agent.
  const sent = readFileSync(agentLog, "utf8");
  expect(sent).not.toContain(MARKER);
  expect(sent).not.toContain("agree on the README wording");

  // 8. A call that ran without asking is an anomaly, shown as an interrupt: no step came first.
  await page.getByLabel("Message").fill("Please clean up the old session.");
  await page.keyboard.press("Enter");
  const anomaly = page.locator('[data-testid="interrupt"][data-cause="unasked-call"]');
  await expect(anomaly).toContainText("without asking you first", { timeout: 30_000 });
  await expect(page.getByTestId("message-agent")).toHaveCount(4, { timeout: 30_000 });
  await anomaly.scrollIntoViewIfNeeded();
  await shot(page, "07-anomaly-interrupt");
  await electronApp.close();

  // 9. After a restart, the conversation comes back from the log.
  ({ electronApp, page } = await launch());
  await expect(page.getByTestId("message-user")).toHaveCount(6);
  await expect(page.getByTestId("message-agent")).toHaveCount(4);
  await expect(page.getByTestId("aside-label")).toHaveCount(2);
  await expect(page.getByTestId("agent-state")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("message-agent").nth(0).getByTestId("stub")).toHaveCount(2);
  await expect(page.getByTestId("stub").nth(0)).toHaveAttribute(
    "data-status",
    "awaiting_permission",
  );
  // Placement is per-device view state and survives too.
  await expect(page.getByTestId("stub").nth(0).getByTestId("stub-details")).toBeVisible();
  await page.getByTestId("message-agent").nth(0).scrollIntoViewIfNeeded();
  await shot(page, "08-restored-after-restart");

  // The user is a stable local identity from config.json, and only the user's events carry it.
  const user = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).user;
  expect(user.id).toMatch(/^[0-9a-z]{26}$/);
  const logPath = join(dataDir, "log.jsonl");
  const readLog = () =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  for (const e of readLog()) {
    if (e.actor.kind === "user")
      expect(e.actor).toEqual({ kind: "user", id: user.id, name: user.name });
    else expect(e.actor.id).not.toBe(user.id);
  }

  // 10. draft dies while a step runs: Kiro Remote takes the launch, but its answer never comes back.
  const launches = () => kiro.calls.filter((c) => c.tool === "kiro_launch_session").length;
  expect(launches()).toBe(1);
  kiro.hang.add("kiro_launch_session");
  await page.getByLabel("Message").fill("Please launch a session to update the README.");
  await page.keyboard.press("Enter");
  await page.getByTestId("prompt").getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(launches, { timeout: 30_000 }).toBe(2);
  const dying = electronApp.process();
  const exited = new Promise((resolve) => dying.once("exit", resolve));
  dying.kill("SIGKILL");
  await exited;
  kiro.hang.clear();
  expect(readLog().at(-1)?.type).toBe("step.started");

  // The new agent session started from the log's projection: it saw the earlier turns (and the
  // anomaly), never the aside.
  const prompts = agentRecords().filter((e) => e.event === "session/prompt");
  const restartPrompt = prompts.at(-1)?.blocks[0] as string;
  expect(restartPrompt).toContain("User: Which Kiro sessions are open right now?");
  expect(restartPrompt).toContain("UNASKED: mcp__kiro-remote__kiro_delete_session");
  expect(restartPrompt).not.toContain(MARKER);

  // After the restart the step is an interrupt, and it is never run again.
  ({ electronApp, page } = await launch());
  const interrupt = page.locator('[data-testid="interrupt"][data-cause="unfinished-step"]');
  await expect(interrupt).toContainText("may or may not have happened");
  await expect(interrupt).toContainText("Update the README for the second slice");
  await page.waitForTimeout(3000);
  expect(launches()).toBe(2);
  await interrupt.scrollIntoViewIfNeeded();
  await shot(page, "09-interrupted-step-after-crash");
  await electronApp.close();
  expect(launches()).toBe(2);

  // 11. A newer draft wrote an event this one doesn't know: it is kept and shown, not refused.
  const conversation = readLog()[1].data.conversation as string;
  writeFileSync(
    logPath,
    appendRawLines(readFileSync(logPath, "utf8"), [
      {
        id: "01M8000000000000000000000A",
        at: new Date().toISOString(),
        address: `${conversation}/01m8000000000000000000000a@1`,
        conversation,
        type: "thread.summarized",
        schema: 1,
        actor: { kind: "agent", id: "draft-agent", model: "claude-opus-6", version: "9.9.9" },
        traceId: null,
        data: { summary: "Written by a newer draft" },
      },
    ]),
  );
  ({ electronApp, page } = await launch());
  await expect(page.getByTestId("unknown-event")).toContainText("thread.summarized");
  await expect(page.getByTestId("message-user")).toHaveCount(7);
  await expect(page.getByTestId("interrupt")).toHaveCount(2);
  await page.getByTestId("unknown-event").scrollIntoViewIfNeeded();
  await shot(page, "10-unknown-event-kept");
  await electronApp.close();

  // 12. The last write never finished: its half line is moved aside and the log opens.
  const complete = readFileSync(logPath, "utf8");
  const torn =
    '{"id":"01M8000000000000000000000B","at":"2026-11-21T10:00:00.000Z","type":"message.po';
  writeFileSync(logPath, complete + torn);
  ({ electronApp, page } = await launch());
  const recovered = page.getByTestId("log-recovered");
  await expect(recovered).toContainText("draft recovered the log");
  await expect(recovered).toContainText(`${torn.length} bytes`);
  await expect(page.getByTestId("message-user")).toHaveCount(7);
  await recovered.scrollIntoViewIfNeeded();
  await shot(page, "11-recovered-torn-log");
  await electronApp.close();
  const sidecars = readdirSync(dataDir).filter((f) => f.startsWith("log.jsonl.torn-"));
  expect(sidecars).toHaveLength(1);
  expect(readFileSync(join(dataDir, sidecars[0] as string), "utf8")).toBe(torn);
  const recoveredEvent = readLog().at(-1);
  expect(recoveredEvent.type).toBe("log.recovered");
  expect(recoveredEvent.data.sidecar).toBe(sidecars[0]);

  // Evidence: the events of the turn that launched a session over ACP (one trace), and the steps.
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const firstStep = readLog().find((e) => e.type === "step.started");
  writeFileSync(
    join(artifacts, "log-excerpt.jsonl"),
    `${lines.filter((l) => JSON.parse(l).traceId === firstStep.traceId).join("\n")}\n`,
  );
  writeFileSync(
    join(artifacts, "steps-excerpt.jsonl"),
    `${lines.filter((l) => /"type":"step\./.test(l)).join("\n")}\n`,
  );
  writeFileSync(join(artifacts, "log.jsonl"), `${lines.join("\n")}\n`);
  const steps = readLog().filter((e) => e.type.startsWith("step."));
  expect(steps.map((e) => e.type)).toEqual(["step.started", "step.completed", "step.started"]);
  expect(steps[1].data.started).toBe(steps[0].address);
  const anomalies = readLog().filter((e) => e.type === "agent.anomaly");
  expect(anomalies.map((e) => e.data.name)).toEqual(["mcp__kiro-remote__kiro_delete_session"]);
  // Every message says who it was for; two were for people only.
  const posted = readLog().filter((e) => e.type === "message.posted");
  expect(posted.every((e) => e.schema === 2 && typeof e.data.audience?.agent === "boolean")).toBe(
    true,
  );
  expect(posted.filter((e) => e.data.audience.agent === false)).toHaveLength(2);
  // The agent's actor names it, and the model it reported.
  const agentMessage = posted.find((e) => e.data.role === "agent");
  expect(agentMessage.actor).toEqual({
    kind: "agent",
    id: "fake",
    model: "fake-model-1",
    version: "fake-acp-agent 1.0.0",
  });
  // draft switched the agent's autopilot off before its first prompt, so it asked.
  expect(agentRecords().find((e) => e.event === "session/set_config_option")).toMatchObject({
    configId: "autopilot",
    value: "off",
  });
  // The ACP transcript never carries the bearer token.
  expect(readFileSync(acpTranscript, "utf8")).not.toMatch(/Bearer [A-Za-z0-9]/);

  // Every span carries draft's deploy provenance.
  const spans = readFileSync(spanFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(spans.length).toBeGreaterThan(0);
  // The span of one ACP turn: what the agent reported for usage, and nothing estimated.
  const agentTurn = spans.find(
    (sp) => sp.name === "draft.agent.turn" && sp.attributes["draft.tool_calls"] === 1,
  );
  expect(agentTurn.attributes).toMatchObject({
    "draft.agent": "fake",
    "gen_ai.response.model": "fake-model-1",
    "draft.usage.reported": true,
    "gen_ai.usage.input_tokens": 1200,
    "gen_ai.usage.output_tokens": 85,
    "draft.usage.cost.credit": 0.031,
  });
  writeFileSync(
    join(artifacts, "span-acp-turn.json"),
    `${JSON.stringify(
      spans.filter((sp) => sp.traceId === agentTurn.traceId),
      null,
      2,
    )}\n`,
  );
  for (const span of spans) {
    expect(span.resource["service.version"]).toBe("0.0.0");
    expect(span.resource["vcs.ref.head.revision"]).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(span.resource["vcs.repository.url.full"]).toBe("https://github.com/nikovirtala/draft");
    expect(span.resource["deployment.environment.name"]).toBe("e2e");
  }

  // 13. A tampered log is refused, and the window says why.
  const tampered = lines.map((l: string) =>
    l.replace("Which Kiro sessions are open right now?", "Which sessions are open?"),
  );
  writeFileSync(join(dataDir, "log.jsonl"), `${tampered.join("\n")}\n`);
  ({ electronApp, page } = await launch());
  await expect(page.getByTestId("refused")).toContainText("was changed after it was written");
  await expect(page.getByTestId("refused")).toContainText("event 3");
  await shot(page, "12-tampered-log-refused");
  await electronApp.close();
});
