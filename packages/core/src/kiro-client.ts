import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallOptions,
  type KiroRemoteTools,
  type ToolCallResult,
  withIdempotencyKey,
} from "./kiro.ts";
import { DRAFT_VERSION } from "./version.ts";

export interface McpKiroOptions {
  /** The Kiro Remote MCP endpoint, `<base>/mcp`. */
  url: string;
  /** Supplies the bearer token; the transport refreshes and re-authorizes through it on a 401. */
  authProvider?: OAuthClientProvider;
  fetch?: typeof fetch;
}

/** Kiro Remote's tools over MCP Streamable HTTP, for draft's own resolvers. */
export class McpKiroRemoteTools implements KiroRemoteTools {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Each tool's input schema, read once per connection: it decides whether a key is sent. */
  private schemas: Map<string, unknown> | null = null;

  constructor(private readonly o: McpKiroOptions) {}

  private async connect(): Promise<Client> {
    if (this.client !== null) return this.client;
    if (this.connecting === null) {
      this.connecting = (async () => {
        const client = new Client({ name: "draft", version: DRAFT_VERSION });
        const transport = new StreamableHTTPClientTransport(new URL(this.o.url), {
          ...(this.o.authProvider === undefined ? {} : { authProvider: this.o.authProvider }),
          ...(this.o.fetch === undefined ? {} : { fetch: this.o.fetch }),
        });
        await client.connect(transport);
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async schemaOf(client: Client, tool: string): Promise<unknown> {
    if (this.schemas === null) {
      const schemas = new Map<string, unknown>();
      try {
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? {} : { cursor });
          for (const t of page.tools) schemas.set(t.name, t.inputSchema);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      } catch {
        // Without the list nothing is known to take a key, so none is sent.
      }
      this.schemas = schemas;
    }
    return this.schemas.get(tool);
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ToolCallResult> {
    const client = await this.connect();
    try {
      const sent =
        options.idempotencyKey === undefined
          ? args
          : withIdempotencyKey(await this.schemaOf(client, tool), args, options.idempotencyKey);
      const r = await client.callTool({ name: tool, arguments: sent });
      return toToolCallResult(
        r as { content?: unknown; structuredContent?: unknown; isError?: unknown },
      );
    } catch (err) {
      // A dropped connection is retried once on a fresh client.
      await this.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.schemas = null;
    await c?.close().catch(() => {});
  }
}

export function toToolCallResult(r: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}): ToolCallResult {
  const content = Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : [];
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  let structured: unknown = r.structuredContent ?? null;
  if (structured === null && text !== "") {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = null;
    }
  }
  return { isError: r.isError === true, structured, text };
}
