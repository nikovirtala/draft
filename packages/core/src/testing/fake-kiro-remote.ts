import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { KIRO_MUTATING_TOOLS, KIRO_PERSON_ONLY_TOOLS, withIdempotencyKey } from "../kiro.ts";

/**
 * A fake Kiro Remote for tests and the end-to-end run: the MCP endpoint at `/mcp` serving the
 * real tool list from kiro-remote (names, descriptions, input schemas and annotations, captured
 * from `toolListEntries()` at nikovirtala/kiro-remote@881b06d), with scripted sessions behind
 * them. Tool inputs are checked against those JSON schemas. With `auth: true` it also plays the
 * OAuth facade: protected-resource and authorization-server metadata, Dynamic Client Registration,
 * an authorize endpoint that signs in at once, and a PKCE-checking token endpoint.
 *
 * A control API under `/__control` changes sessions while a test runs.
 */

export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export const KIRO_REMOTE_TOOLS: readonly ToolListEntry[] = (
  JSON.parse(readFileSync(new URL("./kiro-remote-tools.json", import.meta.url), "utf8")) as {
    tools: ToolListEntry[];
  }
).tools;

export interface FakePermission {
  requestId: string;
  toolCallId: string;
  toolCall: Record<string, unknown>;
  options: unknown[];
  consent: null;
  status: "pending" | "answered";
  answer: Record<string, unknown> | null;
}

export interface FakeSession {
  id: string;
  kiroSessionId: string | null;
  title: string | null;
  repos: string[];
  mode: string | null;
  model: string | null;
  effort: string | null;
  status: string;
  activeTurnId: string | null;
  eventSeq: number;
  createdAt: string;
  updatedAt: string;
  permissions: FakePermission[];
  transcript: string[];
  /** Pull requests linked to the session, and the ones it waits for: what GET /v1/sessions/{id} returns. */
  links: {
    pr: string;
    repo: string;
    number: number;
    linkedBy: string;
    linkedAt: string;
    prState: string;
    headSha: string | null;
  }[];
  waits: { pr: string; repo: string; number: number; source: string; createdAt: string }[];
}

/** One event of the change feed, as GET /v1/events returns it (kiro-remote docs/github.md). */
export interface FakeFeedEvent {
  v: number;
  id: string;
  seq: number;
  ts: string;
  type: string;
  effect: string;
  sessionId: string;
  pr: string | null;
  source: string;
  payload: Record<string, unknown>;
}

/** The effect of each type of the contract; any other type says its own. */
const FEED_EFFECTS: Record<string, "state" | "annotation"> = {
  "link.added": "state",
  "link.removed": "state",
  "link.state_changed": "state",
  "wait.registered": "state",
  "wait.removed": "state",
  "wake.queued": "annotation",
  "wake.delivered": "annotation",
  "wake.released": "annotation",
  "wake.dropped": "annotation",
};

export interface FakeSessionSeed {
  id: string;
  title: string;
  status: string;
  repos?: string[];
  pendingPermissions?: number;
  transcript?: string[];
}

export interface FakeKiroRemoteOptions {
  sessions?: readonly FakeSessionSeed[];
  auth?: boolean;
  /** Access token lifetime, for refresh tests. */
  tokenTtlSeconds?: number;
  port?: number;
  /**
   * Act as a Kiro Remote that has an optional `idempotencyKey` on every tool that changes
   * something (kiro-remote 9be84d2): the schemas advertise it, and a repeated call with the same
   * key and input returns the first result without running again. A key reused with different
   * input is refused. Off, it is the Kiro Remote deployed when this fake was captured: the
   * schemas have no key.
   */
  idempotency?: boolean;
}

export interface ReceivedCall {
  tool: string;
  args: Record<string, unknown>;
  authorized: boolean;
}

/** A REST read the fake received. */
export interface ReceivedRest {
  method: string;
  path: string;
  authorized: boolean;
}

function permission(n: number): FakePermission {
  return {
    requestId: `perm-${n}`,
    toolCallId: `call-${n}`,
    toolCall: { title: `Run a command (${n})`, kind: "execute" },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
    consent: null,
    status: "pending",
    answer: null,
  };
}

