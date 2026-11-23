import { join } from "node:path";
import { BY_CLASS } from "@nikovirtala/draft-core";
import { app, clipboard, ipcMain, shell } from "electron";
import { z } from "zod";
import { CHANNELS } from "../shared/ipc.ts";
import { BlockInfoSchema, MOVE_TYPES } from "../shared/placement.ts";
import { loadConfig } from "./config.ts";
import { ContextHost } from "./contexts/host.ts";
import { isEmptyRequest, type LaunchRequest, parseLaunchArgs } from "./contexts/launch.ts";
import { ContextRegistry } from "./contexts/registry.ts";
import type { ContextRuntime } from "./contexts/runtime.ts";
import { provenance } from "./provenance.ts";
import { createServices, type Services } from "./services.ts";
import { handleFontScheme, registerFontScheme } from "./system-fonts.ts";
import { JsonFileSpanExporter, startTelemetry } from "./telemetry.ts";

// A data directory from the environment keeps Chromium's own state there too (tests, profiles).
if (process.env.DRAFT_DATA_DIR !== undefined) app.setPath("userData", process.env.DRAFT_DATA_DIR);

/** What this launch asked for: `draft <folder>` or `draft --import <data-dir>`. */
const launch: LaunchRequest = parseLaunchArgs(process.argv, process.cwd(), {
  defaultApp: process.defaultApp === true,
});

// Two instances writing one log would fork its chain. A second launch hands what it was asked to
// the running one and ends, so `draft <folder>` opens a window in the draft that is already open.
const first = app.requestSingleInstanceLock(launch);
if (!first) {
  app.quit();
} else {
  run();
}

