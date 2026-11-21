/**
 * A scripted ACP agent: a small stdio process for the integration tests and the end-to-end run.
 *
 * It behaves like the real ones where it matters to draft: it reaches Kiro Remote through the MCP
 * server it is given in `session/new` (over HTTP, with the bearer header it was handed), streams
 * its answer as `agent_message_chunk`s, announces a tool as a `tool_call`, asks with
 * `session/request_permission` before a call that needs it, and reports the result as a
 * `tool_call_update`. It can also start the way the real agents do (Kiro with its autopilot on,
 * Claude in "auto" mode), where a call runs without asking, and misbehave on purpose.
 *
 * Run with `node fake-acp-agent.ts`. The script comes from the file named by FAKE_ACP_SCRIPT.
 * FAKE_ACP_LOG names a JSON Lines file where it records what it received, for the tests to read.
 * Only erasable TypeScript syntax is used, so Node runs it as it is.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Step =
  | { text: string; chunk?: number; delayMs?: number; messageId?: string }
  | {
      /** A Kiro Remote tool to call through the MCP server given in session/new. */
      tool: string;
      input?: Record<string, unknown>;
      /** Whether the agent asks first. Default: only for tools that aren't read-only. */
      ask?: boolean;
    }
  | {
      /** A call that runs without asking, whatever the tool: the misbehaviour draft must catch. */
      unasked: string;
      input?: Record<string, unknown>;
      kind?: string;
    }
  | { builtin: string; kind: string; input?: Record<string, unknown>; ask?: boolean };

interface Script {
  agent?: {
    name?: string;
    /** Omit to report no agentInfo, as kiro-cli does. */
    version?: string | null;
    model?: string;
    /** Whether it advertises HTTP MCP servers. Default true. */
    http?: boolean;
  };
  /** How the agent starts: with the risky defaults of the real ones, or already asking. */
  starts?: "kiro" | "claude" | "asking";
  /** Which identity fields tool calls carry. */
  style?: "kiro" | "claude";
  turns: { match?: string; steps: Step[] }[];
  fallback?: string;
  /** What the prompt response reports for usage; null reports nothing. */
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number } | null;
  /** Kiro-style metering after each turn. */
  credits?: number;
  /** Ignores requests to change its configuration or mode: it keeps running without asking. */
  stubborn?: boolean;
  /** Exit the process during a prompt, after this many chunks of text. */
  crashAfterChunks?: number;
}

const scriptPath = process.env.FAKE_ACP_SCRIPT;
const script: Script = scriptPath
  ? (JSON.parse(readFileSync(scriptPath, "utf8")) as Script)
  : { turns: [] };
const logPath = process.env.FAKE_ACP_LOG;
const record = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

const READ_ONLY = new Set([
  "kiro_capabilities",
  "kiro_list_models",
  "kiro_list_sessions",
  "kiro_get_session",
  "kiro_wait_for_events",
  "kiro_get_transcript",
  "kiro_list_permissions",
]);

interface SessionState {
  id: string;
  /** The working directory the client gave in session/new; `{cwd}` in a reply says it. */
  cwd: string;
  mcp: acp.McpServer | undefined;
  mcpClient: Client | null;
  autopilot: "on" | "off";
  mode: string;
  cancelled: boolean;
  used: Set<number>;
  calls: number;
}

const sessions = new Map<string, SessionState>();
let sessionCount = 0;
let chunksSent = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const startsKiro = script.starts === "kiro";
const startsClaude = script.starts === "claude";

function configOptions(s: SessionState) {
  const opts: Record<string, unknown>[] = [];
  if (script.agent?.model !== undefined) {
    opts.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: script.agent.model,
      options: [{ value: script.agent.model, name: script.agent.model }],
    });
  }
  if (startsKiro) {
    opts.push({
      id: "autopilot",
      name: "Autopilot",
      type: "select",
      currentValue: s.autopilot,
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    });
  }
  if (startsClaude) {
    opts.push({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: s.mode,
      options: ["default", "acceptEdits", "plan", "auto"].map((v) => ({ value: v, name: v })),
    });
  }
  return opts;
}