function seedSession(s: FakeSessionSeed, now: string): FakeSession {
  return {
    id: s.id,
    kiroSessionId: null,
    title: s.title,
    repos: s.repos ?? ["nikovirtala/draft"],
    mode: null,
    model: null,
    effort: null,
    status: s.status,
    activeTurnId: null,
    eventSeq: 0,
    createdAt: now,
    updatedAt: now,
    permissions: Array.from({ length: s.pendingPermissions ?? 0 }, (_, i) => permission(i + 1)),
    transcript: s.transcript ?? [],
    links: [],
    waits: [],
  };
}

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function fakeUlid(): string {
  let s = "01";
  for (const b of randomBytes(24)) s += ULID_CHARS[b % 32];
  return s;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export class FakeKiroRemote {
  readonly sessions = new Map<string, FakeSession>();
  readonly calls: ReceivedCall[] = [];
  private server: Server | null = null;
  private readonly validators = new Map<string, z.ZodType>();
  private readonly clients = new Map<string, { redirectUris: string[] }>();
  private readonly codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string }
  >();
  private readonly accessTokens = new Map<string, number>();
  private readonly refreshTokens = new Set<string>();
  /** Fail the next n tool calls with a tool error, to test resolver failures. */
  failNext = 0;
  /**
   * Tools whose calls take effect but are never answered, as when the caller dies mid-call: for
   * testing what happens to a step whose result never comes back.
   */
  readonly hang = new Set<string>();
  /** Calls that ran, by tool, so a test can tell a replayed call from one that ran. */
  readonly executed: ReceivedCall[] = [];
  /** The change feed, in order, as the real one keeps it for its owner. */
  readonly feed: FakeFeedEvent[] = [];
  /** The REST reads the fake answered. */
  readonly rest: ReceivedRest[] = [];
  private feedSeq = 0;
  /** Fail the next n REST reads with a 503, to test a reader that must back off. */
  failRest = 0;
  /** First results by tool and key, for 24 hours in the real one and for the life of this fake. */
  private readonly keyed = new Map<string, { input: string; result: Record<string, unknown> }>();
  /** Called as each tool call arrives, before it is answered. */
  onCall: ((call: ReceivedCall) => void) | null = null;
  baseUrl = "";

  constructor(private readonly o: FakeKiroRemoteOptions = {}) {
    const now = new Date().toISOString();
    for (const s of o.sessions ?? []) this.sessions.set(s.id, seedSession(s, now));
    for (const t of this.tools()) {
      this.validators.set(
        t.name,
        z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      );
    }
  }

  /** The tool list this fake serves: the captured one, with a key on the mutating tools if asked. */
  tools(): ToolListEntry[] {
    if (this.o.idempotency !== true) return [...KIRO_REMOTE_TOOLS];
    const changing: readonly string[] = [...KIRO_MUTATING_TOOLS, ...KIRO_PERSON_ONLY_TOOLS];
    return KIRO_REMOTE_TOOLS.map((t) => {
      if (!changing.includes(t.name)) return t;
      const schema = t.inputSchema as { properties?: Record<string, unknown> };
      return {
        ...t,
        inputSchema: {
          ...schema,
          properties: {
            ...schema.properties,
            idempotencyKey: {
              type: "string",
              minLength: 1,
              maxLength: 255,
              pattern: "^[A-Za-z0-9._~:-]+$",
            },
          },
        },
      };
    });
  }

  /**
   * Runs a tool with its key, once per key: the first result comes back for the same key and input.
   * The key is the input's own field, as in the real tools, and is never part of what runs.
   */
  private runKeyed(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const { idempotencyKey, ...input } = args;
    if (typeof idempotencyKey !== "string") return this.execute(tool, args);
    const slot = `${tool}\u0000${idempotencyKey}`;
    const known = this.keyed.get(slot);
    const fingerprint = JSON.stringify(input, Object.keys(input).sort());
    if (known !== undefined) {
      if (known.input !== fingerprint)
        throw new Error("idempotency key reused with a different request");
      return known.result;
    }
    const result = this.execute(tool, input);
    this.keyed.set(slot, { input: fingerprint, result });
    return result;
  }

  private execute(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    this.executed.push({ tool, args, authorized: true });
    return this.run(tool, args);
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: String(err) });
      });
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(this.o.port ?? 0, "127.0.0.1", resolve),
    );
    const a = this.server.address();
    this.baseUrl = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s === null) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Changes a session as the real service would, e.g. a turn asking for permission. */
  update(
    id: string,
    patch: { status?: string; title?: string; pendingPermissions?: number },
  ): FakeSession {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`no fake session ${id}`);
    if (patch.status !== undefined) s.status = patch.status;
    if (patch.title !== undefined) s.title = patch.title;
    if (patch.pendingPermissions !== undefined) {
      const answered = s.permissions.filter((p) => p.status !== "pending");
      s.permissions = [
        ...answered,
        ...Array.from({ length: patch.pendingPermissions }, (_, i) =>
          permission(answered.length + i + 1),
        ),
      ];
    }
    s.updatedAt = new Date().toISOString();
    s.eventSeq++;
    return s;
  }

  /**
   * Appends one event to the change feed, numbered as the real service numbers them: 1, 2, 3, with
   * no gap. A type of the contract takes its effect; any other type says its own, as a type draft
   * has never heard of would.
   */
  emit(e: {
    type: string;
    sessionId: string;
    pr?: string | null;
    payload?: Record<string, unknown>;
    source?: string;
    effect?: string;
    ts?: string;
    v?: number;
  }): FakeFeedEvent {
    const event: FakeFeedEvent = {
      v: e.v ?? 1,
      id: fakeUlid(),
      seq: ++this.feedSeq,
      ts: e.ts ?? new Date().toISOString(),
      type: e.type,
      effect: e.effect ?? FEED_EFFECTS[e.type] ?? "state",
      sessionId: e.sessionId,
      pr: e.pr ?? null,
      source: e.source ?? "rest",
      payload: e.payload ?? {},
    };
    this.feed.push(event);
    return event;
  }

  /** The sequence number of the last event of the feed. */
  get feedHead(): number {
    return this.feedSeq;
  }

  /** Drops the events before `seq`, as the service's retention does: a reader with an older cursor sees a gap. */
  expireBefore(seq: number): void {
    this.feed.splice(
      0,
      this.feed.findIndex((e) => e.seq >= seq) < 0
        ? this.feed.length
        : this.feed.findIndex((e) => e.seq >= seq),
    );
  }

  private session(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`no fake session ${id}`);
    return s;
  }

  /** A session starts waiting for a pull request: the session says so, and the feed does. */
  startWaiting(id: string, pr: string, source = "mcp"): void {
    const s = this.session(id);
    const [repo, number] = pr.split("#") as [string, string];
    if (!s.waits.some((w) => w.pr === pr))
      s.waits.push({
        pr,
        repo,
        number: Number(number),
        source,
        createdAt: new Date().toISOString(),
      });
    this.emit({
      type: "wait.registered",
      sessionId: id,
      pr,
      source,
      payload: { waitSource: source },
    });
  }

  /**
   * A wait ends. `merged`, `closed` and `unreadable` fired it, so Kiro Remote queues the wake they
   * caused in the same commit (its id is returned); `stopped` and `registration_failed` did not.
   */
  endWait(
    id: string,
    pr: string,
    reason: "merged" | "closed" | "unreadable" | "stopped" | "registration_failed",
  ): string | null {
    const s = this.session(id);
    s.waits = s.waits.filter((w) => w.pr !== pr);
    const source =
      reason === "stopped" ? "rest" : reason === "registration_failed" ? "sweep" : "webhook";
    this.emit({ type: "wait.removed", sessionId: id, pr, source, payload: { reason } });
    if (reason !== "merged" && reason !== "closed" && reason !== "unreadable") return null;
    const itemId = `wake-${this.feedSeq}`;
    this.emit({
      type: "wake.queued",
      sessionId: id,
      pr,
      source,
      payload: { itemId, kind: `pr_wait_${reason}`, cause: "wait", merged: false },
    });
    return itemId;
  }

  /** The wake queued for an item is sent to the session as a turn. */
  deliverWake(id: string, itemId: string): void {
    const q = [...this.feed]
      .reverse()
      .find((e) => e.type === "wake.queued" && e.payload.itemId === itemId && e.sessionId === id);
    if (q === undefined) throw new Error(`no queued wake ${itemId}`);
    this.emit({
      type: "wake.delivered",
      sessionId: id,
      pr: q.pr,
      source: q.source,
      payload: { itemId, kind: q.payload.kind, cause: q.payload.cause, turnId: fakeUlid() },
    });
  }

  /** A session's pull request is linked: the session says so, and the feed does. */
  link(id: string, pr: string, linkedBy = "manual"): void {
    const s = this.session(id);
    const [repo, number] = pr.split("#") as [string, string];
    s.links.push({
      pr,
      repo,
      number: Number(number),
      linkedBy,
      linkedAt: new Date().toISOString(),
      prState: "open",
      headSha: null,
    });
    this.emit({
      type: "link.added",
      sessionId: id,
      pr,
      source: "rest",
      payload: { method: linkedBy, prState: "open" },
    });
  }

  /** The same scripted tools in process, without HTTP, for unit tests. */
  asTools(): {
    call(
      tool: string,
      args: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ): Promise<{ isError: boolean; structured: unknown; text: string }>;
  } {
    return {
      call: async (tool, rawArgs, options) => {
        // As the MCP client does: the key goes only where the schema advertises one.
        const args = withIdempotencyKey(
          this.tools().find((t) => t.name === tool)?.inputSchema,
          rawArgs,
          options?.idempotencyKey,
        );
        this.calls.push({ tool, args, authorized: true });
        try {
          if (this.failNext > 0) {
            this.failNext--;
            throw new Error("service unavailable (scripted failure)");
          }
          const result = this.runKeyed(tool, args);
          return { isError: false, structured: result, text: JSON.stringify(result) };
        } catch (err) {
          return {
            isError: true,
            structured: null,
            text: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  }

  private view(s: FakeSession) {
    const { permissions: _p, transcript: _t, ...rest } = s;
    return { ...rest };
  }

  /** The scripted behaviour behind each tool, returning kiro-remote's result shapes. */
  private run(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const session = () => {
      const s = this.sessions.get(String(args.sessionId));
      if (s === undefined) throw new Error(`session not found: ${String(args.sessionId)}`);
      return s;
    };
    switch (tool) {
      case "kiro_capabilities":
        return {
          capabilities: { streamableHttp: true },
          kiroCliVersion: "fake",
          activeSessionCount: [...this.sessions.values()].filter((s) => s.status !== "deleted")
            .length,
        };
      case "kiro_list_models":
        return { models: [], source: null };
      case "kiro_list_sessions": {
        const list = [...this.sessions.values()]
          .filter((s) => args.status === undefined || s.status === args.status)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .map((s) => {
            const { links: _l, waits: _w, ...v } = this.view(s);
            return v;
          });
        return { sessions: list.slice(0, Number(args.limit ?? 20)) };
      }
      case "kiro_get_session":
        return { session: this.view(session()) };
      case "kiro_launch_session": {
        const id = fakeUlid();
        const s = seedSession(
          {
            id,
            title: String(args.title ?? String(args.prompt).slice(0, 40)),
            status: "provisioning",
            repos: args.repos as string[],
          },
          new Date().toISOString(),
        );
        this.sessions.set(id, s);
        return { sessionId: id, turnId: fakeUlid() };
      }
      case "kiro_send_prompt": {
        const s = session();
        s.status = "running";
        s.updatedAt = new Date().toISOString();
        return {
          turn: {
            id: fakeUlid(),
            sessionId: s.id,
            status: "queued",
            stopReason: null,
            startedAt: null,
            endedAt: null,
          },
        };
      }
      case "kiro_wait_for_events": {
        const s = session();
        return {
          events: [],
          text: "",
          nextCursor: Number(args.after ?? 0),
          turnStatus: s.status === "running" ? "running" : null,
          pendingPermissionCount: s.permissions.filter((p) => p.status === "pending").length,
          eventsTruncated: false,
          droppedEvents: 0,
          textTruncated: false,
          droppedTextChars: 0,
        };
      }
      case "kiro_get_transcript": {
        const s = session();
        return {
          sessionId: s.id,
          turns: s.transcript.map((text, i) => ({
            turnId: `turn-${i + 1}`,
            text,
            trigger: { source: "user", deliveryIds: [] },
          })),
        };
      }
      case "kiro_list_permissions": {
        const s = session();
        const { permissions } = s;
        return {
          permissions: permissions
            .filter((p) => args.status === undefined || p.status === args.status)
            .map((p) => ({ ...p })),
        };
      }
      case "kiro_answer_permission": {
        const s = session();
        const p = s.permissions.find(
          (x) => x.requestId === args.requestId && x.status === "pending",
        );
        if (p === undefined) throw new Error(`no pending permission ${String(args.requestId)}`);
        p.status = "answered";
        p.answer = { optionId: args.optionId };
        if (!s.permissions.some((x) => x.status === "pending")) s.status = "running";
        s.updatedAt = new Date().toISOString();
        return { requestId: p.requestId, status: "answered" };
      }
      case "kiro_cancel_turn":
        session();
        return { sessionId: args.sessionId, status: "cancelling" };
      case "kiro_delete_session": {
        const s = session();
        s.status = "deleted";
        return { sessionId: s.id, status: "deleting" };
      }
      case "kiro_set_config":
        session();
        return { sessionId: args.sessionId, status: "configuring" };
      case "kiro_adopt_session":
        throw new Error("adopting is rejected for cloud sessions");
      case "kiro_link_pull_request":
        session();
        return { sessionId: args.sessionId, link: { pr: args.pr } };
      case "kiro_unlink_pull_request":
        session();
        return { sessionId: args.sessionId, pr: args.pr, status: "unlinked" };
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  private mcpServer(authorized: boolean): McpServer {
    const server = new McpServer(
      { name: "kiro-remote", version: "0.0.0-fake" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools() as never,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const received = { tool: name, args, authorized };
      this.calls.push(received);
      this.onCall?.(received);
      try {
        if (this.failNext > 0) {
          this.failNext--;
          throw new Error("service unavailable (scripted failure)");
        }
        const validator = this.validators.get(name);
        if (validator === undefined) throw new Error(`unknown tool: ${name}`);
        const checked = validator.safeParse(args);
        if (!checked.success)
          throw new Error(
            `invalid input: ${checked.error.issues.map((i) => i.message).join("; ")}`,
          );
        const result = this.runKeyed(name, args);
        if (this.hang.has(name)) await new Promise(() => {});
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
    return server;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const path = url.pathname;

    if (path.startsWith("/__control/")) return this.control(req, res, path);

    if (path.startsWith("/v1/")) return this.restRoute(req, res, url);

    if (path === "/mcp") {
      const authorized = this.checkBearer(req);
      if (this.o.auth === true && !authorized) {
        json(
          res,
          401,
          { error: "invalid_token" },
          {
            "www-authenticate": `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
        return;
      }
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = this.mcpServer(authorized);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (this.o.auth !== true) return json(res, 404, { error: "not found" });
    return this.oauth(req, res, url);
  }

  /** The REST reads of the change feed: GET /v1/events and GET /v1/sessions/{id}. */
  private restRoute(req: IncomingMessage, res: ServerResponse, url: URL): ReturnType<typeof json> {
    const authorized = this.checkBearer(req);
    this.rest.push({
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorized,
    });
    if (this.o.auth === true && !authorized)
      return json(
        res,
        401,
        { type: "unauthorized", status: 401 },
        {
          "www-authenticate": `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
        },
      );
    if (this.failRest > 0) {
      this.failRest--;
      return json(res, 503, { type: "unavailable", status: 503 });
    }
    if (req.method !== "GET") return json(res, 405, { status: 405 });
    if (url.pathname === "/v1/events") {
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const later = this.feed.filter((e) => e.seq > after);
      const events = later.slice(0, limit);
      return json(res, 200, {
        events,
        nextCursor: events.at(-1)?.seq ?? after,
        hasMore: later.length > events.length,
      });
    }
    const m = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (m !== null) {
      const s = this.sessions.get(decodeURIComponent(m[1] as string));
      return s === undefined ? json(res, 404, { status: 404 }) : json(res, 200, this.view(s));
    }
    return json(res, 404, { status: 404 });
  }

  private checkBearer(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (m === null) return false;
    const exp = this.accessTokens.get(m[1] as string);
    return exp !== undefined && exp > Date.now();
  }

  private async oauth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const base = this.baseUrl;
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return json(res, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["sessions:read", "sessions:write", "sessions:delete"],
          bearer_methods_supported: ["header"],
        });
      case "/.well-known/oauth-authorization-server":
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          revocation_endpoint: `${base}/oauth/revoke`,
          registration_endpoint: `${base}/oauth/register`,
          jwks_uri: `${base}/jwks.json`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["sessions:read", "sessions:write", "sessions:delete"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      case "/oauth/register": {
        const meta = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
        const uris = meta.redirect_uris ?? [];
        if (
          uris.length === 0 ||
          !uris.every((u) => /^https:|^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u))
        ) {
          return json(res, 400, { error: "invalid_redirect_uri" });
        }
        const clientId = `mcp_${randomBytes(12).toString("hex")}`;
        this.clients.set(clientId, { redirectUris: uris });
        return json(res, 201, {
          ...meta,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: "none",
        });
      }
      case "/oauth/authorize": {
        const q = url.searchParams;
        const client = this.clients.get(q.get("client_id") ?? "");
        const redirect = q.get("redirect_uri") ?? "";
        const loopbackMatch = (reg: string) => {
          const a = new URL(reg);
          const b = new URL(redirect);
          return a.protocol === "http:" && a.hostname === b.hostname && a.pathname === b.pathname;
        };
        if (
          client === undefined ||
          !client.redirectUris.some((r) => r === redirect || loopbackMatch(r))
        ) {
          return json(res, 400, { error: "invalid_client" });
        }
        if (q.get("code_challenge_method") !== "S256" || q.get("code_challenge") === null) {
          return json(res, 400, { error: "invalid_request" });
        }
        const code = randomBytes(16).toString("hex");
        this.codes.set(code, {
          clientId: q.get("client_id") as string,
          challenge: q.get("code_challenge") as string,
          redirectUri: redirect,
        });
        const to = new URL(redirect);
        to.searchParams.set("code", code);
        const state = q.get("state");
        if (state !== null) to.searchParams.set("state", state);
        to.searchParams.set("iss", base);
        res.writeHead(302, { location: to.toString() });
        res.end();
        return;
      }
      case "/oauth/token": {
        const form = new URLSearchParams(await readBody(req));
        const issue = () => {
          const access = `fake-access-${randomBytes(12).toString("hex")}`;
          const refresh = `fake-refresh-${randomBytes(12).toString("hex")}`;
          const ttl = this.o.tokenTtlSeconds ?? 3600;
          this.accessTokens.set(access, Date.now() + ttl * 1000);
          this.refreshTokens.add(refresh);
          return {
            access_token: access,
            refresh_token: refresh,
            token_type: "Bearer",
            expires_in: ttl,
            scope: "openid sessions:read sessions:write sessions:delete",
          };
        };
        if (form.get("grant_type") === "authorization_code") {
          const c = this.codes.get(form.get("code") ?? "");
          this.codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            c === undefined ||
            c.challenge !== challenge ||
            c.redirectUri !== form.get("redirect_uri")
          ) {
            return json(res, 400, { error: "invalid_grant" });
          }
          return json(res, 200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          const r = form.get("refresh_token") ?? "";
          if (!this.refreshTokens.has(r)) return json(res, 400, { error: "invalid_grant" });
          this.refreshTokens.delete(r);
          return json(res, 200, issue());
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  private async control(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const m = /^\/__control\/sessions\/([^/]+)$/.exec(path);
    if (m !== null && req.method === "POST") {
      const patch = JSON.parse((await readBody(req)) || "{}");
      try {
        return json(res, 200, this.view(this.update(decodeURIComponent(m[1] as string), patch)));
      } catch (err) {
        return json(res, 404, { error: String(err) });
      }
    }
    if (path === "/__control/calls") return json(res, 200, { calls: this.calls });
    return json(res, 404, { error: "not found" });
  }
}
