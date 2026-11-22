import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * What draft knows about a folder it is asked to trust: its real path, its git remote and a hash
 * of the path. The remote is read from the repository's own config file: no program runs in a
 * folder nobody has trusted yet, so nothing in it (a hook, a `core.fsmonitor` setting) can run.
 */
export interface FolderInfo {
  /** The real path, with symbolic links resolved. */
  path: string;
  /** The folder's own name. */
  name: string;
  /** The git remote with any credentials removed, or null. */
  remote: string | null;
  /** SHA-256 of the real path: what the log records instead of the path. */
  pathHash: string;
}

export class FolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderError";
  }
}

/** `~` and `~/x` mean the person's home directory. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

/** Removes `user:token@` from a URL remote; other forms (`git@host:owner/repo`) are kept. */
export function sanitizeRemote(url: string): string | null {
  const t = url.trim();
  if (t === "") return null;
  return t.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
}

/** Where a folder's git config is: `.git/config`, or the common dir of a worktree or submodule. */
function gitConfigPath(folder: string): string | null {
  const dot = join(folder, ".git");
  if (!existsSync(dot)) return null;
  let gitDir = dot;
  if (statSync(dot).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    if (m === null) return null;
    gitDir = isAbsolute(m[1] as string) ? (m[1] as string) : resolve(folder, m[1] as string);
  }
  const common = join(gitDir, "commondir");
  if (existsSync(common)) {
    const rel = readFileSync(common, "utf8").trim();
    gitDir = isAbsolute(rel) ? rel : resolve(gitDir, rel);
  }
  const config = join(gitDir, "config");
  return existsSync(config) ? config : null;
}

/**
 * The `owner/repo` of a GitHub remote, in any of the forms git takes (`https://github.com/o/r.git`,
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r`), or null for a remote that isn't GitHub's.
 */
export function githubRepoOf(remote: string): string | null {
  const m =
    /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return m === null ? null : `${m[1]}/${m[2]}`;
}

/** The URL of `origin` (else of the first remote that has one) in the text of a git config. */
export function remoteFromConfig(text: string): string | null {
  const remotes = new Map<string, string>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section !== null) {
      current = section[1] as string;
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (current !== null && url !== null && !remotes.has(current))
      remotes.set(current, url[1] as string);
  }
  const chosen = remotes.get("origin") ?? [...remotes.values()][0];
  return chosen === undefined ? null : sanitizeRemote(chosen);
}

export function gitRemote(folder: string): string | null {
  try {
    const config = gitConfigPath(folder);
    return config === null ? null : remoteFromConfig(readFileSync(config, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Describes a folder given as a person typed it: `~` is expanded, a relative path is taken from
 * `base`, and the result is its real path. Throws `FolderError` if it isn't a folder.
 */
export function describeFolder(
  input: string,
  o: { base?: string; home?: string } = {},
): FolderInfo {
  const expanded = expandHome(input.trim(), o.home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(o.base ?? process.cwd(), expanded);
  let path: string;
  try {
    path = realpathSync(absolute);
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new FolderError(`${input.trim()} isn't a folder draft can open`);
  }
  return {
    path,
    name: basename(path) || basename(dirname(path)) || "folder",
    remote: gitRemote(path),
    pathHash: hashPath(path),
  };
}
