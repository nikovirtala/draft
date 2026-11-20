import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTurnHooks,
  type AgentTurnInput,
  decideTool,
  KIRO_MUTATING_TOOLS,
  KIRO_READ_ONLY_TOOLS,
  KIRO_SERVER,
  sdkToolName,
} from "@nikovirtala/draft-core";

const requireHere = createRequire(import.meta.url);
/** The SDK's entry file; its package.json sits next to it (the package exports no ./package.json). */
const SDK_ENTRY = requireHere.resolve("@anthropic-ai/claude-agent-sdk");
const SDK_VERSION = (
  JSON.parse(readFileSync(join(dirname(SDK_ENTRY), "package.json"), "utf8")) as { version: string }
).version;

export const SYSTEM_PROMPT = `You are the agent inside draft, a desktop app where everything folds around one conversation.
You help the user supervise Kiro cloud sessions through the Kiro Remote tools.
- Read-only tools (list, get, wait for events, transcript, list permissions) run at once.
- Tools that change things (launch, send a prompt, answer a permission, cancel, delete) ask the user first; the user answers in the conversation.
- When you mention a Kiro session, write its full session id: draft shows every session id it finds as a live status stub.
- Keep answers short and plain.`;

export interface KiroMcp {
  /** The Kiro Remote MCP endpoint, `<base>/mcp`. */
  url: string;
  /** A current bearer token, or null when Kiro Remote runs without sign-in. */
  token(): Promise<string | null>;
}

export interface ClaudeRuntimeOptions {
  model: string;
  /** The Anthropic API key. Only ever passed in the Claude Code process environment. */
  apiKey: string | undefined;
  kiro: KiroMcp | null;
  /** In a packaged app, the Claude Code binary unpacked from the asar archive. */
  executable?: string;
  /** For tests: replaces the SDK's query(). */
  queryFn?: typeof query;
  cwd?: string;
}

/** A queue the SDK reads the conversation's user messages from (streaming input mode). */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.waiting !== null) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: m, done: false });
    } else this.items.push(m);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m !== undefined) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

interface Session {
  queue: MessageQueue;
  q: Query;
  iterator: AsyncIterator<SDKMessage>;
  hooks: AgentTurnHooks | null;
  decisions: Map<string, NonNullable<Extract<AgentEvent, { type: "tool-result" }>["decision"]>>;
  token: string | null;
}

/** Turns SDK messages of one turn into draft's agent events. Pure, so it is unit-tested. */
export class TurnMapper {
  private text = "";
  private call = 0;
  private currentCall: string | null = null;
  private callInput = 0;
  private needsBreak = false;
  claudeCodeVersion: string | null = null;

  constructor(
    private readonly decisions: Map<
      string,
      NonNullable<Extract<AgentEvent, { type: "tool-result" }>["decision"]>
    >,
  ) {}

  map(m: SDKMessage): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (m.type) {
      case "system":
        if (m.subtype === "init") this.claudeCodeVersion = m.claude_code_version;
        break;
      case "stream_event": {
        if (m.parent_tool_use_id !== null) break;
        const ev = m.event;
        if (ev.type === "message_start") {
          this.currentCall = `call-${++this.call}`;
          const u = ev.message.usage;
          this.callInput =
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          out.push({ type: "model-call-start", callId: this.currentCall });
        } else if (ev.type === "content_block_start" && ev.content_block.type === "text") {
          this.needsBreak = this.text !== "";
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          const piece = (this.needsBreak ? "\n\n" : "") + ev.delta.text;
          this.needsBreak = false;
          this.text += piece;
          out.push({ type: "text-delta", text: piece });
        } else if (ev.type === "message_delta" && this.currentCall !== null) {
          out.push({
            type: "model-call-end",
            callId: this.currentCall,
            inputTokens: this.callInput,
            outputTokens: ev.usage.output_tokens ?? 0,
          });
          this.currentCall = null;
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id !== null) break;
        for (const block of m.message.content) {
          if (block.type === "tool_use" || block.type === "mcp_tool_use") {
            const b = block as { id: string; name: string; input: unknown; server_name?: string };
            out.push({
              type: "tool-call",
              toolUseId: b.id,
              name: b.name,
              input: (b.input ?? {}) as Record<string, unknown>,
              decision: "allowed-read-only",
            });
          }
        }
        break;
      }
      case "user": {
        const content = m.message.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (typeof block !== "object" || block === null || block.type !== "tool_result") continue;
          const b = block as { tool_use_id: string; is_error?: boolean; content?: unknown };
          const text =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as { type: string; text?: string }[])
                    .filter((c) => c.type === "text")
                    .map((c) => c.text ?? "")
                    .join("\n")
                : "";
          let structured: unknown = null;
          try {
            structured = JSON.parse(text);
          } catch {
            structured = null;
          }
          const decision = this.decisions.get(b.tool_use_id);
          out.push({
            type: "tool-result",
            toolUseId: b.tool_use_id,
            isError: b.is_error === true,
            text,
            structured,
            ...(decision === undefined ? {} : { decision }),
          });
        }
        break;
      }
      case "result": {
        const u = m.usage;
        const input =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        if (m.subtype !== "success" || m.is_error) {
          const reason =
            m.subtype === "success" ? String(m.result ?? "the agent failed") : m.subtype;
          out.push({ type: "error", message: reason });
        }
        const final =
          this.text !== ""
            ? this.text
            : m.subtype === "success" && !m.is_error
              ? String(m.result ?? "")
              : "";
        out.push({
          type: "done",
          text: final,
          inputTokens: input,
          outputTokens: u.output_tokens ?? 0,
          model: "",
        });
        break;
      }
      default:
        break;
    }
    return out;
  }
}

