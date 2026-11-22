import {
  type AcceptanceActions,
  type ContextLauncher,
  type CrossContext,
  FileLogStore,
  type KiroRemoteTools,
  Projection,
  type Resolver,
  Workspace,
} from "@nikovirtala/draft-core";
import type { ContextView } from "../../shared/ipc.ts";
import type { AgentSpec } from "../acp/agents.ts";
import { AgentRegistry } from "../acp/registry.ts";
import type { AcpRuntime } from "../acp/runtime.ts";
import type { Config } from "../config.ts";
import type { userActor } from "../identity.ts";
import { LayoutService } from "../layout.ts";
import { ViewStateStore } from "../view-state.ts";
import { ActivityLog } from "./activity-log.ts";
import { type AgentPlace, agentPlace, placeBriefing } from "./agent-place.ts";
import type { FolderInfo } from "./folder.ts";
import { type ContextRegistry, pathsOf } from "./registry.ts";

/** What every context shares: the device's identity, its Kiro Remote connection and resolvers. */
export interface RuntimeDeps {
  dataDir: string;
  registry: ContextRegistry;
  config: Config;
  user: ReturnType<typeof userActor>;
  resolvers: readonly Resolver[];
  /** Kiro Remote as the person: what answering a permission request and retrying a step call. */
  actions: KiroRemoteTools | null;
  /** What answering an acceptance request runs, as the person. */
  acceptance: AcceptanceActions;
  /** Makes the ACP runtime of one agent, working where `place` says. */
  makeAgent(
    spec: AgentSpec,
    place: { cwd: () => string; note: () => string | null; folder: () => string | null },
  ): AcpRuntime;
  /** How draft reaches GitHub, for a note in the main conversation; null for nothing to say. */
  githubNote?: string | null;
  launcher(context: string): ContextLauncher;
  crossContext(context: string): CrossContext;
}

/**
 * One open context: its log, projection, view state, workspace and agent processes. Nothing here
 * is shared with another context but the device's identity, Kiro Remote and resolvers, so a
 * context's log, projections and view state stay its own (ADR 17gtag9n).
 */
export class ContextRuntime {
  /** The stubs each window has on screen; the union of them is what gets polled. */
  private readonly visible = new Map<number, { type: string; id: string }[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    readonly name: string,
    private readonly deps: RuntimeDeps,
    readonly workspace: Workspace,
    readonly layout: LayoutService,
    readonly store: ViewStateStore,
    readonly agents: AgentRegistry,
    private readonly closers: (() => void)[],
  ) {}

  /** Opens the context's log, verifying it (throws `LogRefusedError` if it doesn't verify). */
  static async start(name: string, deps: RuntimeDeps): Promise<ContextRuntime> {
    const entry = deps.registry.get(name);
    if (entry === null) throw new Error(`no context named ${name}`);
    const paths = pathsOf(deps.dataDir, entry);
    const file = FileLogStore.open(paths.log, { context: entry.logContext });
    const log = new ActivityLog(file, (at) => deps.registry.touch(name, at));
    const projection = Projection.open(paths.views);
    const store = new ViewStateStore(paths.device);
    const layout = new LayoutService(store);
    const place = {
      cwd: () => currentPlace(deps, name).cwd,
      note: () => placeBriefing(currentPlace(deps, name)),
      folder: () => currentPlace(deps, name).folder?.path ?? null,
    };
    const agents = new AgentRegistry(deps.config.agentConfig, (spec) =>
      deps.makeAgent(spec, place),
    );
    const workspace = await Workspace.open({
      log,
      projection,
      agent: agents.get(agents.defaultId),
      agents,
      resolvers: [...deps.resolvers],
      user: deps.user,
      context: entry.logContext,
      contextTitle: entry.title,
      launcher: deps.launcher(name),
      crossContext: deps.crossContext(name),
      ...(deps.actions === null ? {} : { actions: deps.actions }),
      acceptance: deps.acceptance,
      poller: { baseMs: deps.config.pollBaseMs, maxMs: deps.config.pollMaxMs },
    });
    const runtime = new ContextRuntime(name, deps, workspace, layout, store, agents, [
      () => log.close(),
      () => projection.close(),
      () => store.close(),
    ]);
    workspace.onChange((c) => {
      if (c.type === "threads") layout.markShown(c.threads);
    });
    if (deps.githubNote != null) await workspace.main.note("github-access", deps.githubNote);
    runtime.timer = setInterval(
      () => void workspace.tick(),
      Math.max(100, Math.min(500, deps.config.pollBaseMs)),
    );
    return runtime;
  }

  get user(): RuntimeDeps["user"] {
    return this.deps.user;
  }

  /** Where the agent works now, and whether the folder a person trusted is still there. */
  place(): AgentPlace {
    return currentPlace(this.deps, this.name);
  }

  /** What a window shows about the context it is in. */
  view(): ContextView {
    const entry = this.deps.registry.get(this.name);
    const place = this.place();
    return {
      name: this.name,
      title: entry?.title ?? this.name,
      folder: place.folder,
      folderMissing: place.missing,
    };
  }

  /**
   * Records a person's answer about a folder: in this context's log as the person, and in the
   * registry, which holds the path. A trusted folder is where new agent sessions start.
   */
  async decideFolder(decision: "trusted" | "declined", info: FolderInfo): Promise<void> {
    await this.workspace.decideFolder(
      decision,
      { remote: info.remote, pathHash: info.pathHash },
      this.deps.user,
    );
    this.deps.registry.setFolder(
      this.name,
      decision === "trusted" ? { folder: info.path } : { candidate: info.path },
    );
  }

  /** The stubs one window has on screen; the union over windows is what gets polled. */
  setVisible(windowId: number, targets: { type: string; id: string }[]): void {
    this.visible.set(windowId, targets);
    this.workspace.setVisible([...this.visible.values()].flat());
  }

  forgetWindow(windowId: number): void {
    if (this.visible.delete(windowId)) this.workspace.setVisible([...this.visible.values()].flat());
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.workspace.close();
    await this.agents.close();
    for (const c of this.closers) c();
  }
}

function currentPlace(deps: RuntimeDeps, name: string): AgentPlace {
  const entry = deps.registry.get(name);
  // For the local context this is `<dataDir>/agent-workspace`, where the agent always started.
  return agentPlace(entry ?? { folder: null }, pathsOf(deps.dataDir, entry ?? { dir: "." }));
}
