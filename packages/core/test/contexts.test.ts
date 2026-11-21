import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAddress } from "../src/address.ts";
import type { AgentEvent, AgentRuntime, AgentTurnInput } from "../src/agent.ts";
import { AGENT_BRIEFING, buildAgentContext, renderAgentContext } from "../src/agent-context.ts";
import type { ContextIntent, ContextLauncher, CrossContext } from "../src/conversation.ts";
import {
  CONTEXT_ITEM,
  contextItemKey,
  findContextAddresses,
  snapshotFromRecords,
} from "../src/cross-context.ts";
import { knownEvents } from "../src/events.ts";
import { FileLogStore, readLogRecords } from "../src/log.ts";
import { Projection } from "../src/projection.ts";
import { Workspace } from "../src/workspace.ts";
import { USER } from "./helpers.ts";

const MARKER = "quokka-marker-4417";

/** An agent that answers every turn and keeps everything it was told. */
class RecordingAgent implements AgentRuntime {
  readonly id = "recording";
  readonly model = "recording-model";
  readonly version = "1";
  readonly told: string[] = [];
  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent> {
    this.told.push(`${AGENT_BRIEFING}\n${renderAgentContext(input.context)}\n${input.text}`);
    yield { type: "text-delta", text: "Noted." };
    yield { type: "done", text: "Noted.", usage: null, model: this.model };
  }
  closeConversation(): void {}
  async close(): Promise<void> {}
}

interface Opened {
  dir: string;
  logPath: string;
  workspace: Workspace;
  agent: RecordingAgent;
  close(): void;
}

async function openContext(
  name: string,
  o: { launcher?: ContextLauncher; crossContext?: CrossContext } = {},
): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), `draft-ctx-${name}-`));
  const logPath = join(dir, "log.jsonl");
  const log = FileLogStore.open(logPath, { context: name });
  const projection = Projection.open(join(dir, "views.db"));
  const agent = new RecordingAgent();
  const workspace = await Workspace.open({
    log,
    projection,
    agent,
    resolvers: [],
    user: USER,
    context: name,
    title: name,
    poller: { baseMs: 0 },
    ...o,
  });
  return {
    dir,
    logPath,
    workspace,
    agent,
    close: () => {
      log.close();
      projection.close();
    },
  };
}

/** The events of a log file, verified; the test fails if the log doesn't verify. */
function eventsOf(path: string) {
  const read = readLogRecords(path);
  if (!read.ok) throw new Error(`log should verify: ${read.reason}`);
  return knownEvents(read.events);
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("a context's own log", () => {
  it("names itself in every address and starts with its own context.created", async () => {
    const b = await openContext("longplay");
    expect(eventsOf(b.logPath)[0]?.type).toBe("context.created");
    expect(parseAddress(b.workspace.mainConversation).context).toBe("longplay");
    b.close();
  });

  it("records a folder decision as the person, with the remote and a hash of the path, never the path", async () => {
    const a = await openContext("longplay");
    const path = "/home/niko/code/longplay";
    const pathHash = createHash("sha256").update(path).digest("hex");
    await a.workspace.decideFolder(
      "trusted",
      { remote: "https://github.com/niko/longplay.git", pathHash },
      USER,
    );
    const decision = a.workspace.folderDecision();
    expect(decision).toMatchObject({
      decision: "trusted",
      remote: "https://github.com/niko/longplay.git",
      pathHash,
      actor: { kind: "user", id: USER.id },
    });
    const text = readFileSync(a.logPath, "utf8");
    expect(text).not.toContain(path);
    expect(text).toContain(pathHash);
    // The log still verifies, and the projection rebuilt from it says the same.
    const read = readLogRecords(a.logPath);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const fresh = Projection.open();
      fresh.rebuild(read.events);
      expect(fresh.folderDecisions()).toEqual(a.workspace.folderDecision() ? [decision] : []);
    }
    // A later answer is the one in force; the first stays in the log.
    await a.workspace.decideFolder("declined", { remote: null, pathHash }, USER);
    expect(a.workspace.folderDecision()?.decision).toBe("declined");
    a.close();
  });
});

