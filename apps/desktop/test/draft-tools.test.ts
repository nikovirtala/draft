import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAFT_TOOLS, type DraftEvent, knownEvents, toolPolicy } from "@nikovirtala/draft-core";
import { describe, expect, it, vi } from "vitest";
import { FolderTools } from "../src/main/acp/folder-tools.ts";
import { kiroAgentConfig, kiroAgentName } from "../src/main/acp/kiro-agent.ts";
import { CLAUDE_DISALLOWED_TOOLS } from "../src/main/acp/runtime.ts";
import { autoAnswer, type Opened, openAcp, recorded, type Script } from "./acp-helpers.ts";

const reply = (text: string): Script["turns"][number]["steps"][number] => ({
  text,
  chunk: 4,
  delayMs: 0,
});

const call = (
  tool: string,
  input: Record<string, unknown>,
  more: Record<string, unknown> = {},
) => ({
  tool,
  server: "draft",
  input,
  ...more,
});

/** A folder the person trusted: a git repository with one commit, and a folder next to it. */
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-project-")));
  const folder = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(folder);
  mkdirSync(elsewhere);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: folder,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git("init", "-q");
  writeFileSync(join(folder, "hello.txt"), "contents-xyz\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return { root, folder, elsewhere };
}

async function using<T>(o: Opened, f: (o: Opened) => Promise<T>): Promise<T> {
  try {
    return await f(o);
  } finally {
    await o.close();
  }
}

const events = (o: Opened) => knownEvents(o.log.events());
const ofType = <T extends DraftEvent["type"]>(o: Opened, type: T) =>
  events(o).filter((e) => e.type === type) as DraftEvent<T>[];

/** A Kiro whose person-level rules allow everything: it never asks before a call. */
const TRUST_ALL: Partial<Script> = { style: "kiro", starts: "asking", neverAsks: true };

