import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_BRIEFING,
  type AgentEvent,
  type AgentRuntime,
  type AgentTurnHooks,
  type AgentTurnInput,
  KIRO_SERVER,
  renderAgentContext,
} from "@nikovirtala/draft-core";
import { type AgentSpec, agentEnvironment, missingRequirement } from "./agents.ts";
import { AsyncQueue } from "./queue.ts";
import { modelFromConfig, TurnMapper } from "./turn.ts";

/**
 * The agent behind a conversation, over ACP: draft is the client, a local agent process is the
 * server, and they speak JSON-RPC over the process's stdio.
 *
 * - One ACP session per conversation address. A session always starts from the projection of the
 *   log (`input.context`), never from the agent's own memory: a restart, a refreshed token or a
 *   crashed agent process all start the next turn the same way.
 * - Kiro Remote's MCP server reaches the agent in `session/new`: over HTTP with a bearer header
 *   when the agent advertises HTTP MCP, otherwise through the `kiro-remote` stdio client.
 * - The agent starts in a dedicated directory under draft's data, with no file system or
 *   terminal capability declared, so the only tools it is given are Kiro Remote's.
 * - Every permission request goes through draft's tool policy (see turn.ts).
 * - draft stores no credential. Kiro keeps its own sign-in, and Claude's adapter reads its API key
 *   from the environment draft passes through.
 */

export interface KiroMcp {
  /** The Kiro Remote MCP endpoint, `<base>/mcp`. */
  url: string;
  /** A current bearer token, or null when Kiro Remote runs without sign-in. */
  token(): Promise<string | null>;
  /** The Kiro Remote base URL, for the stdio fallback. */
  baseUrl: string;
}

export interface AcpRuntimeOptions {
  spec: AgentSpec;
  /** The agent's working directory: a dedicated one under draft's data, never a user repository. */
  cwd: string;
  /** draft's own environment, filtered before it reaches the agent. */
  env: NodeJS.ProcessEnv;
  kiro: KiroMcp | null;
  clientInfo: { name: string; version: string };
  /**
   * A JSON Lines file to record the ACP traffic in, both ways, with header and env values
   * redacted. For diagnosing an agent; off unless set.
   */
  transcript?: string;
}

interface Session {
  id: string;
  /** The bearer token its MCP headers carry; a different one means a new session. */
  token: string | null;
  primed: boolean;
  turn: TurnMapper | null;
}

interface Connection {
  child: ChildProcess;
  signal: AbortSignal;
  agent: acp.ClientContext;
  init: acp.InitializeResponse;
  stderr: string[];
  alive: boolean;
}

/** An error whose message is meant for the person using draft. */
class UserFacingError extends Error {}

