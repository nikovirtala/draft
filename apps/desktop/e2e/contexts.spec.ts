import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileLogStore, Projection, Workspace } from "@nikovirtala/draft-core";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * Contexts end to end, in Electron, on the scripted fake ACP agent: open a folder from the command
 * line and trust it, see where the agent works, open a second context by a sentence and a
 * confirmation, hand a third folder to the running app from a second launch, refer from one
 * context to an item of another, restart and find every context as it was, and open the log that
 * was there before contexts existed without changing a byte of it. Screenshots, the trust event
 * and the agent's record land in e2e/artifacts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const artifacts = join(here, "artifacts", "contexts");
mkdirSync(artifacts, { recursive: true });

const MARKER = "quokka-marker-4417";
const root = mkdtempSync(join(tmpdir(), "draft-contexts-"));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
const agentLog = join(artifacts, "fake-agent.jsonl");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A folder with a name worth a context's, optionally a git remote with credentials in it. */
function folder(name: string, remote?: string): string {
  const dir = join(root, "code", name);
  mkdirSync(dir, { recursive: true });
  if (remote !== undefined) {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  }
  return realpathSync(dir);
}

const longplay = folder("longplay", "https://niko:ghp_secret@github.com/niko/longplay.git");
const harbour = folder("harbour");
const scratch = folder("scratch");

/** The log draft wrote before contexts existed: one log, the context "local", in the data directory. */
async function writeLegacyLog(): Promise<void> {
  const log = FileLogStore.open(join(dataDir, "log.jsonl"));
  const projection = Projection.open(join(dataDir, "views.db"));
  const agent = {
    id: "fake",
    model: "fake-model-1",
    version: "1",
    async *runTurn() {
      yield { type: "text-delta" as const, text: "Written before contexts." };
      yield {
        type: "done" as const,
        text: "Written before contexts.",
        usage: null,
        model: "fake-model-1",
      };
    },
    closeConversation() {},
    async close() {},
  };
  const workspace = await Workspace.open({
    log,
    projection,
    agent,
    resolvers: [],
    user: { kind: "user", id: "01kahx0000000000000000user", name: "Niko" },
  });
  await workspace.main.submit("Remember the old log.");
  await workspace.close();
  log.close();
  projection.close();
}

function env(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DRAFT_DATA_DIR: dataDir,
    DRAFT_AGENT: "fake",
    DRAFT_AGENT_COMMAND: process.execPath,
    DRAFT_AGENT_ARGS: JSON.stringify([join(app, "test/fake-acp-agent.ts")]),
    FAKE_ACP_SCRIPT: join(here, "fake-acp-script-contexts.json"),
    FAKE_ACP_LOG: agentLog,
    GITHUB_TOKEN: "fake-token",
    DRAFT_POLL_BASE_MS: "300",
    DRAFT_POLL_MAX_MS: "1200",
    DRAFT_ENVIRONMENT: "e2e",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
  };
}

const flags = (): string[] => [
  "--no-sandbox",
  "--disable-gpu",
  ...(process.env.DISPLAY === undefined ? ["--ozone-platform=headless"] : []),
];

async function launch(...args: string[]): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(app, "out/main/index.js"), ...flags(), ...args],
    cwd: app,
    env: env(),
  });
}

/** The window of a context, found by the name it shows. */
async function windowOf(electronApp: ElectronApplication, name: string): Promise<Page> {
  const found = async () => {
    for (const page of electronApp.windows()) {
      const label = page.getByTestId("context-name").or(page.getByTestId("trust-context"));
      if ((await label.count().catch(() => 0)) > 0 && (await label.first().innerText()) === name)
        return page;
    }
    return null;
  };
  await expect.poll(async () => (await found()) !== null, { timeout: 20_000 }).toBe(true);
  const page = (await found()) as Page;
  await page.setViewportSize({ width: 1000, height: 760 });
  return page;
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(artifacts, `${name}.png`) });