/** Does the next call run without asking, because the session starts in a risky state? */
function runsWithoutAsking(s: SessionState): boolean {
  return (startsKiro && s.autopilot === "on") || (startsClaude && s.mode === "auto");
}

async function mcp(s: SessionState): Promise<Client> {
  if (s.mcpClient !== null) return s.mcpClient;
  const server = s.mcp;
  if (server === undefined || !("url" in server)) throw new Error("no HTTP MCP server was given");
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
  const client = new Client({ name: "fake-acp-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
  );
  s.mcpClient = client;
  return client;
}

function identityMeta(name: string, server = "kiro-remote") {
  return script.style === "claude"
    ? { claudeCode: { toolName: `mcp__${server}__${name}` } }
    : {
        kiro: {
          mcpTool: { version: 1, identity: { serverName: server, toolName: name } },
        },
      };
}

const agentApp = acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    record({ event: "initialize", params });
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false },
        mcpCapabilities: { http: script.agent?.http !== false, sse: false },
        sessionCapabilities: { close: {} },
      },
      ...(script.agent?.version === null
        ? {}
        : {
            agentInfo: {
              name: script.agent?.name ?? "fake-acp-agent",
              version: script.agent?.version ?? "1.0.0",
            },
          }),
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    const s: SessionState = {
      id: `fake-session-${process.pid}-${++sessionCount}`,
      cwd: params.cwd,
      mcp: params.mcpServers[0],
      mcpClient: null,
      autopilot: "on",
      mode: startsClaude ? "auto" : "default",
      cancelled: false,
      used: new Set(),
      calls: 0,
    };
    sessions.set(s.id, s);
    record({ event: "session/new", sessionId: s.id, params });
    return {
      sessionId: s.id,
      configOptions: configOptions(s),
      ...(startsClaude
        ? {
            modes: {
              currentModeId: s.mode,
              availableModes: ["default", "acceptEdits", "plan", "auto"].map((id) => ({
                id,
                name: id,
              })),
            },
          }
        : {}),
    } as acp.NewSessionResponse;
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
    const p = params as { sessionId: string; configId: string; value: string };
    const s = sessions.get(p.sessionId);
    record({ event: "session/set_config_option", ...p });
    if (s !== undefined && script.stubborn !== true) {
      if (p.configId === "autopilot") s.autopilot = p.value as "on" | "off";
      if (p.configId === "mode") s.mode = p.value;
    }
    return { configOptions: s === undefined ? [] : configOptions(s) } as never;
  })
  .onRequest(acp.methods.agent.session.setMode, async ({ params }) => {
    record({ event: "session/set_mode", ...params });
    const s = sessions.get(params.sessionId);
    if (s !== undefined && script.stubborn !== true) s.mode = params.modeId;
  })
  .onRequest(acp.methods.agent.session.close, async ({ params }) => {
    record({ event: "session/close", sessionId: params.sessionId });
    const s = sessions.get(params.sessionId);
    await s?.mcpClient?.close().catch(() => {});
    sessions.delete(params.sessionId);
  })
  .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    record({ event: "session/cancel", sessionId: params.sessionId });
    const s = sessions.get(params.sessionId);
    if (s !== undefined) s.cancelled = true;
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    if (s === undefined) throw acp.RequestError.sessionNotFound(params.sessionId);
    s.cancelled = false;
    const blocks = params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`));
    record({ event: "session/prompt", sessionId: s.id, blocks });
    const userText = blocks.at(-1) ?? "";
    const index = script.turns.findIndex(
      (t, i) =>
        !s.used.has(i) && (t.match === undefined || new RegExp(t.match, "i").test(userText)),
    );
    const steps: Step[] =
      index === -1
        ? [{ text: script.fallback ?? "I have nothing scripted for that." }]
        : (script.turns[index]?.steps ?? []);
    if (index !== -1) s.used.add(index);

    const update = (u: Record<string, unknown>) =>
      client.notify(acp.methods.client.session.update, {
        sessionId: s.id,
        update: u,
      } as acp.SessionNotification);

    let messageId = `msg-${s.calls}-0`;
    for (const step of steps) {
      if (s.cancelled) break;
      if ("text" in step) {
        const size = step.chunk ?? 6;
        messageId = step.messageId ?? `msg-${++s.calls}`;
        const text = step.text.replaceAll("{cwd}", s.cwd);
        for (let i = 0; i < text.length; i += size) {
          if (s.cancelled) break;
          await sleep(step.delayMs ?? 15);
          await update({
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text: text.slice(i, i + size) },
          });
          chunksSent++;
          if (script.crashAfterChunks !== undefined && chunksSent >= script.crashAfterChunks)
            process.exit(3);
        }
        continue;
      }
      const toolCallId = `call-${s.id}-${++s.calls}`;
      const isMcp = "tool" in step || "unasked" in step;
      const tool = "tool" in step ? step.tool : "unasked" in step ? step.unasked : step.builtin;
      const input = step.input ?? {};
      const kind =
        "builtin" in step
          ? step.kind
          : "unasked" in step
            ? (step.kind ?? "other")
            : READ_ONLY.has(tool)
              ? "read"
              : "other";
      await update({
        sessionUpdate: "tool_call",
        toolCallId,
        title: isMcp ? `@kiro-remote/${tool}` : tool,
        kind,
        status: "pending",
        rawInput: input,
        ...(isMcp ? { name: tool, _meta: identityMeta(tool) } : { name: tool }),
      });

      let asks: boolean;
      if ("unasked" in step) asks = false;
      else if (runsWithoutAsking(s)) asks = false;
      else if (step.ask !== undefined) asks = step.ask;
      else asks = !(isMcp && READ_ONLY.has(tool));

      if (asks) {
        const r: acp.RequestPermissionResponse = await client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId: s.id,
            toolCall: {
              toolCallId,
              title: isMcp ? `@kiro-remote/${tool}` : tool,
              kind,
              status: "pending",
              rawInput: input,
              ...(isMcp ? { _meta: identityMeta(tool) } : {}),
            },
            options: [
              { optionId: "accept", name: "Allow", kind: "allow_once" },
              { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
              { optionId: "reject", name: "Deny", kind: "reject_once" },
              { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
            ],
            ...(script.style === "kiro" || script.style === undefined
              ? {
                  _meta: {
                    kiro: { consent: { capability: isMcp ? "mcp" : "shell", resource: tool } },
                  },
                }
              : {}),
          },
        );
        record({ event: "permission", toolCallId, tool, outcome: r.outcome });
        const allowed = r.outcome.outcome === "selected" && r.outcome.optionId === "accept";
        if (!allowed) {
          await update({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Denied." } }],
          });
          continue;
        }
      }

      await update({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
      record({ event: "tool-ran", tool, input, toolCallId, asked: asks });
      if (!isMcp) {
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "done" } }],
        });
        continue;
      }
      try {
        const client2 = await mcp(s);
        const result = (await client2.callTool({ name: tool, arguments: input })) as {
          content?: { type: string; text?: string }[];
          isError?: boolean;
        };
        const text = (result.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: result.isError === true ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text } }],
        });
      } catch (err) {
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          content: [
            {
              type: "content",
              content: { type: "text", text: err instanceof Error ? err.message : String(err) },
            },
          ],
        });
      }
    }

    if (script.credits !== undefined) {
      await update({
        sessionUpdate: "session_info_update",
        _meta: {
          kiro: {
            kind: "turn_completion",
            promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: script.credits }],
          },
        },
      });
    }
    return {
      stopReason: s.cancelled ? "cancelled" : "end_turn",
      ...(script.usage ? { usage: script.usage } : {}),
    } as acp.PromptResponse;
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = agentApp.connect(stream);
await connection.closed;
process.exit(0);