/**
 * The agent on the Claude Agent SDK. It runs in the main process: the SDK spawns the Claude Code
 * binary as a child process, so the main process only relays messages, and the API key stays in
 * that child's environment. One SDK session per conversation, in streaming input mode.
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  readonly model: string;
  private readonly sessions = new Map<string, Session>();
  private ccVersion: string | null = null;

  constructor(private readonly o: ClaudeRuntimeOptions) {
    this.model = o.model;
  }

  get version(): string {
    return `agent-sdk ${SDK_VERSION}${this.ccVersion === null ? "" : ` / claude-code ${this.ccVersion}`}`;
  }

  private async session(input: AgentTurnInput): Promise<Session> {
    const token = this.o.kiro === null ? null : await this.o.kiro.token();
    const existing = this.sessions.get(input.conversation);
    // A refreshed token means new MCP headers, so the session starts again from the log's history.
    if (existing !== undefined && existing.token === token) return existing;
    if (existing !== undefined) this.closeConversation(input.conversation);

    const queue = new MessageQueue();
    const decisions: Session["decisions"] = new Map();
    const session: Partial<Session> = { queue, hooks: null, decisions, token };
    const canUseTool: CanUseTool = async (name, toolInput, opts): Promise<PermissionResult> => {
      const hooks = session.hooks;
      if (hooks === null || hooks === undefined)
        return { behavior: "deny", message: "No turn is running." };
      const { answer, decision } = await decideTool(name, toolInput, opts.toolUseID, hooks);
      decisions.set(opts.toolUseID, decision);
      return answer.allow
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: answer.message };
    };
    const mcpServers: Record<string, McpServerConfig> = {};
    if (this.o.kiro !== null) {
      mcpServers[KIRO_SERVER] = {
        type: "http",
        url: this.o.kiro.url,
        ...(token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
        tools: [
          ...KIRO_READ_ONLY_TOOLS.map((name) => ({
            name,
            permission_policy: "always_allow" as const,
          })),
          ...KIRO_MUTATING_TOOLS.map((name) => ({
            name,
            permission_policy: "always_ask" as const,
          })),
        ],
      };
    }
    const history =
      input.history.length === 0
        ? ""
        : `\n\nThe conversation so far, from draft's log:\n${input.history
            .map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`)
            .join("\n\n")}`;
    const options: Options = {
      model: this.o.model,
      includePartialMessages: true,
      // No built-in Claude Code tools in this slice: only Kiro Remote's.
      tools: [],
      allowedTools: KIRO_READ_ONLY_TOOLS.map(sdkToolName),
      canUseTool,
      mcpServers,
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      systemPrompt: SYSTEM_PROMPT + history,
      cwd: this.o.cwd ?? process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(this.o.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: this.o.apiKey }),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      ...(this.o.executable === undefined ? {} : { pathToClaudeCodeExecutable: this.o.executable }),
    };
    const q = (this.o.queryFn ?? query)({ prompt: queue, options });
    Object.assign(session, { q, iterator: q[Symbol.asyncIterator]() });
    this.sessions.set(input.conversation, session as Session);
    return session as Session;
  }

  async *runTurn(input: AgentTurnInput, hooks: AgentTurnHooks): AsyncIterable<AgentEvent> {
    let s: Session;
    try {
      s = await this.session(input);
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done", text: "", inputTokens: 0, outputTokens: 0, model: this.model };
      return;
    }
    s.hooks = hooks;
    s.decisions.clear();
    const mapper = new TurnMapper(s.decisions);
    s.queue.push({
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    } as SDKUserMessage);
    try {
      while (true) {
        const next = await s.iterator.next();
        if (next.done === true) {
          this.sessions.delete(input.conversation);
          yield { type: "error", message: "the agent session ended" };
          yield { type: "done", text: "", inputTokens: 0, outputTokens: 0, model: this.model };
          return;
        }
        const events = mapper.map(next.value);
        if (mapper.claudeCodeVersion !== null) this.ccVersion = mapper.claudeCodeVersion;
        for (const e of events) {
          yield e.type === "done" ? { ...e, model: this.model } : e;
          if (e.type === "done") return;
        }
      }
    } catch (err) {
      this.closeConversation(input.conversation);
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done", text: "", inputTokens: 0, outputTokens: 0, model: this.model };
    } finally {
      s.hooks = null;
    }
  }

  closeConversation(conversation: string): void {
    const s = this.sessions.get(conversation);
    if (s === undefined) return;
    this.sessions.delete(conversation);
    s.queue.close();
    s.q.close();
  }

  async close(): Promise<void> {
    for (const c of [...this.sessions.keys()]) this.closeConversation(c);
  }
}

/**
 * The Claude Code binary of a packaged app. The SDK resolves its platform package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`) itself, but inside an asar archive the
 * binary can't be executed, so packaging unpacks it and this points at the unpacked copy.
 */
export function packagedClaudeExecutable(isPackaged: boolean): string | undefined {
  if (!isPackaged) return undefined;
  const musl =
    process.platform === "linux" &&
    !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header
      ?.glibcVersionRuntime;
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
  try {
    // The platform package is the SDK's dependency, so it resolves from the SDK's own location.
    const dir = dirname(createRequire(SDK_ENTRY).resolve(`${pkg}/package.json`));
    return join(dir, process.platform === "win32" ? "claude.exe" : "claude").replace(
      `${"app.asar"}${process.platform === "win32" ? "\\" : "/"}`,
      `app.asar.unpacked${process.platform === "win32" ? "\\" : "/"}`,
    );
  } catch {
    return undefined;
  }
}