describe("addresses across contexts", () => {
  it("finds versioned addresses in text and leaves look-alikes alone", () => {
    const text =
      "see longplay/01kabc/01kdef@1 and longplay/01kabc@1, not owner/repo#12, src/main/index, @scope/pkg@2 or https://x.test/a/b@3";
    expect(findContextAddresses(text).map((a) => a.context)).toEqual(["longplay", "longplay"]);
  });

  it("snapshots a message and a conversation from the records of a log", async () => {
    const b = await openContext("longplay");
    await b.workspace.main.submit(`First line ${MARKER}\nsecond line`);
    const read = readLogRecords(b.logPath);
    if (!read.ok) throw new Error("log should verify");
    const message = b.workspace.main.state().messages[0];
    if (message === undefined) throw new Error("no message");
    const a = parseAddress(message.address);
    const snap = snapshotFromRecords(read.events, a, { name: "longplay", logContext: "longplay" });
    expect(snap).toMatchObject({
      context: "longplay",
      address: message.address,
      kind: "message",
      version: 1,
      title: `First line ${MARKER}`,
      role: "user",
    });
    expect(snap?.hash).toMatch(/^[0-9a-f]{64}$/);
    const conv = snapshotFromRecords(
      read.events,
      parseAddress(`${b.workspace.mainConversation}@1`),
      { name: "longplay", logContext: "longplay" },
    );
    expect(conv).toMatchObject({ kind: "conversation", title: "longplay" });
    expect(
      snapshotFromRecords(read.events, parseAddress("longplay/nope/nope@1"), {
        name: "longplay",
        logContext: "longplay",
      }),
    ).toBeNull();
    // An aliased log: addresses typed with the device's name read the log's own.
    const aliased = snapshotFromRecords(
      read.events,
      parseAddress(message.address.replace("longplay", "work")),
      {
        name: "work",
        logContext: "longplay",
      },
    );
    expect(aliased).toMatchObject({ context: "work", kind: "message" });
    b.close();
  });
});

describe("a reference across contexts", () => {
  async function pair() {
    const b = await openContext("longplay");
    await b.workspace.main.submit(`The deploy key is ${MARKER}`);
    const target = b.workspace.main.state().messages[0]?.address as string;
    const bBefore = sha(b.logPath);
    const crossContext: CrossContext = {
      detect: (text) =>
        findContextAddresses(text)
          .filter((a) => a.context === "longplay")
          .map(
            (a) =>
              `${a.context}/${a.conversation}${a.item === null ? "" : `/${a.item}`}@${a.version}`,
          ),
      snapshot: async (address) => {
        const read = readLogRecords(b.logPath);
        if (!read.ok) return null;
        return snapshotFromRecords(read.events, parseAddress(address), {
          name: "longplay",
          logContext: "longplay",
        });
      },
    };
    const a = await openContext("work", { crossContext });
    return { a, b, target, bBefore };
  }

  it("keeps a snapshot, records the crossing, and never gives the other log to the agent", async () => {
    const { a, b, target, bBefore } = await pair();
    await a.workspace.main.submit(`What do you make of ${target}?`);
    const state = a.workspace.main.state();
    const refs = state.messages[0]?.references ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: CONTEXT_ITEM, id: target });
    expect(refs[0]?.snapshot).toMatchObject({
      context: "longplay",
      address: target,
      kind: "message",
      version: 1,
    });
    expect(JSON.stringify(refs[0]?.snapshot)).toContain(MARKER);
    const crossings = eventsOf(a.logPath).filter((e) => e.type === "context.crossed");
    expect(crossings).toHaveLength(1);
    expect(crossings[0]?.data).toMatchObject({
      purpose: "referenced",
      context: "longplay",
      target,
    });
    expect(crossings[0]?.actor).toMatchObject({ kind: "user" });

    // The marker is in the other context only: not in what this context's agent was told, on
    // this turn or on a session that starts later from the log.
    for (const told of a.agent.told) expect(told).not.toContain(MARKER);
    await a.workspace.main.submit("And what next?");
    for (const told of a.agent.told) expect(told).not.toContain(MARKER);
    const rebuilt = Projection.open();
    const read = readLogRecords(a.logPath);
    if (!read.ok) throw new Error("log should verify");
    rebuilt.rebuild(read.events);
    expect(
      renderAgentContext(buildAgentContext(rebuilt, a.workspace.mainConversation)),
    ).not.toContain(MARKER);
    // Nothing was written to the other context by taking the snapshot.
    expect(sha(b.logPath)).toBe(bBefore);
    a.close();
    b.close();
  });

  it("reaches the agent only after a person pulls it in, and that is a crossing too", async () => {
    const { a, b, target } = await pair();
    await a.workspace.main.submit(`See ${target}`);
    await a.workspace.main.cross("pulled", target);
    await a.workspace.main.submit("Use it.");
    const last = a.agent.told.at(-1) ?? "";
    expect(last).toContain(contextItemKey(target));
    expect(last).toContain(MARKER);
    const purposes = eventsOf(a.logPath)
      .filter((e) => e.type === "context.crossed")
      .map((e) => (e.data as { purpose: string }).purpose);
    expect(purposes).toEqual(["referenced", "pulled"]);
    // Following records the crossing and names the context to open.
    expect(await a.workspace.main.cross("followed", target)).toEqual({ context: "longplay" });
    // Only what the conversation references can be crossed to.
    await expect(a.workspace.main.cross("pulled", "longplay/zz/zz@1")).rejects.toThrow(
      /no reference/,
    );
    a.close();
    b.close();
  });

  it("makes no reference when the other context has no such item", async () => {
    const { a, b } = await pair();
    await a.workspace.main.submit("See longplay/01kzzz/01kzzz@1");
    expect(a.workspace.main.state().messages[0]?.references).toHaveLength(0);
    a.close();
    b.close();
  });

  it("makes no reference from the agent's own words", async () => {
    const { a, b, target } = await pair();
    // An agent that repeats an address it was given still never makes draft read another log.
    a.agent.runTurn = async function* () {
      yield { type: "text-delta", text: `Look at ${target}` };
      yield { type: "done", text: `Look at ${target}`, usage: null, model: "m" };
    };
    await a.workspace.main.submit("hello");
    const agentMessage = a.workspace.main.state().messages.find((m) => m.role === "agent");
    expect(agentMessage?.references).toHaveLength(0);
    a.close();
    b.close();
  });
});

