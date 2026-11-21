import { join } from "node:path";
import {
  FileLogStore,
  KiroOAuth,
  type KiroRemoteTools,
  KiroSessionResolver,
  kiroMcpUrl,
  LogRefusedError,
  McpKiroRemoteTools,
  Projection,
  type Resolver,
  Workspace,
} from "@nikovirtala/draft-core";
import { app, ipcMain, shell } from "electron";
import { z } from "zod";
import { type Boot, CHANNELS, type Change } from "../shared/ipc.ts";
import { BlockInfoSchema, MOVE_TYPES, windowTitle } from "../shared/placement.ts";
import { AgentRegistry } from "./acp/registry.ts";
import { AcpRuntime } from "./acp/runtime.ts";
import { loadConfig } from "./config.ts";
import { ensureIdentity, userActor } from "./identity.ts";
import { LayoutService } from "./layout.ts";
import { provenance } from "./provenance.ts";
import { SafeStorageSecretStore } from "./secrets.ts";
import { handleFontScheme, registerFontScheme } from "./system-fonts.ts";
import { JsonFileSpanExporter, startTelemetry } from "./telemetry.ts";
import { ViewStateStore } from "./view-state.ts";
import { WindowManager } from "./windows.ts";

// A data directory from the environment keeps Chromium's own state there too (tests, profiles).
if (process.env.DRAFT_DATA_DIR !== undefined) app.setPath("userData", process.env.DRAFT_DATA_DIR);

// Two instances writing one log would fork its chain.
if (!app.requestSingleInstanceLock()) app.quit();
registerFontScheme();

const telemetry = startTelemetry({
  provenance: provenance(process.env, app.isPackaged),
  spanExporters:
    process.env.DRAFT_SPAN_FILE === undefined
      ? []
      : [new JsonFileSpanExporter(process.env.DRAFT_SPAN_FILE)],
});

/** What `start` built: everything a window needs to show the workspace. */
interface Running {
  workspace: Workspace;
  layout: LayoutService;
  agents: { id: string; label: string }[];
  defaultAgent: string;
  user: ReturnType<typeof userActor>;
}

type Started = { kind: "ready"; running: Running } | Extract<Boot, { kind: "refused" }>;

let starting: Promise<Started> | null = null;
let running: Running | null = null;
let viewState: ViewStateStore | null = null;
let closeAll: (() => Promise<void>) | null = null;
let windows: WindowManager | null = null;
/** The stubs each window has on screen; the union of them is what gets polled. */
const visible = new Map<number, { type: string; id: string }[]>();

function openBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url))
    return Promise.reject(new Error("refusing to open a non-http URL"));
  return shell.openExternal(url);
}