export class AcpRuntime implements AgentRuntime {
  readonly id: string;
  model = "unreported";
  version: string;
  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  /** Sessions by conversation address. */
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  /** The session an ACP session id names; updates and requests are routed by it. */
  private bySessionId(sessionId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === sessionId) return s;
    return undefined;
  }

  constructor(private readonly o: AcpRuntimeOptions) {
    this.id = o.spec.id;
    this.version = `${o.spec.label} (not started)`;
  }

  async *runTurn(input: AgentTurnInput, hooks: AgentTurnHooks): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const run = this.drive(input, hooks, queue)
      .catch((err: unknown) => {
        queue.push({ type: "error", message: this.describe(err) });
        queue.push({ type: "done", text: "", usage: null, model: this.model });
      })
      .finally(() => queue.end());
    for await (const ev of queue) yield ev;
    await run;
  }

  closeConversation(conversation: string): void {
    const s = this.sessions.get(conversation);
    this.sessions.delete(conversation);
    const conn = this.conn;
    if (s === undefined || conn === null || !conn.alive) return;
    if (conn.init.agentCapabilities?.sessionCapabilities?.close != null) {
      void conn.agent.request(acp.methods.agent.session.close, { sessionId: s.id }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sessions.clear();
    const conn = this.conn ?? (await this.connecting?.catch(() => null)) ?? null;
    this.conn = null;
    if (conn === null || !conn.alive) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        conn.child.kill("SIGKILL");
      }, 2000);
      conn.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      conn.child.kill("SIGTERM");
    });
  }

  /* ---------------------------------------------------------------------------------------- */

  private async drive(
    input: AgentTurnInput,
    hooks: AgentTurnHooks,
    queue: AsyncQueue<AgentEvent>,
  ): Promise<void> {
    const { spec } = this.o;
    const missing = missingRequirement(spec, this.o.env);
    if (missing !== null) throw new UserFacingError(missing);

    const conn = await this.connect();
    const session = await this.session(conn, input, queue);
    const mapper = new TurnMapper(hooks, (e) => queue.push(e), spec.kind);
    mapper.onModel = (m) => {
      this.model = m;
    };
    session.turn = mapper;
    const cancel = () => {
      mapper.cancelled = true;
      void conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.id });
    };
    if (input.signal?.aborted) cancel();
    input.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const preamble = session.primed ? [] : [this.preamble(input)];
      session.primed = true;
      let response: acp.PromptResponse;
      try {
        response = await conn.agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.id,
          prompt: [...preamble, { type: "text", text: input.text }],
        });
      } catch (err) {
        // Whatever the agent kept of a failed turn, the next one starts a new session from the log.
        this.closeConversation(input.conversation);
        throw err;
      }
      mapper.addPromptUsage(response);
      if (response.stopReason === "refusal")
        queue.push({ type: "error", message: `${spec.label} declined to answer.` });
      else if (response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests")
        queue.push({
          type: "error",
          message: `${spec.label} stopped before it finished (${response.stopReason}).`,
        });
      queue.push({
        type: "done",
        text: mapper.fullText,
        usage: mapper.collectedUsage(),
        model: this.model,
      });
    } finally {
      input.signal?.removeEventListener("abort", cancel);
      session.turn = null;
    }
  }

  /** What a new session is told before the first message: the briefing, then the log's projection. */
  private preamble(input: AgentTurnInput): { type: "text"; text: string } {
    const context = renderAgentContext(input.context);
    return {
      type: "text",
      text: `${AGENT_BRIEFING}${context === "" ? "" : `\n\n${context}`}\n\nThe user's message follows.`,
    };
  }

  private async connect(): Promise<Connection> {
    if (this.closed) throw new UserFacingError("draft is closing.");
    if (this.conn?.alive && !this.conn.signal.aborted) return this.conn;
    this.connecting ??= this.start().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async start(): Promise<Connection> {
    const { spec, cwd } = this.o;
    mkdirSync(cwd, { recursive: true });
    const env = agentEnvironment(spec, this.o.env);
    const child = spawn(spec.command, spec.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr.push(d);
      while (stderr.join("").length > 4000) stderr.shift();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err: NodeJS.ErrnoException) =>
        reject(
          new UserFacingError(
            err.code === "ENOENT"
              ? `draft couldn't start ${spec.label}: "${spec.command}" wasn't found. Install it, or set its path for "${spec.id}" under "agents" in config.json.`
              : `draft couldn't start ${spec.label}: ${err.message}`,
          ),
        ),
      );
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    // Session updates are read here, in the order they arrive, before the SDK dispatches anything.
    // The SDK runs notification handlers concurrently and resolves a response as soon as it
    // arrives, so a handler could see an update after its prompt's response. ACP promises the
    // updates of a turn come before its response; reading them in line keeps that promise.
    const ordered = stream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform: (message, controller) => {
          this.record("in", message);
          this.observe(message);
          controller.enqueue(message);
        },
      }),
    );
    const outgoing = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform: (message, controller) => {
        this.record("out", message);
        controller.enqueue(message);
      },
    });
    void outgoing.readable.pipeTo(stream.writable).catch(() => {});
    const app = acp
      .client({ name: this.o.clientInfo.name })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const turn = this.bySessionId(params.sessionId)?.turn;
        // Nobody is waiting for the answer: nothing is allowed.
        if (turn == null) return { outcome: { outcome: "cancelled" as const } };
        return turn.onPermissionRequest(params);
      })
      // Already handled in line (see above).
      .onNotification(acp.methods.client.session.update, () => {});
    const connection = app.connect({ readable: ordered, writable: outgoing.writable });
    const conn: Connection = {
      child,
      signal: connection.signal,
      agent: connection.agent,
      init: { protocolVersion: acp.PROTOCOL_VERSION },
      stderr,
      alive: true,
    };
    const dead = () => {
      conn.alive = false;
      if (this.conn === conn) {
        this.conn = null;
        // The agent's sessions died with it; the next turn starts a new one from the log.
        this.sessions.clear();
      }
    };
    child.once("exit", dead);
    child.once("error", dead);
    void connection.closed.finally(dead);
    child.stdin.on("error", () => {});

    try {
      conn.init = await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // No file system and no terminal: the agent has no tools of its own to run in draft.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.o.clientInfo.name, version: this.o.clientInfo.version },
      });
    } catch (err) {
      child.kill("SIGKILL");
      throw err;
    }
    this.version = this.versionOf(conn.init);
    this.conn = conn;
    return conn;
  }

  private record(direction: "in" | "out", message: acp.AnyMessage): void {
    if (this.o.transcript === undefined) return;
    const redacted = JSON.stringify(message, (key, value) =>
      (key === "headers" || key === "env") && Array.isArray(value)
        ? value.map((v: { name?: string }) => ({ name: v?.name, value: "[redacted]" }))
        : value,
    );
    try {
      appendFileSync(
        this.o.transcript,
        `{"at":"${new Date().toISOString()}","agent":${JSON.stringify(this.o.spec.id)},"dir":"${direction}","msg":${redacted}}\n`,
      );
    } catch {
      // A transcript is a diagnostic; failing to write it never stops a turn.
    }
  }

  /** Routes a session update to its conversation's turn. Called in arrival order. */
  private observe(message: acp.AnyMessage): void {
    const m = message as { method?: unknown; id?: unknown; params?: unknown };
    if (m.method !== acp.methods.client.session.update || m.id !== undefined) return;
    const params = m.params as Partial<acp.SessionNotification> | undefined;
    const update = params?.update as acp.SessionUpdate | undefined;
    if (typeof params?.sessionId !== "string" || typeof update?.sessionUpdate !== "string") return;
    if (update.sessionUpdate === "config_option_update") {
      const model = modelFromConfig(update.configOptions);
      if (model !== null) this.model = model;
    }
    try {
      this.bySessionId(params.sessionId)?.turn?.onUpdate(update);
    } catch {
      // A malformed update is dropped; it must not stop the connection.
    }
  }

  private versionOf(init: acp.InitializeResponse): string {
    const info = init.agentInfo;
    if (info != null) return `${info.name} ${info.version}`;
    const { spec } = this.o;
    if (spec.versionArgs !== null) {
      const r = spawnSync(spec.command, spec.versionArgs, { encoding: "utf8", timeout: 5000 });
      const line = r.status === 0 ? r.stdout.split("\n")[0]?.trim() : "";
      if (line) return line;
    }
    return `${spec.command} (version not reported)`;
  }

  /** The session of a conversation, started from the log's projection when there is none. */
  private async session(
    conn: Connection,
    input: AgentTurnInput,
    queue: AsyncQueue<AgentEvent>,
  ): Promise<Session> {
    const token = this.o.kiro === null ? null : await this.o.kiro.token();
    const existing = this.sessions.get(input.conversation);
    // A refreshed token means new MCP headers, so the session starts again from the log.
    if (existing !== undefined && existing.token === token) return existing;
    if (existing !== undefined) this.closeConversation(input.conversation);

    const { spec } = this.o;
    const request: acp.NewSessionRequest = {
      cwd: this.o.cwd,
      mcpServers: this.mcpServers(conn.init, token),
      ...(spec.kind === "claude"
        ? {
            // The adapter reads the user's Claude settings by default, which can allow tools
            // without asking. Neither those settings nor Claude Code's own tools are wanted here.
            _meta: { claudeCode: { options: { settingSources: [], tools: [] } } },
          }
        : {}),
    };
    const created = await conn.agent.request(acp.methods.agent.session.new, request);
    const session: Session = { id: created.sessionId, token, primed: false, turn: null };
    try {
      await this.askFirst(conn, session.id, created);
    } catch (err) {
      this.sessions.delete(input.conversation);
      void conn.agent
        .request(acp.methods.agent.session.close, { sessionId: session.id })
        .catch(() => {});
      throw err;
    }
    const model = modelFromConfig(created.configOptions);
    if (model !== null) this.model = model;
    this.sessions.set(input.conversation, session);
    queue.push({ type: "session-started" });
    return session;
  }

  /**
   * Makes the agent ask before it acts. Neither agent is guaranteed to: Claude's adapter starts in
   * "auto" mode, where Claude decides for itself, and Kiro starts with its autopilot on, which
   * accepts file changes without asking. Both are switched off here and the answer is checked: if
   * the agent won't ask, the session doesn't start.
   */
  private async askFirst(
    conn: Connection,
    sessionId: string,
    created: acp.NewSessionResponse,
  ): Promise<void> {
    const { spec } = this.o;
    const options = created.configOptions ?? [];
    const find = (id: string) =>
      options.find((o) => o.id === id) as { currentValue?: unknown } | undefined;
    let wrong: string | null = null;

    const set = async (configId: string, value: string) => {
      const r = await conn.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      } as acp.SetSessionConfigOptionRequest);
      const now = (r.configOptions ?? []).find((o) => o.id === configId) as
        | { currentValue?: unknown }
        | undefined;
      return now?.currentValue === value;
    };

    if (spec.kind === "claude") {
      const mode = find("mode");
      if (mode !== undefined) {
        if (mode.currentValue !== "default" && !(await set("mode", "default")))
          wrong = `its permission mode is "${String(mode.currentValue)}", not "default"`;
      } else if (created.modes != null && created.modes.currentModeId !== "default") {
        const hasDefault = created.modes.availableModes.some((m) => m.id === "default");
        if (!hasDefault) wrong = "it has no mode that always asks";
        else
          await conn.agent.request(acp.methods.agent.session.setMode, {
            sessionId,
            modeId: "default",
          });
      }
    }
    // Kiro's autopilot accepts file changes without asking. Any agent that advertises an
    // autopilot option gets it switched off, whatever draft knows it as.
    const autopilot = find("autopilot");
    if (
      wrong === null &&
      autopilot !== undefined &&
      autopilot.currentValue !== "off" &&
      !(await set("autopilot", "off"))
    )
      wrong = "its autopilot stays on";
    if (wrong !== null) {
      throw new UserFacingError(
        `draft couldn't make ${spec.label} ask before it acts (${wrong}), so it did not start a session.`,
      );
    }
  }

  /** Kiro Remote's MCP server for the agent: HTTP with a bearer header if the agent can, else stdio. */
  private mcpServers(init: acp.InitializeResponse, token: string | null): acp.McpServer[] {
    const kiro = this.o.kiro;
    if (kiro === null) return [];
    if (init.agentCapabilities?.mcpCapabilities?.http === true) {
      return [
        {
          type: "http",
          name: KIRO_SERVER,
          url: kiro.url,
          headers: token === null ? [] : [{ name: "Authorization", value: `Bearer ${token}` }],
        },
      ];
    }
    // The agent can't reach an HTTP MCP server: the kiro-remote client speaks MCP over stdio
    // instead, signed in with its own `kiro-remote login`.
    return [
      {
        name: KIRO_SERVER,
        command: "kiro-remote",
        args: ["mcp"],
        env: [{ name: "KIRO_REMOTE_URL", value: kiro.baseUrl }],
      },
    ];
  }

  /** A message for the person using draft, with no token or key in it. */
  private describe(err: unknown): string {
    const { spec } = this.o;
    if (err instanceof UserFacingError) return err.message;
    if (err instanceof acp.RequestError && err.code === acp.RequestError.authRequired().code)
      return `${spec.label} isn't signed in. ${spec.signIn}`;
    const conn = this.conn;
    const tail = (conn?.stderr.join("") ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    const base =
      err instanceof Error ? err.message : typeof err === "string" ? err : "an unknown error";
    const message = `${spec.label} stopped with an error: ${base}${tail === "" ? "" : ` (${tail})`}`;
    return this.redact(message);
  }

  private redact(text: string): string {
    let out = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer …");
    for (const r of this.o.spec.requires) {
      const v = this.o.env[r.name];
      if (v !== undefined && v !== "") out = out.split(v).join("…");
    }
    return out;
  }
}
