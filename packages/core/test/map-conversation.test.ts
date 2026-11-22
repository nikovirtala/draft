import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../src/agent.ts";
import { knownEvents } from "../src/events.ts";
import { FileLogStore } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { KiroSessionResolver } from "../src/resolver.ts";
import type { WorkspaceChange } from "../src/workspace.ts";
import { Workspace } from "../src/workspace.ts";
import { fakeKiro, SCRIPT } from "./fixtures.ts";
import { USER } from "./helpers.ts";

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "draft-map-"));
  const kiro = fakeKiro();
  const log = FileLogStore.open(join(dir, "log.jsonl"));
  const projection = Projection.open(join(dir, "views.db"));
  const agent = new FakeAgentRuntime(SCRIPT, kiro.asTools(), { model: "m" });
  const workspace = await Workspace.open({
    log,
    projection,
    agent,
    resolvers: [new KiroSessionResolver(kiro.asTools())],
    user: USER,
    poller: { baseMs: 0 },
  });
  return {
    workspace,
    log,
    agent,
    close: () => {
      log.close();
      projection.close();
    },
  };
}

describe("asking for the map in a sentence", () => {
  it("is for draft: posted for people only, shown as a map block, never run as a turn", async () => {
    const o = await open();
    const main = o.workspace.main;
    await main.submit("Show me the map");
    const messages = knownEvents(o.log.events()).filter((e) => e.type === "message.posted");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ data: { role: "user", audience: { agent: false } } });
    const state = main.state();
    expect(state.busy).toBe(false);
    expect(state.timeline.map((b) => b.kind)).toEqual(["message", "map"]);
    expect(state.timeline[1]).toMatchObject({ kind: "map", id: messages[0]?.address });
    o.close();
  });

  it("stays after a restart, because the block is derived from the message", async () => {
    const o = await open();
    await o.workspace.main.submit("show the map");
    const again = o.workspace.main.state().timeline.filter((b) => b.kind === "map");
    expect(again).toHaveLength(1);
    o.close();
  });

  it("leaves other sentences to the agent", async () => {
    const o = await open();
    await o.workspace.main.submit("what sessions are open?");
    expect(o.workspace.main.state().timeline.some((b) => b.kind === "map")).toBe(false);
    o.close();
  });
});

describe("the workspace's map", () => {
  it("counts what the conversation shows, and tells windows when the log moved", async () => {
    const o = await open();
    const changes: WorkspaceChange[] = [];
    o.workspace.onChange((c) => changes.push(c));
    await o.workspace.main.submit("what sessions are open?");
    const map = o.workspace.map();
    // The two sessions the agent listed are stubs, and they are Kiro sessions.
    const row = map.rows.find((r) => r.kind === "kiro-session");
    expect(row?.total).toBe(2);
    expect(row?.cells.find((c) => c.column === "awaiting_permission")?.waitingOnPerson).toBe(1);
    expect(changes.some((c) => c.type === "map")).toBe(true);
    // The head is what a window compares: it names the log as it is.
    const last = changes.filter((c) => c.type === "map").at(-1);
    expect(last).toMatchObject({ head: o.log.head() });
    o.close();
  });
});
