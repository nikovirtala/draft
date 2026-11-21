import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileLogStore,
  knownEvents,
  Projection,
  readLogRecords,
  Workspace,
} from "@nikovirtala/draft-core";
import { afterEach, describe, expect, it } from "vitest";
import { AcpRuntime } from "../src/main/acp/runtime.ts";
import { loadConfig } from "../src/main/config.ts";
import { describeFolder } from "../src/main/contexts/folder.ts";
import { ContextRegistry } from "../src/main/contexts/registry.ts";
import { ContextRuntime, type RuntimeDeps } from "../src/main/contexts/runtime.ts";
import { FAKE_AGENT, recorded, USER } from "./acp-helpers.ts";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const open: ContextRuntime[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
});

const SCRIPT = {
  agent: { model: "fake-model-1" },
  turns: [{ match: "where", steps: [{ text: "I work in {cwd}", delayMs: 0 }] }],
  fallback: "ok",
};

/** The dependencies of one context, with a fake agent on real stdio that logs to its own file. */
function depsFor(dataDir: string, registry: ContextRegistry, name: string) {
  const script = join(dataDir, `script-${name}.json`);
  const log = join(dataDir, `agent-${name}.jsonl`);
  writeFileSync(script, JSON.stringify(SCRIPT));
  const env = {
    PATH: process.env.PATH ?? "",
    FAKE_ACP_SCRIPT: script,
    FAKE_ACP_LOG: log,
  };
  const config = loadConfig(dataDir, {
    DRAFT_AGENT: "fake",
    DRAFT_AGENT_COMMAND: process.execPath,
    DRAFT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
  });
  const deps: RuntimeDeps = {
    dataDir,
    registry,
    config,
    user: USER,
    resolvers: [],
    actions: null,
    makeAgent: (spec, place) =>
      new AcpRuntime({
        spec,
        cwd: place.cwd,
        placeNote: place.note,
        env,
        clientInfo: { name: "draft", version: "0.0.0-test" },
        kiro: null,
      }),
    launcher: () => ({ recognise: () => null, open: async () => ({ context: "x" }) }),
    crossContext: () => ({ detect: () => [], snapshot: async () => null }),
  };
  return { deps, log };
}

async function start(dataDir: string, registry: ContextRegistry, name: string) {
  const { deps, log } = depsFor(dataDir, registry, name);
  const runtime = await ContextRuntime.start(name, deps);
  open.push(runtime);
  return { runtime, log };
}

const tmp = (what: string) => mkdtempSync(join(tmpdir(), `draft-ctx-${what}-`));

/** What the agent of a context answers when asked where it is, and where its session started. */
async function whereAmI(runtime: ContextRuntime, log: string, conversation?: string) {
  const c = runtime.workspace.conversation(conversation ?? runtime.workspace.mainConversation);
  await c.submit("where are you?");
  const reply =
    c
      .state()
      .messages.filter((m) => m.role === "agent")
      .at(-1)?.text ?? "";
  const sessions = recorded(log).filter((e) => e.event === "session/new");
  return { reply, cwd: sessions.at(-1)?.params.cwd as string, sessions: sessions.length };
}

describe("the local context after the upgrade", () => {
  it("opens the log that was there, unbound to any folder, and leaves its bytes and chain as they were", async () => {
    const data = tmp("upgrade");
    // A log written before contexts existed: the context "local", with a conversation in it.
    const old = FileLogStore.open(join(data, "log.jsonl"));
    const projection = Projection.open(join(data, "views.db"));
    const agent = {
      id: "fake",
      model: "m",
      version: "1",
      async *runTurn() {
        yield { type: "text-delta" as const, text: "Noted." };
        yield { type: "done" as const, text: "Noted.", usage: null, model: "m" };
      },
      closeConversation() {},
      async close() {},
    };
    const w = await Workspace.open({ log: old, projection, agent, resolvers: [], user: USER });
    await w.main.submit("Remember the harbour.");
    const conversation = w.mainConversation;
    await w.close();
    old.close();
    projection.close();
    const logPath = join(data, "log.jsonl");
    const before = { hash: sha(logPath), records: readLogRecords(logPath) };
    expect(before.records.ok).toBe(true);
    const head = before.records.ok ? before.records.events.at(-1)?.hash : null;

    const registry = ContextRegistry.load(data);
    const { runtime, log } = await start(data, registry, "local");
    expect(runtime.workspace.mainConversation).toBe(conversation);
    expect(runtime.view()).toMatchObject({ name: "local", folder: null, folderMissing: false });
    expect(runtime.workspace.main.state().messages.map((m) => m.text)).toEqual([
      "Remember the harbour.",
      "Noted.",
    ]);
    // Asking where the agent is changes nothing about it: it still starts in its own workspace.
    expect((await whereAmI(runtime, log)).cwd).toBe(join(data, "agent-workspace"));
    await runtime.close();
    open.length = 0;

    // Opening wrote nothing before the first new message; the chain verifies and the old events are the same.
    const lines = readFileSync(logPath, "utf8").split("\n");
    const oldPart = lines.slice(0, before.records.ok ? before.records.events.length : 0).join("\n");
    expect(createHash("sha256").update(`${oldPart}\n`).digest("hex")).toBe(before.hash);
    const after = readLogRecords(logPath);
    expect(after.ok).toBe(true);
    if (after.ok && before.records.ok) {
      expect(after.events.slice(0, before.records.events.length).at(-1)?.hash).toBe(head);
    }
  });

  it("opens without writing anything when nothing is said", async () => {
    const data = tmp("quiet");
    const first = FileLogStore.open(join(data, "log.jsonl"));
    const projection = Projection.open(join(data, "views.db"));
    await Workspace.open({
      log: first,
      projection,
      agent: {
        id: "fake",
        model: "m",
        version: "1",
        async *runTurn() {},
        closeConversation() {},
        async close() {},
      },
      resolvers: [],
      user: USER,
    });
    first.close();
    projection.close();
    const before = sha(join(data, "log.jsonl"));
    const registry = ContextRegistry.load(data);
    const { runtime } = await start(data, registry, "local");
    await runtime.close();
    open.length = 0;
    expect(sha(join(data, "log.jsonl"))).toBe(before);
  });
});