describe("opening a context by sentence", () => {
  function launcher() {
    const opened: ContextIntent[] = [];
    const l: ContextLauncher = {
      recognise: (text) => {
        const m = /^open (\w+)$/i.exec(text.trim());
        return m === null ? null : { kind: "open", name: m[1] as string };
      },
      open: async (intent) => {
        opened.push(intent);
        return { context: intent.kind === "open" ? intent.name : "new" };
      },
    };
    return { l, opened };
  }

  it("proposes without asking the agent, and opens only after one confirmation", async () => {
    const { l, opened } = launcher();
    const a = await openContext("work", { launcher: l });
    await a.workspace.main.submit("open longplay");
    // The agent never saw the sentence and nothing opened.
    expect(a.agent.told).toHaveLength(0);
    expect(opened).toHaveLength(0);
    const state = a.workspace.main.state();
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]?.intent).toEqual({ kind: "open", name: "longplay" });
    expect(state.messages[0]?.audience.agent).toBe(false);

    await a.workspace.main.answerProposal(state.proposals[0]?.id as string, true);
    expect(opened).toEqual([{ kind: "open", name: "longplay" }]);
    expect(a.workspace.main.state().proposals).toHaveLength(0);
    const crossed = eventsOf(a.logPath).filter((e) => e.type === "context.crossed");
    expect(crossed).toHaveLength(1);
    expect(crossed[0]?.data).toMatchObject({
      purpose: "opened",
      context: "longplay",
      via: "sentence",
    });
    expect(crossed[0]?.actor).toMatchObject({ kind: "user" });
    a.close();
  });

  it("dismisses a proposal without opening anything, and passes other sentences to the agent", async () => {
    const { l, opened } = launcher();
    const a = await openContext("work", { launcher: l });
    await a.workspace.main.submit("open longplay");
    const id = a.workspace.main.state().proposals[0]?.id as string;
    await a.workspace.main.answerProposal(id, false);
    expect(opened).toHaveLength(0);
    expect(a.workspace.main.state().proposals).toHaveLength(0);
    await a.workspace.main.submit("what is open?");
    expect(a.agent.told).toHaveLength(1);
    a.close();
  });
});
