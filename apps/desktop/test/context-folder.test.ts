import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeFolder,
  expandHome,
  FolderError,
  remoteFromConfig,
  sanitizeRemote,
} from "../src/main/contexts/folder.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "draft-folder-"));

describe("describing a folder before it is trusted", () => {
  it("gives its real path, its name and a hash of the path", () => {
    const root = tmp();
    const real = join(root, "longplay");
    mkdirSync(real);
    symlinkSync(real, join(root, "link"));
    const info = describeFolder(join(root, "link"));
    expect(info.path.endsWith("/longplay")).toBe(true);
    expect(info.name).toBe("longplay");
    expect(info.pathHash).toBe(createHash("sha256").update(info.path).digest("hex"));
    expect(info.remote).toBeNull();
  });

  it("expands ~ and takes a relative path from a base", () => {
    const home = tmp();
    mkdirSync(join(home, "code"));
    expect(expandHome("~/code", home)).toBe(join(home, "code"));
    expect(describeFolder("~/code", { home }).name).toBe("code");
    expect(describeFolder("code", { base: home }).name).toBe("code");
  });

  it("refuses what isn't a folder", () => {
    const root = tmp();
    writeFileSync(join(root, "file"), "x");
    expect(() => describeFolder(join(root, "file"))).toThrow(FolderError);
    expect(() => describeFolder(join(root, "missing"))).toThrow(/isn't a folder/);
  });

  it("reads the git remote from the repository's own config, without running anything", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    writeFileSync(
      join(root, ".git", "config"),
      [
        "[core]",
        "\tfsmonitor = /tmp/should-never-run",
        '[remote "upstream"]',
        "\turl = https://github.com/other/longplay.git",
        '[remote "origin"]',
        "\turl = https://niko:ghp_secret@github.com/niko/longplay.git",
      ].join("\n"),
    );
    // Credentials in the URL never reach the log or the screen.
    expect(describeFolder(root).remote).toBe("https://github.com/niko/longplay.git");
  });

  it("follows a worktree's .git file to the common config", () => {
    const root = tmp();
    const main = join(root, "main");
    const gitDir = join(main, ".git");
    mkdirSync(join(gitDir, "worktrees", "wt"), { recursive: true });
    writeFileSync(
      join(gitDir, "config"),
      '[remote "origin"]\n\turl = git@github.com:niko/longplay.git\n',
    );
    writeFileSync(join(gitDir, "worktrees", "wt", "commondir"), "../..\n");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(gitDir, "worktrees", "wt")}\n`);
    expect(describeFolder(wt).remote).toBe("git@github.com:niko/longplay.git");
  });

  it("takes the first remote when there is no origin, and none when there is no url", () => {
    expect(remoteFromConfig('[remote "fork"]\n\turl = ssh://git@host/x.git\n')).toBe(
      "ssh://host/x.git",
    );
    expect(remoteFromConfig('[remote "origin"]\n\tfetch = +refs/*:refs/*\n')).toBeNull();
    expect(sanitizeRemote("  ")).toBeNull();
  });
});
