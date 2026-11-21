import { join } from "node:path";
import { FakeAgentRuntime, type FakeScript } from "../src/agent.ts";
import { ConversationService } from "../src/conversation.ts";
import type { KiroRemoteTools } from "../src/kiro.ts";
import { FileLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { KiroSessionResolver } from "../src/resolver.ts";
import { FakeKiroRemote } from "../src/testing/index.ts";
import { USER } from "./helpers.ts";

export const RUNNING = "01KAHX7Z1M2N3P4Q5R6S7T8V9W";
export const WAITING = "01KAHX8A1B2C3D4E5F6G7H8J9K";

export const SCRIPT: FakeScript = {
  turns: [
    {
      match: "sessions",
      steps: [
        { text: "Let me look.", delayMs: 0 },
        { tool: "kiro_list_sessions", input: { limit: 20 } },
        {
          text: `Two sessions are open: ${RUNNING} is running and ${WAITING} is waiting for your permission.`,
          delayMs: 0,
        },
      ],
    },
    {
      match: "launch",
      steps: [
        {
          tool: "kiro_launch_session",
          input: { prompt: "Fix the flaky test", repos: ["nikovirtala/draft"] },
        },
        { text: "Done.", delayMs: 0 },
      ],
    },
  ],
  fallback: "Nothing scripted.",
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

export async function openService(
  dir: string,
  kiro: FakeKiroRemote,
  script: FakeScript = SCRIPT,
  tools: KiroRemoteTools = kiro.asTools(),
) {
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const agent = new FakeAgentRuntime(script, tools, { model: "claude-opus-5-5" });
  const service = await ConversationService.open({
    log,
    projection,
    agent,
    resolvers: [new KiroSessionResolver(tools)],
    user: USER,
    // What the person's own answers and retries call: never the agent's tools.
    actions: kiro.asTools(),
    poller: { baseMs: 0 },
  });
  return {
    service,
    agent,
    log,
    projection,
    close: () => {
      log.close();
      projection.close();
    },
  };
}
