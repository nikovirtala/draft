import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentEvent,
  type AgentTurnHooks,
  buildAgentContext,
  ConversationService,
  FileLogStore,
  KiroSessionResolver,
  Projection,
} from "@nikovirtala/draft-core";
import { FakeKiroRemote } from "@nikovirtala/draft-core/testing";
import type { AgentKind, AgentSpec } from "../src/main/acp/agents.ts";
import { AcpRuntime } from "../src/main/acp/runtime.ts";

export const RUNNING = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
export const WAITING = "01KAHX8A1B2C3D4E5F6G7H8J9K";
export const USER = { kind: "user", id: "01kahx0000000000000000user", name: "Test User" } as const;
export const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), "fake-acp-agent.ts");

export const LAUNCH = {
  prompt: "Update the README",
  repos: ["nikovirtala/draft"],
  title: "Update the README",
};

export function fakeKiro() {
  return new FakeKiroRemote({
    sessions: [
      { id: RUNNING, title: "Fix the build", status: "running" },
      {
        id: WAITING,
        title: "Write the docs",
        status: "awaiting_permission",
        pendingPermissions: 1,
      },
    ],
  });
}

export interface Script {
  agent?: { name?: string; version?: string | null; model?: string; http?: boolean };
  starts?: "kiro" | "claude" | "asking";
  style?: "kiro" | "claude";
  turns: { match?: string; steps: Record<string, unknown>[] }[];
  fallback?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number } | null;
  credits?: number;
  stubborn?: boolean;
  crashAfterChunks?: number;
}

export function fakeSpec(
  dir: string,
  script: Script,
  o: { kind?: AgentKind; requires?: AgentSpec["requires"]; command?: string } = {},
): { spec: AgentSpec; logPath: string } {
  const scriptPath = join(dir, "fake-script.json");
  const logPath = join(dir, "fake-agent.jsonl");
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    logPath,
    spec: {
      id: "fake",
      kind: o.kind ?? "generic",
      label: "Fake",
      command: o.command ?? process.execPath,
      args: o.command === undefined ? [FAKE_AGENT] : [],
      env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath },
      requires: o.requires ?? [],
      versionArgs: null,
      signIn: "Sign in to the fake.",
    },
  };
}

/** What the fake agent recorded, in order. */
// biome-ignore lint/suspicious/noExplicitAny: JSON records written by the fake agent, read in assertions
export function recorded(logPath: string): Record<string, any>[] {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export interface Opened {
  dir: string;
  service: ConversationService;
  runtime: AcpRuntime;
  log: FileLogStore;
  projection: Projection;
  kiro: FakeKiroRemote;
  logPath: string;
  close(): Promise<void>;
}

/** A conversation on the fake ACP agent over real stdio, with a fake Kiro Remote behind it. */
export async function openAcp(
  script: Script,
  o: {
    dir?: string;
    kiro?: FakeKiroRemote;
    kind?: AgentKind;
    requires?: AgentSpec["requires"];
    command?: string;
    env?: NodeJS.ProcessEnv;
    token?: () => Promise<string | null>;
  } = {},
): Promise<Opened> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "draft-acp-"));
  const kiro = o.kiro ?? (await fakeKiro().start());
  const { spec, logPath } = fakeSpec(dir, script, o);
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const runtime = new AcpRuntime({
    spec,
    cwd: join(dir, "agent-workspace"),
    env: o.env ?? { PATH: process.env.PATH ?? "" },
    clientInfo: { name: "draft", version: "0.0.0-test" },
    kiro: {
      url: kiro.mcpUrl,
      baseUrl: kiro.baseUrl,
      token: o.token ?? (async () => "test-token-1"),
    },
  });
  const service = await ConversationService.open({
    log,
    projection,
    agent: runtime,
    resolvers: [new KiroSessionResolver(kiro.asTools())],
    user: USER,
    poller: { baseMs: 0 },
  });
  return {
    dir,
    service,
    runtime,
    log,
    projection,
    kiro,
    logPath,
    close: async () => {
      await runtime.close();
      log.close();
      projection.close();
      if (o.kiro === undefined) await kiro.stop();
    },
  };
}

/** Answers every permission prompt of a conversation. */
export function autoAnswer(service: ConversationService, allow = true): void {
  service.onChange((c) => {
    if (c.type !== "state") return;
    for (const p of c.state.prompts) queueMicrotask(() => service.answerPrompt(p.id, allow));
  });
}

/** Hooks that allow or refuse every tool that asks, recording what happened. */
export function recordingHooks(allow = true) {
  const asked: string[] = [];
  const steps: string[] = [];
  const hooks: AgentTurnHooks = {
    confirmTool: async (call) => {
      asked.push(call.name);
      return allow ? { allow: true } : { allow: false, message: "The user declined this action." };
    },
    beginStep: async (call) => {
      steps.push(call.name);
      return { idempotencyKey: `key-${steps.length}` };
    },
  };
  return { hooks, asked, steps };
}

/** Runs one turn of a runtime on its own and collects its events. */
export async function runOnce(
  o: Opened,
  text: string,
  hooks: AgentTurnHooks = recordingHooks().hooks,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const context = buildAgentContext(o.projection, o.service.conversation);
  for await (const e of o.runtime.runTurn(
    { conversation: o.service.conversation, text, context },
    hooks,
  ))
    events.push(e);
  return events;
}