/** Opens the log, verifies it, and builds everything the conversation needs. */
async function start(): Promise<Started> {
  const config = loadConfig(app.getPath("userData"));
  const identity = ensureIdentity(config.dataDir);
  const logPath = join(config.dataDir, "log.jsonl");
  let log: FileLogStore;
  try {
    log = FileLogStore.open(logPath, { context: "local" });
  } catch (err) {
    if (err instanceof LogRefusedError)
      return { kind: "refused", path: logPath, reason: err.message };
    throw err;
  }
  const projection = Projection.open(join(config.dataDir, "views.db"));
  const store = new ViewStateStore(join(config.dataDir, "device.db"));
  viewState = store;
  const layout = new LayoutService(store);

  let tools: (KiroRemoteTools & { close?(): Promise<void> }) | null = null;
  let oauth: KiroOAuth | null = null;
  const mcpUrl = config.kiroRemoteUrl === null ? null : kiroMcpUrl(config.kiroRemoteUrl);
  if (mcpUrl !== null) {
    if (config.kiroAuth === "oauth") {
      oauth = new KiroOAuth({
        serverUrl: mcpUrl,
        store: new SafeStorageSecretStore(join(config.dataDir, "secrets.bin")),
        openBrowser,
      });
    }
    const mcp = new McpKiroRemoteTools({
      url: mcpUrl,
      ...(oauth === null ? {} : { authProvider: oauth }),
    });
    const signIn = oauth;
    tools = {
      async call(tool, args) {
        // The first call signs in through the browser; later calls use or refresh the token.
        if (signIn !== null) await signIn.accessToken();
        return mcp.call(tool, args);
      },
      close: () => mcp.close(),
    };
  }
  // One ACP agent process per agent that a conversation chose, each with one session per
  // conversation. The default is the one in config; a thread can start on another.
  const registry = new AgentRegistry(
    config.agentConfig,
    (spec) =>
      new AcpRuntime({
        spec,
        cwd: config.agentCwd,
        env: process.env,
        clientInfo: { name: "draft", version: app.getVersion() },
        ...(process.env.DRAFT_ACP_TRANSCRIPT === undefined
          ? {}
          : { transcript: process.env.DRAFT_ACP_TRANSCRIPT }),
        kiro:
          mcpUrl === null || config.kiroRemoteUrl === null
            ? null
            : {
                url: mcpUrl,
                baseUrl: config.kiroRemoteUrl,
                token: async () => (oauth === null ? null : oauth.accessToken()),
              },
      }),
  );

  const resolvers: Resolver[] = tools === null ? [] : [new KiroSessionResolver(tools)];
  const user = userActor(identity);
  const workspace = await Workspace.open({
    log,
    projection,
    agent: registry.get(registry.defaultId),
    agents: registry,
    resolvers,
    user,
    poller: { baseMs: config.pollBaseMs, maxMs: config.pollMaxMs },
  });
  workspace.onChange((c) => {
    windows?.send(c as Change);
    if (c.type === "threads") layout.markShown(c.threads);
  });
  layout.onChange((view) => {
    windows?.sync(view.layout);
    windows?.send({ type: "view", view });
  });
  const timer = setInterval(
    () => void workspace.tick(),
    Math.max(100, Math.min(500, config.pollBaseMs)),
  );
  closeAll = async () => {
    clearInterval(timer);
    await workspace.close();
    await registry.close();
    await tools?.close?.();
    log.close();
    projection.close();
    store.close();
  };
  running = {
    workspace,
    layout,
    agents: registry.list(),
    defaultAgent: registry.defaultId,
    user,
  };
  // Windows that were open when draft last ended open again, where they were.
  windows?.sync(layout.view().layout);
  return { kind: "ready", running };
}

function bootFor(started: Started, webContentsId: number): Boot {
  if (started.kind === "refused") return started;
  const r = started.running;
  return {
    kind: "ready",
    main: r.workspace.mainConversation,
    states: r.workspace.states(),
    threads: r.workspace.threads(),
    attention: r.workspace.attention(),
    view: r.layout.view(),
    agents: r.agents,
    defaultAgent: r.defaultAgent,
    block: windows?.blockFor(webContentsId) ?? null,
  };
}

const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const RegistrationsSchema = z
  .array(z.object({ info: BlockInfoSchema, initial: z.enum(["inline", "minimized"]) }))
  .max(200);
const MoveSchema = z.object({ type: z.enum(MOVE_TYPES), block: z.string().min(1).max(500) });
const FocusSchema = z
  .union([
    z.object({ block: z.string().min(1).max(500) }).strict(),
    z.object({ conversation: z.string().min(1).max(500) }).strict(),
  ])
  .nullable();

function requireRunning(): Running {
  if (running === null) throw new Error("draft hasn't started yet");
  return running;
}

