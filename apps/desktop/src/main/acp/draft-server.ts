import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DRAFT_SERVER, type DraftTool } from "@nikovirtala/draft-core";
import { z } from "zod";

/**
 * draft's own MCP server, for the tools of a trusted folder (agent-tools.ts in core).
 *
 * It listens on 127.0.0.1 and answers MCP over Streamable HTTP with plain JSON responses: one
 * POST, one answer. Each agent session has its own bearer token, handed over in `session/new`, so
 * a call is always for one session, one conversation and one trusted folder; a request without a
 * token it knows is refused. The server decides nothing about a call: it hands it to the session's
 * handler, which applies the policy, asks the person and runs it.
 *
 * Why the call is gated here and not by the agent's permission request: the agent's own rules
 * decide whether it asks before an MCP call, and a person's rules may allow everything. A call
 * reaches this server whatever they say, so asking here holds whatever they say.
 */

export interface DraftCallResult {
  text: string;
  isError: boolean;
}

export interface DraftSessionHandle {
  /** The tools this session offers. */
  tools: readonly DraftTool[];
  /**
   * Answers a request for a call. `requestId` is the JSON-RPC id of the request: a request that
   * arrives again with the same id is a retry and gets the first answer. A call outlives its
   * request (draft-session.ts): the answer may be "still deciding, call again", and `signal`
   * aborts when the agent hangs up, which ends the wait and not the call.
   */
  call(
    tool: string,
    input: unknown,
    requestId: string | number,
    signal: AbortSignal,
  ): Promise<DraftCallResult>;
  /**
   * The client cancelled this request (`notifications/cancelled`). Called whether or not the
   * request was answered already: a result written to a request the client had given up on is
   * given back to the next request for the same call.
   */
  cancelled?(requestId: string | number): void;
}

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 4_000_000;

export class DraftToolServer {
  private server: Server | null = null;
  private starting: Promise<string> | null = null;
  private port = 0;
  private readonly sessions = new Map<string, DraftSessionHandle>();
  /** The `tools/call` requests being answered, by session and JSON-RPC id, for `notifications/cancelled`. */
  private readonly inflight = new WeakMap<
    DraftSessionHandle,
    Map<string | number, AbortController>
  >();

  /** The endpoint to hand to an agent; starts the server the first time. */
  url(): Promise<string> {
    this.starting ??= this.listen();
    return this.starting;
  }

  /** A bearer token for one session, until `release` is called. */
  register(handle: DraftSessionHandle): { token: string; release(): void } {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, handle);
    return { token, release: () => void this.sessions.delete(token) };
  }

  async close(): Promise<void> {
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    this.starting = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        resolve(`http://127.0.0.1:${this.port}/mcp`);
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      // A web page can reach 127.0.0.1 too: refuse a request that names another host or has an origin.
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reply(403);
      if (req.headers.origin !== undefined) return reply(403);
      if (req.url !== "/mcp") return reply(404);
      if (req.method !== "POST") return reply(405);
      const auth = req.headers.authorization ?? "";
      const handle = auth.startsWith("Bearer ") ? this.sessions.get(auth.slice(7)) : undefined;
      if (handle === undefined) return reply(401);

      const body = await readBody(req);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return reply(400, rpcError(null, -32700, "parse error"));
      }
      const hangup = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) hangup.abort();
      });
      if (Array.isArray(message)) {
        const answers = (
          await Promise.all(message.map((m) => this.answer(handle, m, hangup.signal)))
        ).filter((a) => a !== null);
        return answers.length === 0 ? reply(202) : reply(200, answers);
      }
      const answer = await this.answer(handle, message, hangup.signal);
      return answer === null ? reply(202) : reply(200, answer);
    } catch (err) {
      if (!res.headersSent)
        reply(500, rpcError(null, -32603, err instanceof Error ? err.message : "error"));
    }
  }

  /** One JSON-RPC message; null for a notification, which has no answer. */
  private async answer(
    handle: DraftSessionHandle,
    message: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const m = message as {
      id?: string | number;
      method?: unknown;
      params?: Record<string, unknown>;
    };
    if (typeof m !== "object" || m === null || typeof m.method !== "string")
      return rpcError(null, -32600, "invalid request");
    if (m.id === undefined) {
      // A client that gives up on a request says so (https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)
      // and may keep its connection. That ends the wait for the call, not the call: the agent is
      // expected to call again (draft-session.ts).
      const gone = m.params?.requestId;
      if (
        m.method === "notifications/cancelled" &&
        (typeof gone === "string" || typeof gone === "number")
      ) {
        this.inflight.get(handle)?.get(gone)?.abort();
        handle.cancelled?.(gone);
      }
      return null;
    }
    const id = m.id;
    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: DRAFT_SERVER, version: "1" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: handle.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: jsonSchema(t),
            annotations: { readOnlyHint: t.access === "read" },
          })),
        });
      case "tools/call": {
        const name = m.params?.name;
        if (typeof name !== "string") return rpcError(id, -32602, "a tool name is required");
        // Ends when the connection closes or the client cancels this request.
        const request = new AbortController();
        const stop = () => request.abort();
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        const open = this.inflight.get(handle) ?? new Map<string | number, AbortController>();
        this.inflight.set(handle, open);
        open.set(id, request);
        try {
          const r = await handle.call(name, m.params?.arguments ?? {}, id, request.signal);
          return rpcResult(id, { content: [{ type: "text", text: r.text }], isError: r.isError });
        } finally {
          signal.removeEventListener("abort", stop);
          if (open.get(id) === request) open.delete(id);
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${m.method}`);
    }
  }
}

function jsonSchema(tool: DraftTool): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<
    string,
    unknown
  >;
  return schema;
}

const rpcResult = (id: string | number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("the request is too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}
