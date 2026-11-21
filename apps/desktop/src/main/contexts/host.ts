import { statSync } from "node:fs";
import { homedir } from "node:os";
import {
  type ContextIntent,
  type ContextLauncher,
  type CrossContext,
  findContextAddresses,
  formatAddress,
  LogRefusedError,
  readLogRecords,
  snapshotFromRecords,
} from "@nikovirtala/draft-core";
import { type BrowserWindow, dialog } from "electron";
import type { Boot, Change, ContextListItem, TrustQuestion } from "../../shared/ipc.ts";
import { windowTitle } from "../../shared/placement.ts";
import { WindowManager } from "../windows.ts";
import { describeFolder, type FolderInfo } from "./folder.ts";
import { importDataDir } from "./import.ts";
import { type LaunchRequest, recogniseSentence } from "./launch.ts";
import { type ContextRegistry, LOCAL_CONTEXT, pathsOf } from "./registry.ts";
import { ContextRuntime, type RuntimeDeps } from "./runtime.ts";

type Started = { kind: "ready"; runtime: ContextRuntime } | Extract<Boot, { kind: "refused" }>;

interface Pending {
  question: TrustQuestion;
  info: FolderInfo;
}

export interface HostOptions {
  dataDir: string;
  registry: ContextRegistry;
  preload: string;
  /** What a context needs that the device shares; the host fills in the launcher and cross-context reader. */
  deps: Omit<RuntimeDeps, "launcher" | "crossContext" | "registry" | "dataDir">;
  /** Ends the app: the last window closed. */
  quit: () => void;
  platform?: NodeJS.Platform;
}

/**
 * Every open context of this device: one runtime and one set of windows each (ADR 4e115peq). It
 * opens a context for a name, a folder or an imported data directory, asks before a folder
 * becomes where an agent works, and answers each window's calls with the context it belongs to.
 */
export class ContextHost {
  private readonly windows = new Map<string, WindowManager>();
  private readonly started = new Map<string, Promise<Started>>();
  private readonly runtimes = new Map<string, ContextRuntime>();
  private readonly pending = new Map<string, Pending>();
  private quitting = false;
  private readonly registry: ContextRegistry;
  private readonly deps: RuntimeDeps;