describe("where a context's agent works", () => {
  it("is the folder a person trusted, per context, and each context's own workspace until then", async () => {
    const data = tmp("cwd");
    const projectA = realpathSync(tmp("project-a"));
    const projectB = realpathSync(tmp("project-b"));
    const registry = ContextRegistry.load(data);
    registry.create({ name: "alpha" });
    registry.create({ name: "beta" });
    registry.create({ name: "gamma" });

    const a = await start(data, registry, "alpha");
    const b = await start(data, registry, "beta");
    const g = await start(data, registry, "gamma");

    // alpha and beta trust different folders; gamma isn't asked.
    await a.runtime.decideFolder("trusted", describeFolder(projectA));
    await b.runtime.decideFolder("trusted", describeFolder(projectB));
    const ra = await whereAmI(a.runtime, a.log);
    const rb = await whereAmI(b.runtime, b.log);
    const rg = await whereAmI(g.runtime, g.log);
    expect(ra.cwd).toBe(projectA);
    expect(ra.reply).toBe(`I work in ${projectA}`);
    expect(rb.cwd).toBe(projectB);
    expect(rb.reply).toBe(`I work in ${projectB}`);
    expect(rg.cwd).toBe(join(data, "contexts", "gamma", "agent-workspace"));
    // The process itself starts there too, so the agent finds its own folder wherever it looks.
    expect(registry.get("alpha")).toMatchObject({ folder: projectA, candidate: null });
    expect(a.runtime.view().folder).toEqual({ name: projectA.split("/").pop(), path: projectA });

    // The agent is told the folder's name, never its path.
    const told = recorded(a.log)
      .filter((e) => e.event === "session/prompt")
      .flatMap((e) => e.blocks as string[])
      .join("\n");
    expect(told).toContain(`project folder "${projectA.split("/").pop()}"`);
    expect(told).not.toContain(projectA);
  });

  it("stays in its own workspace when the folder is declined, and the log says who decided and what", async () => {
    const data = tmp("declined");
    const project = realpathSync(tmp("project"));
    mkdirSync(join(project, ".git"));
    writeFileSync(
      join(project, ".git", "config"),
      '[remote "origin"]\n\turl = https://token@github.com/niko/longplay.git\n',
    );
    const registry = ContextRegistry.load(data);
    registry.create({ name: "longplay", candidate: project });
    const { runtime, log } = await start(data, registry, "longplay");
    const info = describeFolder(project);

    await runtime.decideFolder("declined", info);
    const workspace = join(data, "contexts", "longplay", "agent-workspace");
    expect((await whereAmI(runtime, log)).cwd).toBe(workspace);
    expect(registry.get("longplay")).toMatchObject({ folder: null, candidate: project });
    expect(runtime.view().folder).toBeNull();

    // Trusting later, with the same question, applies to the next session: a thread starts one.
    await runtime.decideFolder("trusted", info);
    const parent = runtime.workspace.main.state().messages[0]?.address as string;
    const thread = await runtime.workspace.branch(parent, USER);
    expect((await whereAmI(runtime, log, thread)).cwd).toBe(project);

    const logPath = join(data, "contexts", "longplay", "log.jsonl");
    const read = readLogRecords(logPath);
    if (!read.ok) throw new Error("the log should verify");
    const decisions = knownEvents(read.events).filter((e) => e.type === "context.folder_decided");
    // The decision names the folder by remote and hash. (The agent's own words are its own: the
    // fake says where it is, so the path is in those messages and nowhere in a decision.)
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (line.includes('"context.folder_decided"')) expect(line).not.toContain(project);
    }
    expect(decisions.map((e) => (e.data as { decision: string }).decision)).toEqual([
      "declined",
      "trusted",
    ]);
    expect(decisions[1]?.data).toEqual({
      decision: "trusted",
      remote: "https://github.com/niko/longplay.git",
      pathHash: createHash("sha256").update(project).digest("hex"),
    });
    expect(decisions[1]?.actor).toEqual(USER);
  });

  it("falls back to its own workspace when a trusted folder is gone, and says so", async () => {
    const data = tmp("missing");
    const project = realpathSync(tmp("gone"));
    const registry = ContextRegistry.load(data);
    registry.create({ name: "longplay" });
    const { runtime, log } = await start(data, registry, "longplay");
    await runtime.decideFolder("trusted", describeFolder(project));
    rmSync(project, { recursive: true });
    expect(runtime.view()).toMatchObject({ folder: null, folderMissing: true });
    expect((await whereAmI(runtime, log)).cwd).toBe(
      join(data, "contexts", "longplay", "agent-workspace"),
    );
  });
});