describe("draft's file and shell tools in a trusted folder", () => {
  it("starts Kiro with draft's own agent and offers the tools, and says exactly those", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        listTools: ["draft", "kiro-remote"],
        probe: [],
        turns: [{ steps: [reply("ok")] }],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      await o.service.submit("hi");
      const log = recorded(o.logPath);
      const created = log.find((e) => e.event === "session/new");
      // What draft sends to Kiro: the folder, both MCP servers, and the agent to use.
      expect(created?.params.cwd).toBe(p.folder);
      const agentName = readFileSync(join(o.dir, "kiro-home", "agent-name"), "utf8").trim();
      expect(agentName).toMatch(/^draft-[0-9a-f]{16}$/);
      expect(created?.params._meta).toEqual({ kiro: { modeId: agentName } });
      const [remote, draft] = created?.params.mcpServers ?? [];
      expect(remote).toMatchObject({ type: "http", name: "kiro-remote" });
      expect(draft).toMatchObject({ type: "http", name: "draft" });
      expect(draft.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(draft.headers[0].value).toMatch(/^Bearer .{40,}$/);
      expect(draft.headers[0].value).not.toBe(remote.headers[0].value);
      // The server serves exactly the registry.
      expect(log.find((e) => e.event === "tools" && e.server === "draft")?.names).toEqual(
        DRAFT_TOOLS.map((t) => t.name),
      );
      // The instructions name them, and say changes ask.
      const told = log.find((e) => e.event === "session/prompt")?.blocks[0] as string;
      for (const t of DRAFT_TOOLS) expect(told).toContain(t.name);
      expect(told).toContain("ask the user first");
      expect(told).not.toContain("no file or shell access");
      expect(told).toContain("without asking, that is a fault");
      // Kiro is pointed at draft's own settings folder, where the agent is, and the agent has no
      // built-in tool and denies the capabilities of those that write or run commands.
      const env = log.find((e) => e.event === "environment")?.env;
      expect(env.KIRO_HOME).toBe(join(o.dir, "kiro-home"));
      const agent = JSON.parse(
        readFileSync(join(o.dir, "kiro-home", "agents", `${agentName}.json`), "utf8"),
      );
      expect(agent).toEqual(kiroAgentConfig(agentName));
      expect(agent.tools).toEqual(["@mcp"]);
      expect(agent.permissions.rules).toEqual(
        expect.arrayContaining([
          { capability: "fs_write", effect: "deny" },
          { capability: "shell", effect: "deny" },
        ]),
      );
    });
  });

  it("asks before a write, writes only after yes, and records the result as the step's settlement", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              call("write_file", { path: "notes/todo.txt", content: "buy milk\n" }),
              reply("Written."),
            ],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      const done = o.service.submit("write the note");
      await vi.waitFor(() => expect(o.service.state().prompts).toHaveLength(1));
      // The agent never asked (the person's rules allow everything); draft did, before the file.
      expect(existsSync(join(p.folder, "notes", "todo.txt"))).toBe(false);
      const prompt = o.service.state().prompts[0];
      expect(prompt).toMatchObject({
        tool: "mcp__draft__write_file",
        input: { path: "notes/todo.txt", content: "buy milk\n" },
      });
      expect(ofType(o, "step.started")).toHaveLength(0);
      o.service.answerPrompt(prompt?.id ?? "", true);
      await done;

      expect(readFileSync(join(p.folder, "notes", "todo.txt"), "utf8")).toBe("buy milk\n");
      const order = events(o)
        .map((e) => e.type)
        .filter((t) => t === "agent.permission_asked" || t.startsWith("step."));
      expect(order).toEqual(["agent.permission_asked", "step.started", "step.completed"]);
      const [completed] = ofType(o, "step.completed");
      expect(completed?.data.resultSummary).toMatch(/created notes\/todo\.txt \(9 bytes\)/);
      expect(completed?.data.idempotencyKey).toBe(
        ofType(o, "step.started")[0]?.data.idempotencyKey,
      );
      expect(ofType(o, "agent.anomaly")).toHaveLength(0);
    });
  });

  it("never touches the file when the person says no", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              call("write_file", { path: "hello.txt", content: "changed\n" }),
              call("run_command", { command: "touch declined.txt" }),
              reply("Understood."),
            ],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      autoAnswer(o.service, false);
      await o.service.submit("change it");
      expect(readFileSync(join(p.folder, "hello.txt"), "utf8")).toBe("contents-xyz\n");
      expect(existsSync(join(p.folder, "declined.txt"))).toBe(false);
      expect(ofType(o, "step.started")).toHaveLength(0);
      const calls = ofType(o, "agent.tool_called");
      expect(calls.map((c) => c.data.decision)).toEqual(["denied-by-user", "denied-by-user"]);
    });
  });

  it("asks once when the agent also asks: its request is answered, and the person is asked by draft", async () => {
    const p = project();
    const o = await openAcp(
      {
        style: "kiro",
        starts: "asking",
        turns: [{ steps: [call("write_file", { path: "a.txt", content: "a" }), reply("ok")] }],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      autoAnswer(o.service);
      await o.service.submit("write a.txt");
      const log = recorded(o.logPath);
      expect(log.find((e) => e.event === "permission")?.outcome).toMatchObject({
        outcome: "selected",
        optionId: "accept",
      });
      expect(ofType(o, "agent.permission_asked")).toHaveLength(1);
      expect(ofType(o, "step.started")).toHaveLength(1);
      expect(readFileSync(join(p.folder, "a.txt"), "utf8")).toBe("a");
      expect(ofType(o, "agent.anomaly")).toHaveLength(0);
    });
  });

  it("runs a request that arrives again with the same id once", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [call("run_command", { command: "echo ran >> counter.txt" }, { repeat: 3 })],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      autoAnswer(o.service);
      await o.service.submit("count");
      expect(readFileSync(join(p.folder, "counter.txt"), "utf8")).toBe("ran\n");
      expect(ofType(o, "step.started")).toHaveLength(1);
      expect(ofType(o, "step.completed")).toHaveLength(1);
      expect(ofType(o, "agent.permission_asked")).toHaveLength(1);
      const repeats = recorded(o.logPath).filter((e) => e.event === "repeat");
      expect(repeats).toHaveLength(3);
      expect(new Set(repeats.map((r) => r.text)).size).toBe(1);
    });
  });

  it("runs a read without asking and logs it, without the file's content", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              call("read_file", { path: "hello.txt" }),
              call("list_files", {}),
              call("search_files", { query: "XYZ" }),
              call("run_command", { command: "git status" }),
              call("run_command", { command: "git log --oneline" }),
              reply("Done."),
            ],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      await o.service.submit("look around");
      expect(o.service.state().prompts).toEqual([]);
      expect(ofType(o, "agent.permission_asked")).toHaveLength(0);
      expect(events(o).some((e) => e.type.startsWith("step."))).toBe(false);
      const calls = ofType(o, "agent.tool_called");
      expect(calls.map((c) => [c.data.name, c.data.decision, c.data.isError])).toEqual([
        ["mcp__draft__read_file", "allowed-read-only", false],
        ["mcp__draft__list_files", "allowed-read-only", false],
        ["mcp__draft__search_files", "allowed-read-only", false],
        ["mcp__draft__run_command", "allowed-read-only", false],
        ["mcp__draft__run_command", "allowed-read-only", false],
      ]);
      expect(calls[0]?.data.resultSummary).toMatch(/^read hello\.txt/);
      expect(JSON.stringify(calls[0]?.data)).not.toContain("contents-xyz");
      expect(calls[3]?.data.resultSummary).toContain("exit code 0");
      // What the agent got back is the content.
      const ran = recorded(o.logPath).filter((e) => e.event === "tool-ran");
      expect(ran).toHaveLength(5);
    });
  });

  it("asks for `touch x` and not for `git status`, and lists the files a command changed", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              call("run_command", { command: "git status" }),
              call("run_command", { command: "touch x" }),
              call("run_command", { command: "exit 3" }),
              reply("Done."),
            ],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      autoAnswer(o.service);
      await o.service.submit("go");
      expect(ofType(o, "agent.permission_asked").map((a) => a.data.input)).toEqual([
        { command: "touch x" },
        { command: "exit 3" },
      ]);
      expect(existsSync(join(p.folder, "x"))).toBe(true);
      const [touched, exited] = [...ofType(o, "step.completed"), ...ofType(o, "step.failed")];
      expect(touched?.data.resultSummary).toBe("exit code 0; files changed: x");
      expect(exited?.data.resultSummary).toBe("exit code 3; no files changed");
      expect(ofType(o, "step.failed")).toHaveLength(1);
    });
  });

  it("refuses a path outside the folder, through a link too, without asking and without touching it", async () => {
    const p = project();
    symlinkSync(p.elsewhere, join(p.folder, "out"));
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              call("write_file", { path: "../outside.txt", content: "x" }),
              call("write_file", { path: "out/via-link.txt", content: "x" }),
              call("read_file", { path: join(p.elsewhere, "nothing") }),
              call("write_file", { path: ".git/hooks/pre-commit", content: "x" }),
              call("run_command", { command: "ls", cwd: "out" }),
              reply("Refused."),
            ],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      autoAnswer(o.service);
      await o.service.submit("escape");
      expect(existsSync(join(p.root, "outside.txt"))).toBe(false);
      expect(existsSync(join(p.elsewhere, "via-link.txt"))).toBe(false);
      expect(existsSync(join(p.folder, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(ofType(o, "agent.permission_asked")).toHaveLength(0);
      expect(ofType(o, "agent.tool_called").map((c) => c.data.decision)).toEqual([
        "denied-by-policy",
        "denied-by-policy",
        "denied-by-policy",
        "denied-by-policy",
        "denied-by-policy",
      ]);
    });
  });

  it("offers no tools in a context with no trusted folder, and says so", async () => {
    const o = await openAcp(
      {
        ...TRUST_ALL,
        listTools: ["draft"],
        turns: [{ steps: [reply("ok")] }],
      },
      { kind: "kiro" },
    );
    await using(o, async () => {
      await o.service.submit("hi");
      const log = recorded(o.logPath);
      const created = log.find((e) => e.event === "session/new");
      expect(created?.params.mcpServers.map((s: { name: string }) => s.name)).toEqual([
        "kiro-remote",
      ]);
      // The agent is still draft's, with no built-in tool that changes things.
      expect(created?.params._meta).toEqual({ kiro: { modeId: kiroAgentName(o.dir) } });
      expect(log.find((e) => e.event === "tools")?.error).toBeDefined();
      const told = log.find((e) => e.event === "session/prompt")?.blocks[0] as string;
      expect(told).toContain("no file or shell access");
      for (const t of DRAFT_TOOLS) expect(told).not.toContain(t.name);
    });
  });

  it("offers none to an agent that can't take an HTTP server, or one draft can't take the tools away from", async () => {
    const p = project();
    const noHttp = await openAcp(
      { ...TRUST_ALL, agent: { http: false }, turns: [{ steps: [reply("ok")] }] },
      { kind: "kiro", folder: p.folder },
    );
    await using(noHttp, async (o) => {
      await o.service.submit("hi");
      const created = recorded(o.logPath).find((e) => e.event === "session/new");
      expect(created?.params.mcpServers.map((s: { name: string }) => s.name)).toEqual([
        "kiro-remote",
      ]);
    });
    const generic = await openAcp(
      { turns: [{ steps: [reply("ok")] }] },
      { kind: "generic", folder: p.folder },
    );
    await using(generic, async (o) => {
      await o.service.submit("hi");
      const log = recorded(o.logPath);
      expect(log.find((e) => e.event === "session/new")?.params._meta).toBeUndefined();
      expect(log.find((e) => e.event === "session/new")?.params.mcpServers).toHaveLength(1);
      expect(log.find((e) => e.event === "session/prompt")?.blocks[0]).toContain(
        "no file or shell access",
      );
    });
  });

  it("doesn't start a Kiro session that doesn't report draft's agent", async () => {
    const p = project();
    const o = await openAcp(
      { ...TRUST_ALL, ignoreModeId: true, turns: [{ steps: [reply("never")] }] },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      await o.service.submit("hi");
      expect(o.service.state().error).toMatch(/draft's own agent configuration/);
      const log = recorded(o.logPath);
      expect(log.some((e) => e.event === "session/prompt")).toBe(false);
      expect(log.some((e) => e.event === "session/close")).toBe(true);
    });
  });

  it("gives Claude no settings and none of its own tools that change things, and draft's instead", async () => {
    const p = project();
    const o = await openAcp(
      {
        style: "claude",
        starts: "claude",
        listTools: ["draft"],
        turns: [
          {
            steps: [call("write_file", { path: "c.txt", content: "claude" }), reply("Written.")],
          },
        ],
      },
      { kind: "claude", folder: p.folder },
    );
    await using(o, async () => {
      autoAnswer(o.service);
      await o.service.submit("write c.txt");
      const log = recorded(o.logPath);
      const created = log.find((e) => e.event === "session/new");
      expect(created?.params._meta).toEqual({
        claudeCode: {
          options: { settingSources: [], tools: [], disallowedTools: CLAUDE_DISALLOWED_TOOLS },
        },
      });
      for (const name of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"])
        expect(CLAUDE_DISALLOWED_TOOLS).toContain(name);
      expect(created?.params.mcpServers.map((s: { name: string }) => s.name)).toEqual([
        "kiro-remote",
        "draft",
      ]);
      expect(readFileSync(join(p.folder, "c.txt"), "utf8")).toBe("claude");
      expect(ofType(o, "agent.permission_asked")).toHaveLength(1);
      expect(ofType(o, "step.completed")).toHaveLength(1);
    });
  });

  it("still reports a call of the agent's own that changes something without a request", async () => {
    const p = project();
    const o = await openAcp(
      {
        ...TRUST_ALL,
        turns: [
          {
            steps: [
              { builtin: "fs_write", kind: "edit", input: { path: "z.txt" } },
              reply("Done."),
            ],
          },
        ],
      },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      await o.service.submit("write with your own tool");
      const [anomaly] = ofType(o, "agent.anomaly");
      expect(anomaly?.data).toMatchObject({ kind: "call-without-permission", name: "fs_write" });
      expect(ofType(o, "step.started")).toHaveLength(0);
    });
  });

  it("refuses a request without the session's token", async () => {
    const p = project();
    const o = await openAcp(
      { ...TRUST_ALL, turns: [{ steps: [reply("ok")] }] },
      { kind: "kiro", folder: p.folder },
    );
    await using(o, async () => {
      await o.service.submit("hi");
      const draft = recorded(o.logPath).find((e) => e.event === "session/new")?.params
        .mcpServers[1];
      const post = (headers: Record<string, string>, host?: string) =>
        fetch(draft.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(host ? { host } : {}), ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
      expect((await post({})).status).toBe(401);
      expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
      expect(
        (await post({ authorization: draft.headers[0].value, origin: "http://evil.example" }))
          .status,
      ).toBe(403);
      expect((await post({ authorization: draft.headers[0].value })).status).toBe(200);
    });
  });
});

