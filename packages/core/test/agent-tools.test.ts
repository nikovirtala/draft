import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_BRIEFING, agentBriefing } from "../src/agent-context.ts";
import {
  DRAFT_TOOLS,
  draftToolName,
  isReadOnlyCommand,
  loggedInput,
  offeredTools,
  plainCommandWords,
  READ_ONLY_COMMANDS,
  toolPolicy,
  toolsBriefing,
} from "../src/agent-tools.ts";

/** A folder the person trusted, a folder next to it, and links from the first to the second. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-tools-")));
  const folder = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, ".git"), { recursive: true });
  mkdirSync(elsewhere);
  writeFileSync(join(folder, "src", "a.ts"), "a");
  writeFileSync(join(elsewhere, "secret.txt"), "secret");
  symlinkSync(elsewhere, join(folder, "link-to-elsewhere"));
  symlinkSync(join(elsewhere, "secret.txt"), join(folder, "link-to-secret"));
  symlinkSync(join(folder, "src"), join(folder, "link-inside"));
  return { root, folder, elsewhere, ctx: { folder } };
}

const verdict = (tool: string, input: unknown, ctx: { folder: string | null }) =>
  toolPolicy(tool, input, ctx).class;

describe("the registry and its policy", () => {
  it("has one entry per tool, each with a name, a title, a description and an access", () => {
    expect(DRAFT_TOOLS.map((t) => t.name)).toEqual([
      "read_file",
      "list_files",
      "search_files",
      "write_file",
      "edit_file",
      "run_command",
    ]);
    for (const t of DRAFT_TOOLS) {
      expect(t.title).not.toBe("");
      expect(t.description).not.toBe("");
    }
  });

  it("refuses every tool in a context with no trusted folder", () => {
    for (const [tool, input] of [
      ["read_file", { path: "a" }],
      ["list_files", {}],
      ["search_files", { query: "x" }],
      ["write_file", { path: "a", content: "" }],
      ["edit_file", { path: "a", old_string: "a", new_string: "b" }],
      ["run_command", { command: "git status" }],
    ] as const)
      expect(verdict(tool, input, { folder: null }), tool).toBe("refused");
  });

  it("refuses a tool it doesn't have, in either spelling", () => {
    const { ctx } = world();
    expect(verdict("bash", { command: "ls" }, ctx)).toBe("refused");
    expect(verdict(draftToolName("fs_write"), {}, ctx)).toBe("refused");
    expect(verdict(draftToolName("read_file"), { path: "src/a.ts" }, ctx)).toBe("read");
  });

  it("reads inside the folder without asking, and writes and edits ask", () => {
    const { ctx } = world();
    expect(verdict("read_file", { path: "src/a.ts" }, ctx)).toBe("read");
    expect(verdict("list_files", {}, ctx)).toBe("read");
    expect(verdict("list_files", { path: "src", depth: 2 }, ctx)).toBe("read");
    expect(verdict("search_files", { query: "x" }, ctx)).toBe("read");
    expect(verdict("write_file", { path: "src/new/b.ts", content: "b" }, ctx)).toBe("change");
    expect(verdict("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" }, ctx)).toBe(
      "change",
    );
  });

  it("refuses a path outside the folder, relative or absolute, for every tool that takes one", () => {
    const { ctx, elsewhere } = world();
    for (const p of ["../elsewhere/secret.txt", elsewhere, "/etc/passwd", "src/../../x"]) {
      expect(verdict("read_file", { path: p }, ctx), p).toBe("refused");
      expect(verdict("list_files", { path: p }, ctx), p).toBe("refused");
      expect(verdict("search_files", { query: "x", path: p }, ctx), p).toBe("refused");
      expect(verdict("write_file", { path: p, content: "" }, ctx), p).toBe("refused");
      expect(verdict("edit_file", { path: p, old_string: "a", new_string: "b" }, ctx), p).toBe(
        "refused",
      );
      expect(verdict("run_command", { command: "ls", cwd: p }, ctx), p).toBe("refused");
    }
  });

  it("refuses a path that leaves the folder through a symlink, and one below a link, and a new file under it", () => {
    const { ctx } = world();
    for (const p of [
      "link-to-elsewhere",
      "link-to-elsewhere/secret.txt",
      "link-to-elsewhere/new.txt",
      "link-to-secret",
    ]) {
      expect(verdict("read_file", { path: p }, ctx), p).toBe("refused");
      expect(verdict("write_file", { path: p, content: "x" }, ctx), p).toBe("refused");
    }
    // A link that stays inside the folder is fine.
    expect(verdict("read_file", { path: "link-inside/a.ts" }, ctx)).toBe("read");
  });

  it("refuses to write under .git, .kiro, .claude and .vscode, and reads there", () => {
    const { ctx } = world();
    for (const dir of [".git", ".kiro", ".claude", ".vscode"]) {
      expect(verdict("write_file", { path: `${dir}/x`, content: "" }, ctx), dir).toBe("refused");
      expect(
        verdict("edit_file", { path: `${dir}/x`, old_string: "a", new_string: "b" }, ctx),
        dir,
      ).toBe("refused");
      expect(verdict("read_file", { path: `${dir}/x` }, ctx), dir).toBe("read");
    }
    expect(verdict("write_file", { path: "src/.git-notes", content: "" }, ctx)).toBe("change");
  });

  it("refuses an input that doesn't fit the tool", () => {
    const { ctx } = world();
    expect(verdict("read_file", {}, ctx)).toBe("refused");
    expect(verdict("read_file", { path: 3 }, ctx)).toBe("refused");
    expect(verdict("run_command", { command: "ls", timeout_seconds: 100_000 }, ctx)).toBe(
      "refused",
    );
    expect(verdict("write_file", { path: "a" }, ctx)).toBe("refused");
  });
});

describe("the command allowlist", () => {
  const { ctx } = world();
  const kind = (command: string) => verdict("run_command", { command }, ctx);

  it("runs read-only commands from the list without asking", () => {
    for (const c of [
      "git status",
      "git log",
      "git log --oneline -n 5",
      "git diff",
      "git diff HEAD~1",
      "git diff origin/main..HEAD",
      "git show HEAD",
      "ls",
      "ls -la src",
      "cat src/a.ts",
      "head -n 5 src/a.ts",
      "rg foo",
      "rg 'foo bar' src",
      "grep -rn foo src",
      "pwd",
      "wc -l src/a.ts",
    ])
      expect(kind(c), c).toBe("read");
  });

  it("asks for every other program and git subcommand", () => {
    for (const c of [
      "touch x",
      "rm -rf x",
      "npm test",
      "node script.js",
      "git commit -m x",
      "git push",
      "git checkout main",
      "git branch -D x",
      "git config user.name x",
      "git remote add a b",
      "git -C /tmp status",
      "git",
      "gh pr view 3",
      "curl https://example.com",
      "sed -i s/a/b/ src/a.ts",
      "find . -delete",
      "./status",
      "/bin/ls",
      "FOO=1 ls",
    ])
      expect(kind(c), c).toBe("change");
  });

  it("asks when a read-only program is combined with anything a shell would act on", () => {
    for (const c of [
      "ls; touch x",
      "ls && touch x",
      "ls || touch x",
      "ls | tee x",
      "ls > out.txt",
      "cat < src/a.ts",
      "echo $(touch x)",
      "ls `touch x`",
      "ls $HOME",
      "ls ~",
      "ls *",
      "ls src/?.ts",
      "ls {a,b}",
      "ls\ntouch x",
      "ls # comment",
      'ls "$HOME"',
      "ls \\; touch x",
      "git log !!",
      "ls 'unterminated",
    ])
      expect(kind(c), c).toBe("change");
  });

  it("asks when an argument names a path outside the folder or leads out through a link", () => {
    for (const c of [
      "cat /etc/passwd",
      "cat ../elsewhere/secret.txt",
      "ls ..",
      "ls ../elsewhere",
      "cat link-to-secret",
      "ls link-to-elsewhere",
      "rg secret link-to-elsewhere",
      "cat ~/.aws/credentials",
      "rg -f /etc/passwd x",
      "rg --file=/etc/passwd x",
      "git diff --no-index /etc/a /etc/b",
      "git diff /etc/passwd",
    ])
      expect(kind(c), c).toBe("change");
  });

  it("asks when a flag makes a read-only program write, run another program or follow links", () => {
    for (const c of [
      "git diff --output=out.patch",
      "git log --output out.txt",
      "git diff --ext-diff",
      "rg --pre ./cmd foo",
      "rg --pre=./cmd foo",
      "rg -z foo",
      "rg -uz foo",
      "rg -L foo",
      "rg --follow foo",
      "grep -R foo .",
      "tail -f src/a.ts",
    ])
      expect(kind(c), c).toBe("change");
  });

  it("is decided from one list, and that list is what the agent is told", () => {
    expect(Object.keys(READ_ONLY_COMMANDS)).toContain("git");
    const text = toolsBriefing(DRAFT_TOOLS);
    expect(text).toContain("git status");
    expect(text).toContain("rg");
    // Every program of the list is said, and nothing outside it is.
    for (const program of Object.keys(READ_ONLY_COMMANDS)) expect(text).toContain(program);
    expect(text).not.toContain("npm test");
  });

  it("tells a plain command from one a shell would do more with", () => {
    expect(plainCommandWords("git log --oneline")).toEqual(["git", "log", "--oneline"]);
    expect(plainCommandWords("rg 'a b' \"c d\"")).toEqual(["rg", "a b", "c d"]);
    expect(plainCommandWords("")).toBeNull();
    expect(plainCommandWords("  ")).toBeNull();
    expect(plainCommandWords("a;b")).toBeNull();
    expect(plainCommandWords("a 'b;c'")).toEqual(["a", "b;c"]);
    expect(plainCommandWords('a "b$c"')).toBeNull();
  });

  it("never reads without a folder", () => {
    expect(isReadOnlyCommand("ls", ".", { folder: null })).toBe(false);
  });

  it("takes the path functions from the context, so the policy runs without a file system", () => {
    const fake = {
      folder: "/p",
      realpath: (x: string) => (x.includes("link") ? "/outside/file" : x),
      exists: () => true,
    };
    expect(verdict("read_file", { path: "a" }, fake)).toBe("read");
    expect(verdict("read_file", { path: "link" }, fake)).toBe("refused");
    expect(verdict("run_command", { command: "cat link" }, fake)).toBe("change");
    expect(verdict("run_command", { command: "cat a" }, fake)).toBe("read");
  });
});

describe("what the agent is told", () => {
  it("names exactly the tools the session offers, from the same registry", () => {
    const offered = offeredTools({ builtinsRemoved: true, http: true, folder: "/p" });
    expect(offered).toEqual(DRAFT_TOOLS);
    const text = agentBriefing(offered);
    for (const t of DRAFT_TOOLS) expect(text).toContain(t.name);
    expect(text).toContain("ask the user first");
    expect(text).not.toContain("no file or shell access");
  });

  it("says there are none when the session offers none, in every way that happens", () => {
    for (const none of [
      offeredTools({ builtinsRemoved: true, http: true, folder: null }),
      offeredTools({ builtinsRemoved: false, http: true, folder: "/p" }),
      offeredTools({ builtinsRemoved: true, http: false, folder: "/p" }),
    ]) {
      expect(none).toEqual([]);
      const text = agentBriefing(none);
      expect(text).toContain("no file or shell access");
      for (const t of DRAFT_TOOLS) expect(text).not.toContain(t.name);
    }
    expect(AGENT_BRIEFING).toBe(agentBriefing([]));
  });

  it("derives the line about a subset from that subset", () => {
    const reads = DRAFT_TOOLS.filter((t) => t.access === "read");
    const text = toolsBriefing(reads);
    expect(text).toContain("read_file");
    expect(text).not.toContain("write_file");
  });

  it("says why a call of the agent's own that changes something unasked is wrong", () => {
    for (const tools of [[], DRAFT_TOOLS]) {
      const text = agentBriefing(tools);
      expect(text).toContain("without asking");
      expect(text).toContain("call without permission");
    }
  });
});

describe("what is logged of a call", () => {
  it("keeps a short input as it is, and a long content as a preview and a digest", () => {
    const digest = (s: string) => `sha:${s.length}`;
    expect(loggedInput({ path: "a", content: "x" }, digest)).toEqual({ path: "a", content: "x" });
    const long = loggedInput({ path: "a", content: "y".repeat(5000) }, digest, 100);
    expect(long.path).toBe("a");
    expect(String(long.content).length).toBeLessThan(200);
    expect(long.content_sha256).toBe("sha:5000");
    expect(long.content_characters).toBe(5000);
  });
});
