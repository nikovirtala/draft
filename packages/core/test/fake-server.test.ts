import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpKiroRemoteTools } from "../src/kiro-client.ts";
import { KiroOAuth, MemorySecretStore } from "../src/oauth.ts";
import { KiroSessionResolver } from "../src/resolver.ts";
import { FakeKiroRemote, KIRO_REMOTE_TOOLS } from "../src/testing/index.ts";
import { RUNNING, WAITING } from "./fixtures.ts";

let server: FakeKiroRemote | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

/** A "browser" that follows the authorize redirect to the loopback listener, as a user signing in would. */
const autoBrowser = async (url: string) => {
  const r = await fetch(url, { redirect: "manual" });
  const location = r.headers.get("location");
  if (location === null) throw new Error(`authorize answered ${r.status}`);
  await fetch(location);
};

describe("the fake Kiro Remote", () => {
  it("serves kiro-remote's real tool list over MCP", async () => {
    server = await new FakeKiroRemote().start();
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(KIRO_REMOTE_TOOLS.map((t) => t.name));
    expect(tools.find((t) => t.name === "kiro_launch_session")?.inputSchema.required).toEqual([
      "prompt",
      "repos",
    ]);
    await client.close();
  });

  it("checks tool inputs against the real schemas", async () => {
    server = await new FakeKiroRemote().start();
    const tools = new McpKiroRemoteTools({ url: server.mcpUrl });
    const bad = await tools.call("kiro_launch_session", { prompt: "x", repos: ["not a repo"] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/invalid input/);
    await tools.close();
  });

  it("runs the OAuth 2.1 PKCE sign-in, then answers with the bearer token", async () => {
    server = await new FakeKiroRemote({
      auth: true,
      sessions: [
        { id: RUNNING, title: "Fix the build", status: "running" },
        {
          id: WAITING,
          title: "Write the docs",
          status: "awaiting_permission",
          pendingPermissions: 1,
        },
      ],
    }).start();
    const store = new MemorySecretStore();
    let opened = 0;
    const oauth = new KiroOAuth({
      serverUrl: server.mcpUrl,
      store,
      openBrowser: async (u) => {
        opened++;
        expect(new URL(u).searchParams.get("code_challenge_method")).toBe("S256");
        await autoBrowser(u);
      },
    });
    const unauthorized = new McpKiroRemoteTools({ url: server.mcpUrl });
    await expect(unauthorized.call("kiro_list_sessions", {})).rejects.toThrow();

    const token = await oauth.accessToken();
    expect(token).toMatch(/^fake-access-/);
    expect(opened).toBe(1);
    // Fresh tokens are reused without another sign-in or refresh.
    expect(await oauth.accessToken()).toBe(token);
    expect(opened).toBe(1);

    const tools = new McpKiroRemoteTools({ url: server.mcpUrl, authProvider: oauth });
    const state = await new KiroSessionResolver(tools).fetch(WAITING);
    expect(state).toMatchObject({ status: "awaiting_permission", pendingPermissions: 1 });
    expect(server.calls.every((c) => c.authorized)).toBe(true);
    // Stored secrets are tokens and the client registration only.
    expect(JSON.parse([...store.values.values()][0] as string)).toMatchObject({
      client: { client_id: expect.stringMatching(/^mcp_/) },
      tokens: { token_type: "Bearer" },
    });
    await tools.close();
  });

  it("refreshes an expiring token without the browser", async () => {
    server = await new FakeKiroRemote({ auth: true, tokenTtlSeconds: 30 }).start();
    let opened = 0;
    const oauth = new KiroOAuth({
      serverUrl: server.mcpUrl,
      store: new MemorySecretStore(),
      openBrowser: async (u) => {
        opened++;
        await autoBrowser(u);
      },
    });
    const first = await oauth.accessToken();
    const second = await oauth.accessToken();
    expect(second).not.toBe(first);
    expect(opened).toBe(1);
  });
});