describe("draft's agent in Kiro", () => {
  it("has a name nobody could have guessed, the same each time, and one per data folder", () => {
    const a = mkdtempSync(join(tmpdir(), "draft-name-"));
    const b = mkdtempSync(join(tmpdir(), "draft-name-"));
    const name = kiroAgentName(a);
    expect(name).toMatch(/^draft-[0-9a-f]{16}$/);
    expect(kiroAgentName(a)).toBe(name);
    expect(kiroAgentName(b)).not.toBe(name);
  });
});

describe("what draft's tools do in the folder", () => {
  const tools = (folder: string) =>
    new FolderTools({ ctx: { folder }, env: { PATH: process.env.PATH ?? "" } });
  const run = async (
    folder: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const v = toolPolicy(tool, input, { folder });
    if (v.class === "refused") throw new Error(v.reason);
    return tools(folder).run(v, signal === undefined ? {} : { signal });
  };

  it("edits a file once, and says when the text isn't there or is there more than once", async () => {
    const { folder } = project();
    writeFileSync(join(folder, "e.txt"), "one two two\n");
    expect(
      await run(folder, "edit_file", { path: "e.txt", old_string: "one", new_string: "1" }),
    ).toMatchObject({ isError: false });
    expect(readFileSync(join(folder, "e.txt"), "utf8")).toBe("1 two two\n");
    expect(
      await run(folder, "edit_file", { path: "e.txt", old_string: "two", new_string: "2" }),
    ).toMatchObject({ isError: true, text: expect.stringContaining("2 times") });
    expect(
      await run(folder, "edit_file", { path: "e.txt", old_string: "absent", new_string: "x" }),
    ).toMatchObject({ isError: true });
    await run(folder, "edit_file", {
      path: "e.txt",
      old_string: "two",
      new_string: "2",
      replace_all: true,
    });
    expect(readFileSync(join(folder, "e.txt"), "utf8")).toBe("1 2 2\n");
  });

  it("reads a part of a file, and refuses a binary one", async () => {
    const { folder } = project();
    writeFileSync(join(folder, "l.txt"), "a\nb\nc\nd\n");
    writeFileSync(join(folder, "b.bin"), Buffer.from([1, 0, 2]));
    expect((await run(folder, "read_file", { path: "l.txt", offset: 2, limit: 2 })).text).toBe(
      "b\nc",
    );
    expect(await run(folder, "read_file", { path: "b.bin" })).toMatchObject({ isError: true });
  });

  it("stops a command at its time limit and keeps what it printed, capped", async () => {
    const { folder } = project();
    const slow = await run(folder, "run_command", {
      command: "echo started; sleep 30",
      timeout_seconds: 1,
    });
    expect(slow.isError).toBe(true);
    expect(slow.summary).toContain("timed out after 1 s");
    expect(slow.text).toContain("started");
    const loud = await run(folder, "run_command", { command: "yes x | head -c 500000" });
    expect(loud.text.length).toBeLessThan(62_000);
    expect(loud.summary.length).toBeLessThan(1200);
  });

  it("stops a command when the agent hangs up", async () => {
    const { folder } = project();
    const abort = new AbortController();
    const running = run(folder, "run_command", { command: "sleep 30" }, abort.signal);
    setTimeout(() => abort.abort(), 100);
    expect(await running).toMatchObject({
      isError: true,
      summary: expect.stringContaining("stopped"),
    });
  });

  it("runs a command in the folder, with no sign-ins of the person's in its environment", async () => {
    const { folder } = project();
    const t = new FolderTools({
      ctx: { folder },
      env: { PATH: process.env.PATH ?? "", GH_TOKEN: "draft-withholds" },
    });
    const v = toolPolicy("run_command", { command: "pwd && echo $GH_TOKEN" }, { folder });
    if (v.class === "refused") throw new Error(v.reason);
    const r = await t.run(v, { idempotencyKey: "k1" });
    expect(r.text).toContain(folder);
    expect(r.text).toContain("draft-withholds");
    const k = toolPolicy("run_command", { command: "echo $DRAFT_IDEMPOTENCY_KEY" }, { folder });
    if (k.class === "refused") throw new Error(k.reason);
    expect((await t.run(k, { idempotencyKey: "k1" })).text).toContain("k1");
  });
});
