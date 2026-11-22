import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationService,
  FileLogStore,
  KiroSessionResolver,
  knownEvents,
  Projection,
} from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { resolveAgent } from "../src/main/acp/agents.ts";
import { AcpRuntime } from "../src/main/acp/runtime.ts";
import { autoAnswer, fakeKiro, USER } from "./acp-helpers.ts";

/**
 * One real turn against a real agent, kept out of the normal run: it needs the agent installed
 * and signed in, and it spends real usage. Run with DRAFT_REAL_AGENT=kiro (or claude) and
 * DRAFT_REAL_OUT=<dir> for the transcript. Kiro Remote is the fake one, over HTTP.
 */
const which = process.env.DRAFT_REAL_AGENT;

describe.skipIf(which === undefined)(`a real turn on ${which}`, () => {
  it("lists sessions, then launches one only after the person allows it", {
    timeout: 240_000,
  }, async () => {
    const out = process.env.DRAFT_REAL_OUT ?? mkdtempSync(join(tmpdir(), "draft-real-"));
    const kiro = await fakeKiro().start();
    const log = FileLogStore.open(join(out, "log.jsonl"));
    const projection = Projection.open(":memory:");
    const runtime = new AcpRuntime({
      spec: resolveAgent({ agent: which as string, agents: {} }),
      cwd: join(out, "agent-workspace"),
      env: process.env,
      dataDir: out,
      clientInfo: { name: "draft", version: "0.0.0-real" },
      kiro: { url: kiro.mcpUrl, baseUrl: kiro.baseUrl, token: async () => "real-turn-token" },
      transcript: join(out, "acp-transcript.jsonl"),
    });
    const service = await ConversationService.open({
      log,
      projection,
      agent: runtime,
      resolvers: [new KiroSessionResolver(kiro.asTools())],
      user: USER,
      poller: { baseMs: 0 },
    });
    try {
      autoAnswer(service);
      await service.submit(
        "Use the kiro-remote tools to list my Kiro sessions, then tell me how many there are.",
      );
      await service.submit(
        'Launch one Kiro session with the kiro-remote tool kiro_launch_session: repos ["nikovirtala/draft"], prompt "Say hello", title "Hello from draft". Then say done.',
      );
      const types = knownEvents(log.events()).map((e) => e.type);
      console.log(
        JSON.stringify({
          types,
          state: service.state().agent,
          error: service.state().error,
          calls: kiro.calls.map((c) => c.tool),
        }),
      );
      expect(service.state().error).toBeNull();
      expect(types).toContain("step.started");
      expect(types).not.toContain("agent.anomaly");
    } finally {
      await runtime.close();
      log.close();
      await kiro.stop();
    }
  });
});
