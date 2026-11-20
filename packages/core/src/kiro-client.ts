import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { KiroRemoteTools, ToolCallResult } from "./kiro.ts";
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

  async call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const client = await this.connect();
    try {
      const r = await client.callTool({ name: tool, arguments: args });
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
