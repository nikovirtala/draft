import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRuntime,
  ConversationService,
  FakeAgentRuntime,
  FakeScriptSchema,
  FileLogStore,
  KiroOAuth,
  type KiroRemoteTools,
  KiroSessionResolver,
  kiroMcpUrl,
  LogRefusedError,
  McpKiroRemoteTools,
  Projection,
  type Resolver,
} from "@nikovirtala/draft-core";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { type Boot, CHANNELS, type Change, type Placement } from "../shared/ipc.ts";
import { ClaudeAgentRuntime, packagedClaudeExecutable } from "./agent-sdk.ts";
import { loadConfig } from "./config.ts";
import { ensureIdentity, userActor } from "./identity.ts";
import { SafeStorageSecretStore } from "./secrets.ts";
import { JsonFileSpanExporter, startTelemetry } from "./telemetry.ts";
import { ViewStateStore } from "./view-state.ts";

// A data directory from the environment keeps Chromium's own state there too (tests, profiles).
if (process.env.DRAFT_DATA_DIR !== undefined) app.setPath("userData", process.env.DRAFT_DATA_DIR);

// Two instances writing one log would fork its chain.
if (!app.requestSingleInstanceLock()) app.quit();

const telemetry = startTelemetry({
  spanExporters:
    process.env.DRAFT_SPAN_FILE === undefined
      ? []
      : [new JsonFileSpanExporter(process.env.DRAFT_SPAN_FILE)],
});

let boot: Boot | null = null;
let service: ConversationService | null = null;
let viewState: ViewStateStore | null = null;
let closeAll: (() => Promise<void>) | null = null;
let window: BrowserWindow | null = null;

function openBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url))
    return Promise.reject(new Error("refusing to open a non-http URL"));
  return shell.openExternal(url);
}

/** Opens the log, verifies it, and builds everything the conversation needs. */
async function start(): Promise<Boot> {
  const config = loadConfig(app.getPath("userData"));
  const identity = ensureIdentity(config.dataDir);
  const logPath = join(config.dataDir, "log.jsonl");
  let log: FileLogStore;
  try {
    log = FileLogStore.open(logPath);
  } catch (err) {
    if (err instanceof LogRefusedError)
      return { kind: "refused", path: logPath, reason: err.message };
    throw err;
  }
  const projection = Projection.open(join(config.dataDir, "views.db"));
  viewState = new ViewStateStore(join(config.dataDir, "device.db"));

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
  const noTools: KiroRemoteTools = {
    call: async () => ({ isError: true, structured: null, text: "Kiro Remote is not configured" }),
  };

  let agent: AgentRuntime;
  if (config.agent === "fake") {
    const script = FakeScriptSchema.parse(
      config.fakeScript === null
        ? { turns: [] }
        : JSON.parse(readFileSync(config.fakeScript, "utf8")),
    );
    agent = new FakeAgentRuntime(script, tools ?? noTools, { model: config.model });
  } else {
    agent = new ClaudeAgentRuntime({
      model: config.model,
      apiKey: process.env.ANTHROPIC_API_KEY,
      kiro:
        mcpUrl === null
          ? null
          : { url: mcpUrl, token: async () => (oauth === null ? null : oauth.accessToken()) },
      executable: packagedClaudeExecutable(app.isPackaged),
    });
  }

  const resolvers: Resolver[] = tools === null ? [] : [new KiroSessionResolver(tools)];
  service = await ConversationService.open({
    log,
    projection,
    agent,
    resolvers,
    user: userActor(identity),
    poller: { baseMs: config.pollBaseMs, maxMs: config.pollMaxMs },
  });
  service.onChange((c: Change) => window?.webContents.send(CHANNELS.change, c));
  const timer = setInterval(
    () => void service?.tick(),
    Math.max(100, Math.min(500, config.pollBaseMs)),
  );
  closeAll = async () => {
    clearInterval(timer);
    await service?.close();
    await agent.close();
    await tools?.close?.();
    log.close();
    projection.close();
    viewState?.close();
  };
  return { kind: "ready", state: service.state() };
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.boot, async () => {
    boot ??= await start();
    return boot;
  });
  ipcMain.handle(CHANNELS.submit, async (_e, text: unknown) => {
    if (typeof text !== "string" || service === null) return;
    await service.submit(text.slice(0, 20_000));
  });
  ipcMain.handle(CHANNELS.answerPrompt, (_e, id: unknown, allow: unknown) => {
    if (typeof id === "string" && typeof allow === "boolean") service?.answerPrompt(id, allow);
  });
  ipcMain.on(CHANNELS.setVisible, (_e, targets: unknown) => {
    if (!Array.isArray(targets)) return;
    service?.setVisible(
      targets
        .filter(
          (t): t is { type: string; id: string } =>
            typeof t?.type === "string" && typeof t?.id === "string",
        )
        .slice(0, 200),
    );
  });
  ipcMain.on(CHANNELS.invalidView, (_e, reason: unknown) => {
    if (reason === "not-json" || reason === "schema") service?.reportInvalidView(reason);
  });
  ipcMain.handle(CHANNELS.placements, () => viewState?.all() ?? {});
  ipcMain.handle(CHANNELS.setPlacement, (_e, key: unknown, placement: unknown) => {
    if (typeof key === "string" && (placement === "inline" || placement === "minimized")) {
      viewState?.set(key, placement as Placement);
    }
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 560,
    minHeight: 480,
    title: "draft",
    backgroundColor: "#f9f1e1",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window?.show());
  // Links never navigate the window: http(s) links open in the system browser for now.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  window.on("closed", () => {
    window = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void (async () => {
    await closeAll?.().catch(() => {});
    await telemetry.shutdown();
    app.exit(0);
  })();
});