async function say(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

// biome-ignore lint/suspicious/noExplicitAny: JSON records written by the fake agent, read in assertions
const agentRecords = (): Record<string, any>[] =>
  readFileSync(agentLog, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

/** What the agent of the context working in `cwd` was told, in every session it started. */
function toldIn(cwd: string): string {
  const records = agentRecords();
  const sessions = new Set(
    records
      .filter((e) => e.event === "session/new" && e.params.cwd === cwd)
      .map((e) => e.sessionId),
  );
  return records
    .filter((e) => e.event === "session/prompt" && sessions.has(e.sessionId))
    .flatMap((e) => e.blocks as string[])
    .join("\n");
}

test("contexts: open a folder, trust it, work in it, open another, refer across, restart", async () => {
  writeFileSync(agentLog, "");
  await writeLegacyLog();
  const legacyLog = join(dataDir, "log.jsonl");
  const legacyHash = sha(legacyLog);
  const legacyBytes = readFileSync(legacyLog);

  // 1. Launched with a folder: the first time, draft asks. The path and the remote show, without
  // the credentials that were in the config.
  let electronApp = await launch(longplay);
  let a = await windowOf(electronApp, "longplay");
  await expect(a.getByTestId("trust-step")).toBeVisible();
  await expect(a.getByTestId("trust-path")).toHaveText(longplay);
  await expect(a.getByTestId("trust-remote")).toHaveText("https://github.com/niko/longplay.git");
  await shot(a, "c01-trust-step");
  await a.getByTestId("trust-accept").click();
  await expect(a.getByTestId("empty")).toBeVisible();
  await expect(a.getByTestId("context-name")).toHaveText("longplay");
  await expect(a.getByTestId("context-folder")).toHaveText("longplay");

  // 2. The agent works in that folder.
  await say(a, "Where are you working right now?");
  await expect(a.getByTestId("message-agent")).toHaveCount(1, { timeout: 30_000 });
  await expect(a.getByTestId("message-agent")).toContainText(`I am working in ${longplay}`);

  // 3. A sentence asks for a second context. draft proposes; nothing opens until one action.
  await say(a, `new context for ${harbour}`);
  const proposal = a.getByTestId("proposal");
  await expect(proposal).toBeVisible();
  await expect(a.getByTestId("proposal-target")).toHaveText(harbour);
  await expect(a.getByTestId("aside-label")).toBeVisible();
  await shot(a, "c02-proposal");
  expect(electronApp.windows()).toHaveLength(1);
  await proposal.getByTestId("proposal-open").click();
  let b = await windowOf(electronApp, "harbour");
  await expect(b.getByTestId("trust-remote")).toHaveText("none");
  await shot(b, "c03-trust-step-no-remote");
  await b.getByTestId("trust-accept").click();
  await expect(b.getByTestId("context-folder")).toHaveText("harbour");
  await say(b, "Where are you working right now?");
  await expect(b.getByTestId("message-agent")).toContainText(`I am working in ${harbour}`, {
    timeout: 30_000,
  });
  await say(b, `The deploy key is ${MARKER}`);
  await expect(b.getByTestId("message-agent")).toHaveCount(2, { timeout: 30_000 });
  const markerMessage = b.getByTestId("message-user").filter({ hasText: MARKER });
  const address = (await markerMessage.getAttribute("data-address")) as string;
  expect(address).toMatch(/^harbour\/[0-9a-z]+\/[0-9a-z]+@1$/);
  await shot(b, "c04-second-context");

  // 4. A reference from longplay to that item shows the other context's name and a snapshot.
  await say(a, `What do you make of ${address}?`);
  const item = a.getByTestId("context-item");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-context", "harbour");
  await expect(item.getByTestId("context-item-context")).toHaveText("harbour");
  await expect(item.getByTestId("context-item-title")).toContainText(MARKER);
  await expect(item.getByTestId("context-item-snapshot")).toContainText(address);
  await expect(a.getByTestId("message-agent")).toHaveCount(2, { timeout: 30_000 });
  await shot(a, "c05-cross-context-reference");
  // The other context's words are in the snapshot on screen, and nowhere in what longplay's agent
  // was told.
  expect(toldIn(longplay)).not.toContain(MARKER);
  expect(toldIn(harbour)).toContain(MARKER);

  // 5. Pulling it in is a person's act: the next session of longplay's agent starts with it.
  await item.getByTestId("context-item-pull").click();
  await expect(item.getByTestId("context-item-pulled")).toBeVisible();
  await say(a, "Use that, and tell me where you are.");
  await expect(a.getByTestId("message-agent")).toHaveCount(3, { timeout: 30_000 });
  expect(toldIn(longplay)).toContain(MARKER);

  // 6. Following it opens the context that is open already: its window comes forward.
  const windowsBefore = electronApp.windows().length;
  await item.getByTestId("context-item-open").click();
  await expect.poll(() => electronApp.windows().length).toBe(windowsBefore);

  // 7. A second launch with a folder hands it to the running draft instead of starting another.
  const executable = await electronApp.evaluate(() => process.execPath);
  const second = spawn(executable, [join(app, "out/main/index.js"), ...flags(), scratch], {
    env: env(),
    cwd: app,
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => second.once("exit", resolve));
  const c = await windowOf(electronApp, "scratch");
  expect(await exited).toBe(0);
  await expect(c.getByTestId("trust-path")).toHaveText(scratch);
  // Not trusting still opens the context, and its agent stays in its own workspace.
  await c.getByTestId("trust-decline").click();
  await expect(c.getByTestId("empty")).toBeVisible();
  await expect(c.getByTestId("context-folder")).toHaveCount(0);
  await say(c, "Where are you working right now?");
  const ownWorkspace = join(dataDir, "contexts", "scratch", "agent-workspace");
  await expect(c.getByTestId("message-agent")).toContainText(`I am working in ${ownWorkspace}`, {
    timeout: 30_000,
  });

  // 8. The recent list, from inside the conversation.
  await a.getByTestId("contexts-button").click();
  const recent = a.getByTestId("context-recent");
  await expect(recent).toHaveCount(4);
  await expect(recent.filter({ hasText: "longplay" })).toHaveAttribute("data-current", "true");
  await shot(a, "c06-recent-list");
  await a.keyboard.press("Escape");
  await a.getByTestId("contexts-button").click();

  // 9. The trust event is in longplay's log, as the person, without the path.
  const logPath = join(dataDir, "contexts", "longplay", "log.jsonl");
  const trustLine = readFileSync(logPath, "utf8")
    .split("\n")
    .find((l) => l.includes('"context.folder_decided"')) as string;
  const trust = JSON.parse(trustLine);
  expect(trust).toMatchObject({
    type: "context.folder_decided",
    actor: { kind: "user" },
    data: {
      decision: "trusted",
      remote: "https://github.com/niko/longplay.git",
      pathHash: createHash("sha256").update(longplay).digest("hex"),
    },
  });
  expect(trustLine).not.toContain(longplay);
  expect(trustLine).not.toContain("ghp_secret");
  writeFileSync(join(artifacts, "trust-event.json"), `${JSON.stringify(trust, null, 2)}\n`);
  const crossings = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.includes('"context.crossed"'))
    .map((l) => JSON.parse(l).data.purpose);
  expect(crossings).toEqual(["opened", "referenced", "pulled", "followed"]);
  const scratchDecision = readFileSync(join(dataDir, "contexts", "scratch", "log.jsonl"), "utf8")
    .split("\n")
    .find((l) => l.includes('"context.folder_decided"')) as string;
  expect(JSON.parse(scratchDecision).data.decision).toBe("declined");

  // 10. Restart without a folder: every context that was open comes back, as it was.
  await electronApp.close();
  electronApp = await launch();
  a = await windowOf(electronApp, "longplay");
  b = await windowOf(electronApp, "harbour");
  const c2 = await windowOf(electronApp, "scratch");
  expect(electronApp.windows()).toHaveLength(3);
  await expect(a.getByTestId("trust-step")).toHaveCount(0);
  await expect(a.getByTestId("message-user")).toHaveCount(4);
  await expect(a.getByTestId("context-item")).toHaveCount(1);
  await expect(a.getByTestId("context-item-pulled")).toBeVisible();
  await expect(a.getByTestId("context-folder")).toHaveText("longplay");
  await expect(b.getByTestId("message-user").filter({ hasText: MARKER })).toHaveCount(1);
  await expect(c2.getByTestId("context-folder")).toHaveCount(0);
  await shot(a, "c07-restarted-longplay");
  await shot(b, "c08-restarted-harbour");
  // Each one's agent still starts where it did, without asking again.
  await say(a, "Where are you working right now?");
  await expect(a.getByTestId("message-agent").last()).toContainText(longplay, { timeout: 30_000 });
  await say(b, "Where are you working right now?");
  await expect(b.getByTestId("message-agent").last()).toContainText(harbour, { timeout: 30_000 });

  // 11. The log that was there before contexts opens as the context "local", unchanged.
  await a.getByTestId("contexts-button").click();
  await a.getByTestId("context-recent").filter({ hasText: "local" }).click();
  const local = await windowOf(electronApp, "local");
  await expect(local.getByTestId("trust-step")).toHaveCount(0);
  await expect(local.getByTestId("message-user")).toContainText("Remember the old log.");
  await expect(local.getByTestId("message-agent")).toContainText("Written before contexts.");
  await expect(local.getByTestId("context-folder")).toHaveCount(0);
  await shot(local, "c09-local-context");
  await electronApp.close();
  const after = readFileSync(legacyLog);
  expect(after.equals(legacyBytes)).toBe(true);
  expect(sha(legacyLog)).toBe(legacyHash);
  writeFileSync(
    join(artifacts, "local-log-hash.txt"),
    `before: ${legacyHash}\nafter:  ${sha(legacyLog)}\n`,
  );
});
