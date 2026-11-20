import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
}

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
}

export interface ReceivedCall {
  tool: string;
  args: Record<string, unknown>;
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
  baseUrl = "";

  constructor(private readonly o: FakeKiroRemoteOptions = {}) {
    const now = new Date().toISOString();
    for (const s of o.sessions ?? []) this.sessions.set(s.id, seedSession(s, now));
    for (const t of KIRO_REMOTE_TOOLS) {
      this.validators.set(
        t.name,
        z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      );
    }
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

  /** The same scripted tools in process, without HTTP, for unit tests. */
  asTools(): {
    call(
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; structured: unknown; text: string }>;
  } {
    return {
      call: async (tool, args) => {
        this.calls.push({ tool, args, authorized: true });
        try {
          if (this.failNext > 0) {
            this.failNext--;
            throw new Error("service unavailable (scripted failure)");
          }
          const result = this.run(tool, args);
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
    return { ...rest, links: [] };
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
            const { links: _l, ...v } = this.view(s);
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
      tools: [...KIRO_REMOTE_TOOLS] as never,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      this.calls.push({ tool: name, args, authorized });
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
        const result = this.run(name, args);
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