  constructor(private readonly o: HostOptions) {
    this.registry = o.registry;
    this.deps = {
      ...o.deps,
      dataDir: o.dataDir,
      registry: o.registry,
      launcher: (context) => this.launcher(context),
      crossContext: (context) => this.crossContext(context),
    };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Opening                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  /** Opens a context in a window of its own, or brings its window forward. */
  openContext(name: string): void {
    if (this.registry.get(name) === null) throw new Error(`there is no context named ${name}`);
    const existing = this.windows.get(name);
    if (existing !== undefined) {
      existing.focus();
      return;
    }
    const wm = new WindowManager({
      preload: this.o.preload,
      store: () => this.runtimes.get(name)?.store ?? null,
      titleOf: (block) => this.titleOf(name, block),
      mainTitle: `draft · ${name}`,
      cascade: this.windows.size * 28,
      onClosedByPerson: (block) => this.runtimes.get(name)?.layout.move({ type: "close", block }),
      onMainClosed: () => void this.mainClosed(name),
    });
    this.windows.set(name, wm);
    this.saveOpen();
    wm.openMain();
  }

  /**
   * Opens a folder as a context. A folder that is trusted for a context opens that context. A
   * new folder, or one that was declined before, makes the window ask first: the context's
   * agent doesn't work there until a person says so.
   */
  openFolder(input: string, base?: string): string {
    const info = describeFolder(input, {
      ...(base === undefined ? {} : { base }),
      home: homedir(),
    });
    let entry = this.registry.byFolder(info.path);
    if (entry === null) {
      entry = this.registry.create({
        name: this.registry.uniqueName(info.name),
        candidate: info.path,
      });
    }
    if (entry.folder !== info.path) this.ask(entry.name, info, false);
    this.openContext(entry.name);
    return entry.name;
  }

  /**
   * Imports a `DRAFT_DATA_DIR` setup as a context and opens it. If the old setup's
   * `agent-workspace` was a link to a folder, that folder is offered through the same trust step.
   */
  openImport(dir: string): string {
    const result = importDataDir(this.registry, this.o.dataDir, dir);
    if (result.folder !== null && result.entry.folder !== result.folder) {
      this.ask(result.entry.name, describeFolder(result.folder), true);
    }
    this.openContext(result.entry.name);
    return result.entry.name;
  }

  /** What a launch asked for: folders and data directories to open. Failures are shown, not thrown. */
  handleLaunch(request: LaunchRequest): void {
    const failures: string[] = [];
    for (const dir of request.imports) {
      try {
        this.openImport(dir);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    for (const folder of request.folders) {
      try {
        this.openFolder(folder);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) dialog.showErrorBox("draft couldn't open that", failures.join("\n"));
  }

  /** The contexts that were open when draft last ended, or the local one on a first start. */
  restore(): void {
    const names = this.registry.openAtLastExit();
    for (const name of names.length > 0 ? names : [LOCAL_CONTEXT]) this.openContext(name);
  }

  private ask(name: string, info: FolderInfo, imported: boolean): void {
    this.registry.setFolder(name, { candidate: info.path });
    this.pending.set(name, {
      info,
      question: {
        context: name,
        folder: { path: info.path, name: info.name, remote: info.remote },
        imported,
      },
    });
  }

  /* ------------------------------------------------------------------------------------------ */
  /* What a window calls                                                                          */
  /* ------------------------------------------------------------------------------------------ */

  /** The name of the context a window belongs to. */
  contextOf(webContentsId: number): string | null {
    for (const [name, wm] of this.windows) if (wm.owns(webContentsId)) return name;
    return null;
  }

  /** The started runtime of a window's context; null before it started or while it asks. */
  runtimeOf(webContentsId: number): ContextRuntime | null {
    const name = this.contextOf(webContentsId);
    return name === null ? null : (this.runtimes.get(name) ?? null);
  }

  async boot(webContentsId: number): Promise<Boot> {
    const name = this.contextOf(webContentsId);
    if (name === null) throw new Error("this window belongs to no context");
    const asking = this.pending.get(name);
    if (asking !== undefined) return { kind: "trust", question: asking.question };
    const started = await this.start(name);
    if (started.kind === "refused") return started;
    const r = started.runtime;
    return {
      kind: "ready",
      context: r.view(),
      main: r.workspace.mainConversation,
      states: r.workspace.states(),
      threads: r.workspace.threads(),
      attention: r.workspace.attention(),
      view: r.layout.view(),
      agents: r.agents.list(),
      defaultAgent: r.agents.defaultId,
      block: this.windows.get(name)?.blockFor(webContentsId) ?? null,
    };
  }

  /** A person's answer to the trust step of the window's context. */
  async answerTrust(webContentsId: number, answer: "trusted" | "declined"): Promise<void> {
    const name = this.contextOf(webContentsId);
    const asking = name === null ? undefined : this.pending.get(name);
    if (name === null || asking === undefined) return;
    this.pending.delete(name);
    try {
      const started = await this.start(name);
      if (started.kind === "ready") await started.runtime.decideFolder(answer, asking.info);
      else this.registry.setFolder(name, { candidate: asking.info.path });
    } catch (err) {
      this.pending.set(name, asking);
      throw err;
    }
  }

  async answerProposal(webContentsId: number, conversation: string, id: string, accept: boolean) {
    await this.runtimeOf(webContentsId)
      ?.workspace.conversation(conversation)
      .answerProposal(id, accept);
  }

  /** Follows a reference: records the crossing, then opens the context it points into. */
  async follow(webContentsId: number, conversation: string, address: string): Promise<void> {
    const runtime = this.runtimeOf(webContentsId);
    if (runtime === null) return;
    const { context } = await runtime.workspace
      .conversation(conversation)
      .cross("followed", address);
    if (this.registry.has(context)) this.openContext(context);
  }

  async pull(webContentsId: number, conversation: string, address: string): Promise<void> {
    await this.runtimeOf(webContentsId)
      ?.workspace.conversation(conversation)
      .cross("pulled", address);
  }

  list(current: string | null): ContextListItem[] {
    return this.registry.recent().map((e) => ({
      name: e.name,
      title: e.title,
      folder: e.folder,
      lastActivity: e.lastActivity,
      open: this.windows.has(e.name),
      current: e.name === current,
    }));
  }

  /** The system's folder chooser, over the window that asked. */
  async choose(webContentsId: number, what: "folder" | "import"): Promise<string | null> {
    const win = this.windowOf(webContentsId);
    const options: Electron.OpenDialogOptions = {
      title: what === "folder" ? "Open a folder as a context" : "Import a draft data directory",
      properties: ["openDirectory"],
    };
    const result =
      win === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  private windowOf(webContentsId: number): BrowserWindow | null {
    const name = this.contextOf(webContentsId);
    return name === null
      ? null
      : (this.windows
          .get(name)
          ?.all()
          .find((w) => w.webContents.id === webContentsId) ?? null);
  }

  forgetWindow(webContentsId: number): void {
    for (const r of this.runtimes.values()) r.forgetWindow(webContentsId);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Starting and closing                                                                         */
  /* ------------------------------------------------------------------------------------------ */

  private start(name: string): Promise<Started> {
    let p = this.started.get(name);
    if (p === undefined) {
      p = this.startNow(name);
      this.started.set(name, p);
    }
    return p;
  }

  private async startNow(name: string): Promise<Started> {
    try {
      const runtime = await ContextRuntime.start(name, this.deps);
      this.runtimes.set(name, runtime);
      const wm = this.windows.get(name);
      runtime.workspace.onChange((c) => wm?.send(c as Change));
      runtime.layout.onChange((view) => {
        wm?.sync(view.layout);
        wm?.send({ type: "view", view });
      });
      // Windows that were open when this context last ended open again, where they were.
      wm?.sync(runtime.layout.view().layout);
      return { kind: "ready", runtime };
    } catch (err) {
      this.started.delete(name);
      if (err instanceof LogRefusedError)
        return {
          kind: "refused",
          path: pathsOf(this.o.dataDir, this.registry.get(name) ?? { dir: "." }).log,
          reason: err.message,
        };
      throw err;
    }
  }

  private titleOf(name: string, block: string): string {
    const r = this.runtimes.get(name);
    const entry = r?.layout.view().layout.blocks[block];
    if (r === undefined || entry === undefined) return "draft";
    const origin =
      r.workspace.threads().find((t) => t.conversation === entry.info.home)?.title ?? null;
    return windowTitle(entry.info, origin);
  }

  private saveOpen(): void {
    if (!this.quitting) this.registry.setOpen([...this.windows.keys()]);
  }

  /** A person closed a context's main window: the context ends, and so does draft with the last one. */
  private async mainClosed(name: string): Promise<void> {
    if (this.quitting) return;
    const last = this.windows.size === 1 && (this.o.platform ?? process.platform) !== "darwin";
    // The last window closing is the app ending: what was open stays open for the next start.
    if (!last) {
      this.windows.delete(name);
      this.saveOpen();
    }
    this.pending.delete(name);
    const runtime = this.runtimes.get(name);
    this.runtimes.delete(name);
    this.started.delete(name);
    await runtime?.close();
    if (last) this.o.quit();
  }

  /** draft is ending: what is open now opens again next time; every context closes. */
  async closeAll(): Promise<void> {
    if (!this.quitting) this.registry.setOpen([...this.windows.keys()]);
    this.quitting = true;
    for (const wm of this.windows.values()) wm.beginQuit();
    await Promise.all([...this.runtimes.values()].map((r) => r.close().catch(() => {})));
    this.runtimes.clear();
    this.registry.flush();
  }

  hasWindows(): boolean {
    return [...this.windows.values()].some((w) => w.hasMain());
  }

  /* ------------------------------------------------------------------------------------------ */
  /* What the conversations ask of the host                                                       */
  /* ------------------------------------------------------------------------------------------ */

  private launcher(_self: string): ContextLauncher {
    return {
      recognise: (text) => recogniseSentence(text, this.registry.names()),
      open: async (intent: ContextIntent) => {
        if (intent.kind === "open") {
          this.openContext(intent.name);
          return { context: intent.name };
        }
        return { context: this.openFolder(intent.folder) };
      },
    };
  }

  /**
   * Reads another context's log for a reference, and nothing else: draft does it, with no model,
   * to take a snapshot. The log is verified as it is read and never written (ADR gw4vxvw4).
   */
  private crossContext(self: string): CrossContext {
    return {
      detect: (text) =>
        findContextAddresses(text)
          .filter((a) => a.context !== self && this.registry.has(a.context))
          .map((a) => formatAddress(a)),
      snapshot: async (address) => {
        const a = findContextAddresses(address)[0];
        const entry = a === undefined ? null : this.registry.get(a.context);
        if (a === undefined || entry === null) return null;
        const path = pathsOf(this.o.dataDir, entry).log;
        try {
          statSync(path);
        } catch {
          return null;
        }
        const read = readLogRecords(path);
        if (!read.ok) return null;
        return snapshotFromRecords(read.events, a, {
          name: entry.name,
          logContext: entry.logContext,
        });
      },
    };
  }
}
