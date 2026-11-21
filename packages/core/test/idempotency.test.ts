import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeScript } from "../src/agent.ts";
import type { DraftEvent } from "../src/events.ts";
import { knownEvents } from "../src/events.ts";
import { advertisesIdempotencyKey, withIdempotencyKey } from "../src/kiro.ts";
import { McpKiroRemoteTools } from "../src/kiro-client.ts";
import { FakeKiroRemote, KIRO_REMOTE_TOOLS } from "../src/testing/index.ts";
import { openService } from "./fixtures.ts";

/**
 * Each step's idempotency key goes to Kiro Remote's tools that change something, and only to a
 * tool whose input schema advertises `idempotencyKey`: the deployed Kiro Remote may not have it yet
 * (nikovirtala/kiro-remote 9be84d2 added it).
 */

const LAUNCH = { prompt: "Fix the flaky test", repos: ["nikovirtala/draft"], title: "Fix it" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function over(idempotency: boolean) {
  const kiro = await new FakeKiroRemote({ sessions: [], idempotency }).start();
  const client = new McpKiroRemoteTools({ url: kiro.mcpUrl });
  cleanup.push(async () => {
    await client.close();
    await kiro.stop();
  });
  return { kiro, client };
}

describe("which tools advertise a key", () => {
  it("reads it from the input schema's properties", () => {
    expect(advertisesIdempotencyKey({ properties: { idempotencyKey: { type: "string" } } })).toBe(
      true,
    );
    expect(advertisesIdempotencyKey({ properties: { prompt: {} } })).toBe(false);
    expect(advertisesIdempotencyKey({})).toBe(false);
    expect(advertisesIdempotencyKey(undefined)).toBe(false);
    expect(withIdempotencyKey({ properties: { prompt: {} } }, { a: 1 }, "k")).toEqual({ a: 1 });
    expect(withIdempotencyKey({ properties: { idempotencyKey: {} } }, { a: 1 }, "k")).toEqual({
      a: 1,
      idempotencyKey: "k",
    });
    expect(withIdempotencyKey({ properties: { idempotencyKey: {} } }, { a: 1 }, undefined)).toEqual(
      {
        a: 1,
      },
    );
  });

  it("is what the captured tool list lacks, and what the fake adds to tools that change things", async () => {
    expect(KIRO_REMOTE_TOOLS.some((t) => advertisesIdempotencyKey(t.inputSchema))).toBe(false);
    const withKeys = new FakeKiroRemote({ idempotency: true }).tools();
    expect(
      withKeys
        .filter((t) => advertisesIdempotencyKey(t.inputSchema))
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "kiro_adopt_session",
      "kiro_answer_permission",
      "kiro_cancel_turn",
      "kiro_delete_session",
      "kiro_launch_session",
      "kiro_link_pull_request",
      "kiro_send_prompt",
      "kiro_set_config",
      "kiro_unlink_pull_request",
    ]);
  });
});

describe("a Kiro Remote whose tools advertise idempotencyKey", () => {
  it("returns the first result for a repeated call with the same key, and runs once", async () => {
    const { kiro, client } = await over(true);
    const a = await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "step-1" });
    const b = await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "step-1" });
    expect(a.isError).toBe(false);
    expect(b.structured).toEqual(a.structured);
    expect(kiro.sessions.size).toBe(1);
    expect(kiro.executed.filter((c) => c.tool === "kiro_launch_session")).toHaveLength(1);
    // Both calls carried the key.
    expect(kiro.calls.map((c) => c.args.idempotencyKey)).toEqual(["step-1", "step-1"]);
    // A new key is a new call.
    const c = await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "step-2" });
    expect(c.structured).not.toEqual(a.structured);
    expect(kiro.sessions.size).toBe(2);
  });

  it("refuses the same key with different input", async () => {
    const { client } = await over(true);
    await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "step-1" });
    const r = await client.call(
      "kiro_launch_session",
      { ...LAUNCH, prompt: "Something else" },
      { idempotencyKey: "step-1" },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/different request/);
  });

  it("sends no key to a tool that doesn't advertise one, or when there is none", async () => {
    const { kiro, client } = await over(true);
    await client.call("kiro_list_sessions", {}, { idempotencyKey: "step-1" });
    await client.call("kiro_launch_session", LAUNCH);
    expect(kiro.calls.map((c) => [c.tool, "idempotencyKey" in c.args])).toEqual([
      ["kiro_list_sessions", false],
      ["kiro_launch_session", false],
    ]);
  });
});

describe("a Kiro Remote deployed before the key existed", () => {
  it("is sent no key, and nothing breaks: a repeated call is a repeated call", async () => {
    const { kiro, client } = await over(false);
    const a = await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "step-1" });
    const b = await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "step-1" });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(kiro.calls.every((c) => !("idempotencyKey" in c.args))).toBe(true);
    // No dedupe was promised, so there are two sessions.
    expect(kiro.sessions.size).toBe(2);
  });

  it("reads the schemas once per connection, however many calls follow", async () => {
    const { kiro, client } = await over(false);
    let listed = 0;
    const original = kiro.tools.bind(kiro);
    kiro.tools = () => {
      listed++;
      return original();
    };
    await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "a" });
    await client.call("kiro_launch_session", LAUNCH, { idempotencyKey: "b" });
    expect(listed).toBe(1);
  });
});

describe("a step's key reaches the tool", () => {
  const script: FakeScript = {
    turns: [{ match: "go", steps: [{ tool: "kiro_launch_session", input: LAUNCH }] }],
    fallback: "",
  };

  const run = async (idempotency: boolean) => {
    const kiro = new FakeKiroRemote({ sessions: [], idempotency });
    const opened = await openService(mkdtempSync(join(tmpdir(), "draft-idem-")), kiro, script);
    cleanup.push(async () => opened.close());
    opened.service.onChange((c) => {
      if (c.type !== "state") return;
      for (const p of c.state.prompts)
        queueMicrotask(() => opened.service.answerPrompt(p.id, true));
    });
    await opened.service.submit("go");
    const started = knownEvents(opened.log.events()).find(
      (e) => e.type === "step.started",
    ) as DraftEvent<"step.started">;
    return { kiro, started };
  };

  it("sends the step's own key when the schema advertises one", async () => {
    const { kiro, started } = await run(true);
    const launches = kiro.calls.filter((c) => c.tool === "kiro_launch_session");
    expect(launches.map((c) => c.args.idempotencyKey)).toEqual([started.data.idempotencyKey]);
  });

  it("sends none when it doesn't, and the step still records its key", async () => {
    const { kiro, started } = await run(false);
    expect(kiro.calls.every((c) => !("idempotencyKey" in c.args))).toBe(true);
    expect(started.data.idempotencyKey).toMatch(/\S/);
  });
});