/** The thread's name for a block made in `conversation`, or null for the main conversation. */
function originOf(r: Running, conversation: string): string | null {
  return r.workspace.threads().find((t) => t.conversation === conversation)?.title ?? null;
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.boot, async (e) => {
    starting ??= start();
    return bootFor(await starting, e.sender.id);
  });
  ipcMain.handle(
    CHANNELS.submit,
    async (_e, conversation: unknown, text: unknown, aside: unknown) => {
      if (!str(conversation) || typeof text !== "string" || running === null) return;
      await running.workspace
        .conversation(conversation)
        .submit(text.slice(0, 20_000), { aside: aside === true });
    },
  );
  ipcMain.handle(CHANNELS.setAgentState, async (_e, conversation: unknown, state: unknown) => {
    if (str(conversation) && (state === "active" || state === "paused") && running !== null)
      await running.workspace.conversation(conversation).setAgentState(state);
  });
  ipcMain.handle(
    CHANNELS.answerPrompt,
    (_e, conversation: unknown, id: unknown, allow: unknown) => {
      if (str(conversation) && str(id) && typeof allow === "boolean")
        running?.workspace.conversation(conversation).answerPrompt(id, allow);
    },
  );
  ipcMain.on(CHANNELS.setVisible, (e, targets: unknown) => {
    if (!Array.isArray(targets)) return;
    visible.set(
      e.sender.id,
      targets
        .filter(
          (t): t is { type: string; id: string } =>
            typeof t?.type === "string" && typeof t?.id === "string",
        )
        .slice(0, 200),
    );
    running?.workspace.setVisible([...visible.values()].flat());
  });
  ipcMain.on(CHANNELS.invalidView, (_e, reason: unknown) => {
    if (reason === "not-json" || reason === "schema")
      running?.workspace.main.reportInvalidView(reason);
  });
  ipcMain.handle(CHANNELS.ensureBlocks, (_e, blocks: unknown) => {
    const parsed = RegistrationsSchema.safeParse(blocks);
    if (parsed.success) running?.layout.ensure(parsed.data);
  });
  ipcMain.handle(CHANNELS.move, (_e, m: unknown) => {
    const parsed = MoveSchema.safeParse(m);
    if (!parsed.success || running === null) return { ok: false, reason: "not-available" };
    return running.layout.move(parsed.data);
  });
  ipcMain.handle(CHANNELS.focus, (_e, target: unknown) => {
    const parsed = FocusSchema.safeParse(target);
    if (parsed.success) running?.layout.focus(parsed.data);
  });
  ipcMain.handle(CHANNELS.branch, async (_e, parentMessage: unknown, agent: unknown) => {
    if (!str(parentMessage) || running === null) return;
    const r = running;
    const conversation = await r.workspace.branch(parentMessage, r.user, {
      ...(str(agent) ? { agent } : {}),
    });
    const t = r.workspace.threads().find((x) => x.conversation === conversation);
    if (t === undefined) return;
    // The thread opens in the panel, and the main conversation keeps its stub at the branch.
    r.layout.openThread({
      address: conversation,
      kind: "thread",
      home: t.parentConversation,
      depth: t.depth - 1,
      opens: conversation,
      title: t.title,
    });
  });
  ipcMain.handle(CHANNELS.previewSwitch, (_e, conversation: unknown, agent: unknown) => {
    if (!str(conversation) || !str(agent)) throw new Error("bad request");
    return requireRunning().workspace.previewSwitch(conversation, agent);
  });
  ipcMain.handle(CHANNELS.switchAgent, async (_e, conversation: unknown, agent: unknown) => {
    if (!str(conversation) || !str(agent)) throw new Error("bad request");
    const r = requireRunning();
    await r.workspace.switchAgent(conversation, agent, r.user);
  });
}

/** What a block's window is titled: what it is, and where it came from. */
function titleOf(block: string): string {
  const r = running;
  const entry = r?.layout.view().layout.blocks[block];
  if (r === null || entry === undefined) return "draft";
  return windowTitle(entry.info, originOf(r, entry.info.home));
}

app.whenReady().then(() => {
  handleFontScheme();
  windows = new WindowManager({
    preload: join(import.meta.dirname, "../preload/index.cjs"),
    store: () => viewState,
    titleOf,
    // Closing a window returns its block to the place it came from.
    onClosedByPerson: (block) => running?.layout.move({ type: "close", block }),
  });
  registerIpc();
  windows.openMain();
  app.on("activate", () => {
    if (!windows?.hasMain()) windows?.openMain();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (e) => {
  windows?.beginQuit();
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void (async () => {
    await closeAll?.().catch(() => {});
    await telemetry.shutdown();
    app.exit(0);
  })();
});