function run(): void {
  registerFontScheme();

  const telemetry = startTelemetry({
    provenance: provenance(process.env, app.isPackaged),
    spanExporters:
      process.env.DRAFT_SPAN_FILE === undefined
        ? []
        : [new JsonFileSpanExporter(process.env.DRAFT_SPAN_FILE)],
  });

  let services: Services | null = null;
  let host: ContextHost | null = null;
  let hostReady: Promise<ContextHost> | null = null;

  function openBrowser(url: string): Promise<void> {
    if (!/^https?:\/\//.test(url))
      return Promise.reject(new Error("refusing to open a non-http URL"));
    return shell.openExternal(url);
  }

  /** Builds what the device shares, then the host that opens its contexts. */
  function startHost(): Promise<ContextHost> {
    hostReady ??= (async () => {
      const config = loadConfig(app.getPath("userData"));
      const s = await createServices({
        config,
        env: process.env,
        appVersion: app.getVersion(),
        openBrowser,
      });
      services = s;
      const h = new ContextHost({
        dataDir: config.dataDir,
        registry: ContextRegistry.load(config.dataDir),
        preload: join(import.meta.dirname, "../preload/index.cjs"),
        deps: {
          config,
          user: s.user,
          resolvers: s.resolvers,
          github: s.github,
          actions: s.actions,
          acceptance: s.acceptance,
          makeAgent: s.makeAgent,
          githubNote: s.githubNote,
        },
        quit: () => app.quit(),
      });
      host = h;
      return h;
    })();
    return hostReady;
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

  const MapRequestSchema = z
    .object({
      since: z.iso.datetime({ precision: 3 }).optional(),
      grouping: z.enum(["state", "class"]).optional(),
    })
    .strict();
  const MapCellSchema = z
    .object({ kind: z.string().min(1).max(200), column: z.string().min(1).max(200) })
    .strict()
    .nullable();

  /** The context of the window a call came from; every call is answered for that one only. */
  const runtimeOf = (
    e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  ): ContextRuntime | null => host?.runtimeOf(e.sender.id) ?? null;
  const requireRuntime = (e: Electron.IpcMainInvokeEvent): ContextRuntime => {
    const r = runtimeOf(e);
    if (r === null) throw new Error("draft hasn't started this context yet");
    return r;
  };

  function registerIpc(): void {
    ipcMain.handle(CHANNELS.boot, async (e) => (await startHost()).boot(e.sender.id));
    ipcMain.handle(CHANNELS.trust, async (e, answer: unknown) => {
      if (answer !== "trusted" && answer !== "declined") throw new Error("bad request");
      await host?.answerTrust(e.sender.id, answer);
    });
    ipcMain.handle(CHANNELS.contexts, (e) => host?.list(host.contextOf(e.sender.id) ?? null) ?? []);
    ipcMain.handle(CHANNELS.openContext, (_e, name: unknown) => {
      if (!str(name, 100)) throw new Error("bad request");
      host?.openContext(name);
    });
    ipcMain.handle(CHANNELS.chooseFolder, async (e) => {
      const path = await host?.choose(e.sender.id, "folder");
      if (path != null) host?.handleLaunch({ folders: [path], imports: [] });
    });
    ipcMain.handle(CHANNELS.chooseImport, async (e) => {
      const path = await host?.choose(e.sender.id, "import");
      if (path != null) host?.handleLaunch({ folders: [], imports: [path] });
    });
    ipcMain.handle(
      CHANNELS.answerProposal,
      async (e, conversation: unknown, id: unknown, accept: unknown) => {
        if (!str(conversation) || !str(id) || typeof accept !== "boolean")
          throw new Error("bad request");
        await host?.answerProposal(e.sender.id, conversation, id, accept);
      },
    );
    ipcMain.handle(CHANNELS.followReference, async (e, conversation: unknown, address: unknown) => {
      if (!str(conversation) || !str(address, 1000)) throw new Error("bad request");
      await host?.follow(e.sender.id, conversation, address);
    });
    ipcMain.handle(CHANNELS.pullReference, async (e, conversation: unknown, address: unknown) => {
      if (!str(conversation) || !str(address, 1000)) throw new Error("bad request");
      await host?.pull(e.sender.id, conversation, address);
    });
    ipcMain.handle(
      CHANNELS.submit,
      async (e, conversation: unknown, text: unknown, aside: unknown) => {
        const r = runtimeOf(e);
        if (!str(conversation) || typeof text !== "string" || r === null) return;
        await r.workspace
          .conversation(conversation)
          .submit(text.slice(0, 20_000), { aside: aside === true });
      },
    );
    ipcMain.handle(CHANNELS.setAgentState, async (e, conversation: unknown, state: unknown) => {
      const r = runtimeOf(e);
      if (str(conversation) && (state === "active" || state === "paused") && r !== null)
        await r.workspace.conversation(conversation).setAgentState(state);
    });
    ipcMain.handle(
      CHANNELS.answerPrompt,
      (e, conversation: unknown, id: unknown, allow: unknown) => {
        if (str(conversation) && str(id) && typeof allow === "boolean")
          runtimeOf(e)?.workspace.conversation(conversation).answerPrompt(id, allow);
      },
    );
    ipcMain.on(CHANNELS.setVisible, (e, targets: unknown) => {
      if (!Array.isArray(targets)) return;
      runtimeOf(e)?.setVisible(
        e.sender.id,
        targets
          .filter(
            (t): t is { type: string; id: string } =>
              typeof t?.type === "string" && typeof t?.id === "string",
          )
          .slice(0, 200),
      );
    });
    ipcMain.on(CHANNELS.invalidView, (e, reason: unknown) => {
      if (reason === "not-json" || reason === "schema")
        runtimeOf(e)?.workspace.main.reportInvalidView(reason);
    });
    ipcMain.handle(CHANNELS.ensureBlocks, (e, blocks: unknown) => {
      const parsed = RegistrationsSchema.safeParse(blocks);
      if (parsed.success) runtimeOf(e)?.layout.ensure(parsed.data);
    });
    ipcMain.handle(CHANNELS.move, (e, m: unknown) => {
      const parsed = MoveSchema.safeParse(m);
      const r = runtimeOf(e);
      if (!parsed.success || r === null) return { ok: false, reason: "not-available" };
      return r.layout.move(parsed.data);
    });
    ipcMain.handle(CHANNELS.map, (e, request: unknown) => {
      const parsed = MapRequestSchema.safeParse(request ?? {});
      if (!parsed.success) throw new Error("bad request");
      const { since, grouping } = parsed.data;
      return requireRuntime(e).workspace.map({
        ...(since === undefined ? {} : { window: { since } }),
        ...(grouping === "class" ? { grouping: BY_CLASS } : {}),
      });
    });
    ipcMain.on(CHANNELS.mapVisible, (e, on: unknown) => {
      if (typeof on === "boolean") runtimeOf(e)?.setMapVisible(e.sender.id, on);
    });
    ipcMain.handle(CHANNELS.selectMapCell, (e, block: unknown, cell: unknown) => {
      const parsed = MapCellSchema.safeParse(cell);
      if (!str(block, 500) || !parsed.success) throw new Error("bad request");
      runtimeOf(e)?.layout.selectCell(block, parsed.data);
    });
    ipcMain.handle(CHANNELS.setPanelWidth, (e, width: unknown) => {
      if (width !== null && (typeof width !== "number" || !Number.isFinite(width)))
        throw new Error("bad request");
      runtimeOf(e)?.layout.setPanelWidth(width);
    });
    ipcMain.handle(CHANNELS.reveal, (e, anchor: unknown) => {
      if (!str(anchor, 500)) throw new Error("bad request");
      host?.reveal(e.sender.id, anchor);
    });
    ipcMain.handle(CHANNELS.focus, (e, target: unknown) => {
      const parsed = FocusSchema.safeParse(target);
      if (parsed.success) runtimeOf(e)?.layout.focus(parsed.data);
    });
    ipcMain.handle(CHANNELS.branch, async (e, parentMessage: unknown, agent: unknown) => {
      const r = runtimeOf(e);
      if (!str(parentMessage) || r === null) return;
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
    ipcMain.handle(
      CHANNELS.settleInterrupt,
      async (e, conversation: unknown, key: unknown, outcome: unknown, input: unknown) => {
        if (!str(conversation) || !str(key, 2000) || !str(outcome, 100))
          throw new Error("bad request");
        // What a person says with an answer to an acceptance request: a note, or a reason.
        const words = z
          .object({
            note: z.string().max(5000).optional(),
            reason: z.string().max(5000).optional(),
          })
          .strict()
          .parse(input ?? {});
        await requireRuntime(e)
          .workspace.conversation(conversation)
          .settleInterrupt(key, outcome, words);
      },
    );
    ipcMain.handle(
      CHANNELS.answerCheck,
      async (e, conversation: unknown, key: unknown, outcome: unknown, note: unknown) => {
        if (
          !str(conversation) ||
          !str(key, 2000) ||
          (outcome !== "passed" && outcome !== "failed") ||
          !(note === null || str(note, 5000))
        )
          throw new Error("bad request");
        await requireRuntime(e)
          .workspace.conversation(conversation)
          .answerCheck(key, outcome, note);
      },
    );
    ipcMain.handle(CHANNELS.copyText, (e, text: unknown) => {
      if (!str(text, 100_000)) throw new Error("bad request");
      requireRuntime(e);
      clipboard.writeText(text);
    });
    ipcMain.handle(CHANNELS.wrapUp, async (e, conversation: unknown) => {
      if (!str(conversation)) throw new Error("bad request");
      await requireRuntime(e)
        .workspace.conversation(conversation)
        .submit("Wrap this up.", { wrapUp: true });
    });
    ipcMain.handle(CHANNELS.confirmConclusion, async (e, conversation: unknown) => {
      if (!str(conversation)) throw new Error("bad request");
      await requireRuntime(e).workspace.conversation(conversation).confirmConclusion();
    });
    ipcMain.handle(CHANNELS.declineConclusion, async (e, conversation: unknown) => {
      if (!str(conversation)) throw new Error("bad request");
      await requireRuntime(e).workspace.conversation(conversation).declineConclusion();
    });
    ipcMain.handle(
      CHANNELS.endThread,
      async (e, conversation: unknown, as: unknown, reason: unknown) => {
        if (!str(conversation) || (as !== "superseded" && as !== "withdrawn") || !str(reason, 1000))
          throw new Error("bad request");
        await requireRuntime(e).workspace.conversation(conversation).endThread(as, reason);
      },
    );
    ipcMain.handle(CHANNELS.previewSwitch, (e, conversation: unknown, agent: unknown) => {
      if (!str(conversation) || !str(agent)) throw new Error("bad request");
      return requireRuntime(e).workspace.previewSwitch(conversation, agent);
    });
    ipcMain.handle(CHANNELS.switchAgent, async (e, conversation: unknown, agent: unknown) => {
      if (!str(conversation) || !str(agent)) throw new Error("bad request");
      const r = requireRuntime(e);
      await r.workspace.switchAgent(conversation, agent, r.user);
    });
  }

  /** Opens what the launch asked for, or what was open when draft last ended. */
  function openStart(h: ContextHost, request: LaunchRequest): void {
    if (isEmptyRequest(request)) h.restore();
    else h.handleLaunch(request);
  }

  app.on("second-instance", (_e, _argv, _cwd, additional) => {
    const request = additional as LaunchRequest | undefined;
    void startHost().then((h) => {
      if (request !== undefined && !isEmptyRequest(request)) h.handleLaunch(request);
      else h.restore();
    });
  });

  app.whenReady().then(async () => {
    handleFontScheme();
    registerIpc();
    openStart(await startHost(), launch);
    app.on("activate", () => {
      if (host !== null && !host.hasWindows()) host.restore();
    });
  });

  app.on("web-contents-created", (_e, contents) => {
    const id = contents.id;
    contents.once("destroyed", () => host?.forgetWindow(id));
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
      await host?.closeAll().catch(() => {});
      await services?.close().catch(() => {});
      await telemetry.shutdown();
      app.exit(0);
    })();
  });
}
