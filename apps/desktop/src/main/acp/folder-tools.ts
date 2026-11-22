import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  confine,
  DEFAULT_TIMEOUT_SECONDS,
  type PolicyContext,
  relativeToFolder,
  type ToolVerdict,
} from "@nikovirtala/draft-core";

/**
 * What draft's file and shell tools do once the policy said they may run (agent-tools.ts in core
 * decides that; nothing here decides what may run). Everything is confined to the trusted folder,
 * with paths resolved to real paths so a link out of the folder reaches nothing.
 *
 * Each call returns what the agent is told (`text`), a bounded record for the log (`summary`:
 * exit code, an excerpt of the output, the files changed, never a file's content) and structured
 * data for the step's settlement.
 */

export interface ToolOutcome {
  isError: boolean;
  /** What the agent gets back. */
  text: string;
  /** What the log records as the result: bounded, and without a file's content. */
  summary: string;
  structured: Record<string, unknown> | null;
}

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  bytes: number;
  sha256: string | null;
}

/** How much of a file or of a command's output the agent gets back, and the log keeps. */
export const MAX_READ_BYTES = 200_000;
export const MAX_OUTPUT_BYTES = 60_000;
export const SUMMARY_OUTPUT_CHARS = 800;
const MAX_LISTED = 500;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_FILES_REPORTED = 40;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const fail = (message: string): ToolOutcome => ({
  isError: true,
  text: message,
  summary: message,
  structured: null,
});

export interface FolderToolsOptions {
  ctx: PolicyContext & { folder: string };
  /** The agent's environment (environment.ts): no credentials of the person's. */
  env: Record<string, string>;
}

export class FolderTools {
  constructor(private readonly o: FolderToolsOptions) {}

  private get folder(): string {
    return this.o.ctx.folder;
  }

  /** Runs a call the policy allowed. Never throws: a failure is an error result. */
  async run(
    verdict: Extract<ToolVerdict, { class: "read" | "change" }>,
    o: { signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<ToolOutcome> {
    const a = verdict.input;
    try {
      switch (verdict.tool.name) {
        case "read_file":
          return this.readFile(a.path as string, a.offset as number, a.limit as number);
        case "list_files":
          return this.listFiles((a.path as string | undefined) ?? ".", (a.depth as number) ?? 1);
        case "search_files":
          return this.searchFiles(a.query as string, (a.path as string | undefined) ?? ".");
        case "write_file":
          return this.writeFile(a.path as string, a.content as string);
        case "edit_file":
          return this.editFile(
            a.path as string,
            a.old_string as string,
            a.new_string as string,
            a.replace_all === true,
          );
        case "run_command":
          return await this.runCommand(
            a.command as string,
            (a.cwd as string | undefined) ?? ".",
            (a.timeout_seconds as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS,
            verdict.class === "change",
            o,
          );
      }
      return fail(`${verdict.tool.name} is not implemented`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** A path inside the folder, checked again at the moment of use. */
  private inside(path: string, base?: string): string {
    const real = confine(this.o.ctx, path, base);
    if (real === null) throw new Error(`${path} is outside the project folder`);
    return real;
  }

  private rel(real: string): string {
    return relativeToFolder(this.folder, real);
  }

  private readFile(
    path: string,
    offset: number | undefined,
    limit: number | undefined,
  ): ToolOutcome {
    const real = this.inside(path);
    const st = statSync(real);
    if (!st.isFile()) return fail(`${path} is not a file`);
    const buffer = readFileSync(real);
    if (buffer.subarray(0, 8000).includes(0)) return fail(`${path} is a binary file`);
    let text = buffer.toString("utf8");
    let note = "";
    if (offset !== undefined || limit !== undefined) {
      const lines = text.split("\n");
      const from = (offset ?? 1) - 1;
      text = lines.slice(from, limit === undefined ? undefined : from + limit).join("\n");
      note = ` lines ${from + 1} to ${Math.min(lines.length, limit === undefined ? lines.length : from + limit)} of ${lines.length}`;
    }
    let truncated = false;
    if (Buffer.byteLength(text) > MAX_READ_BYTES) {
      text = Buffer.from(text).subarray(0, MAX_READ_BYTES).toString("utf8");
      truncated = true;
    }
    const summary = `read ${this.rel(real)}${note} (${buffer.length} bytes${truncated ? `, the first ${MAX_READ_BYTES} returned` : ""})`;
    return {
      isError: false,
      text: truncated ? `${text}\n… (cut at ${MAX_READ_BYTES} bytes; use offset and limit)` : text,
      summary,
      structured: { path: this.rel(real), bytes: buffer.length, truncated },
    };
  }

  private listFiles(path: string, depth: number): ToolOutcome {
    const root = this.inside(path);
    if (!statSync(root).isDirectory()) return fail(`${path} is not a folder`);
    const entries: string[] = [];
    let more = false;
    const walk = (dir: string, level: number) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) =>
        x.name.localeCompare(y.name),
      )) {
        if (entries.length >= MAX_LISTED) {
          more = true;
          return;
        }
        const full = join(dir, e.name);
        const name = relative(root, full).split(sep).join("/");
        if (e.isDirectory()) {
          entries.push(`${name}/`);
          if (level < depth && !SKIPPED_DIRECTORIES.has(e.name)) walk(full, level + 1);
        } else entries.push(e.isSymbolicLink() ? `${name} (link)` : name);
      }
    };
    walk(root, 1);
    const text = `${entries.join("\n")}${more ? `\n… (the list stops at ${MAX_LISTED} entries)` : ""}`;
    return {
      isError: false,
      text: text === "" ? "(empty)" : text,
      summary: `listed ${this.rel(root)}: ${entries.length} entries${more ? " (cut)" : ""}`,
      structured: { path: this.rel(root), entries: entries.length, cut: more },
    };
  }

  private searchFiles(query: string, path: string): ToolOutcome {
    const root = this.inside(path);
    const needle = query.toLowerCase();
    const matches: string[] = [];
    let files = 0;
    const visit = (full: string) => {
      if (matches.length >= MAX_MATCHES) return;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        for (const e of readdirSync(full)) {
          if (!SKIPPED_DIRECTORIES.has(e)) visit(join(full, e));
        }
        return;
      }
      if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return;
      const buffer = readFileSync(full);
      if (buffer.subarray(0, 8000).includes(0)) return;
      files++;
      const lines = buffer.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        const line = lines[i] as string;
        if (line.toLowerCase().includes(needle))
          matches.push(
            `${this.rel(full)}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`,
          );
      }
    };
    if (statSync(root).isDirectory()) visit(root);
    else visit(root);
    const cut = matches.length >= MAX_MATCHES;
    return {
      isError: false,
      text:
        matches.length === 0
          ? "No matches."
          : `${matches.join("\n")}${cut ? `\n… (stopped at ${MAX_MATCHES} matches)` : ""}`,
      summary: `searched ${files} files under ${this.rel(root)}: ${matches.length} matches${cut ? " (cut)" : ""}`,
      structured: { files, matches: matches.length, cut },
    };
  }

  private writeFile(path: string, content: string): ToolOutcome {
    const real = this.inside(path);
    const before = existsSync(real) ? statSync(real) : null;
    if (before?.isDirectory()) return fail(`${path} is a folder`);
    mkdirSync(dirname(real), { recursive: true });
    // Checked again once the folders exist: a link made in between must not lead out.
    this.inside(path);
    writeAtomic(real, content);
    return this.changed([
      {
        path: this.rel(real),
        action: before === null ? "created" : "modified",
        bytes: Buffer.byteLength(content),
        sha256: sha256(content),
      },
    ]);
  }

  private editFile(path: string, oldString: string, newString: string, all: boolean): ToolOutcome {
    const real = this.inside(path);
    if (!existsSync(real) || !statSync(real).isFile()) return fail(`${path} is not a file`);
    const text = readFileSync(real, "utf8");
    const count = text.split(oldString).length - 1;
    if (count === 0) return fail(`old_string was not found in ${path}`);
    if (count > 1 && !all)
      return fail(`old_string is in ${path} ${count} times; make it longer or set replace_all`);
    const next = all
      ? text.split(oldString).join(newString)
      : text.replace(oldString, () => newString);
    writeAtomic(real, next);
    return this.changed([
      {
        path: this.rel(real),
        action: "modified",
        bytes: Buffer.byteLength(next),
        sha256: sha256(next),
      },
    ]);
  }

  private changed(files: FileChange[]): ToolOutcome {
    const list = files.map((f) => `${f.action} ${f.path} (${f.bytes} bytes)`).join(", ");
    return {
      isError: false,
      text: `Done: ${list}.`,
      summary: `${list}; sha256 ${files.map((f) => f.sha256?.slice(0, 12)).join(", ")}`,
      structured: { files },
    };
  }

  private async runCommand(
    command: string,
    cwd: string,
    timeoutSeconds: number,
    mayChange: boolean,
    o: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<ToolOutcome> {
    const base = this.inside(cwd);
    const before = mayChange ? await snapshot(this.folder, this.o.env) : null;
    const env = {
      ...this.o.env,
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      NO_COLOR: "1",
      ...(o.idempotencyKey === undefined ? {} : { DRAFT_IDEMPOTENCY_KEY: o.idempotencyKey }),
    };
    const result = await execute("/bin/sh", ["-c", command], {
      cwd: base,
      env,
      timeoutMs: timeoutSeconds * 1000,
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
    const after = before === null ? null : await snapshot(this.folder, this.o.env);
    const files = before === null || after === null ? null : diffSnapshots(before, after);
    const status = result.timedOut
      ? `timed out after ${timeoutSeconds} s`
      : result.aborted
        ? "stopped"
        : `exit code ${result.exitCode}`;
    const excerpt =
      result.output.length > SUMMARY_OUTPUT_CHARS
        ? `${result.output.slice(0, SUMMARY_OUTPUT_CHARS)}… (${result.output.length - SUMMARY_OUTPUT_CHARS} more characters)`
        : result.output;
    const changedText =
      files === null
        ? mayChange
          ? "; files changed: unknown (the folder is not a git repository)"
          : ""
        : files.length === 0
          ? "; no files changed"
          : `; files changed: ${files.slice(0, MAX_FILES_REPORTED).join(", ")}${files.length > MAX_FILES_REPORTED ? ` and ${files.length - MAX_FILES_REPORTED} more` : ""}`;
    const isError = result.timedOut || result.aborted || result.exitCode !== 0;
    return {
      isError,
      text: `${status}${changedText}\n${result.output}${result.cut ? `\n… (output cut at ${MAX_OUTPUT_BYTES} bytes)` : ""}`,
      summary: `${status}${changedText}${excerpt === "" ? "" : `; output: ${excerpt}`}`,
      structured: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        filesChanged: files,
        output: excerpt,
      },
    };
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.draft-${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644 });
  renameSync(tmp, path);
}

interface ExecResult {
  exitCode: number | null;
  output: string;
  cut: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/** Runs a program, merging stdout and stderr, with a time limit and a cap on what it keeps. */
function execute(
  program: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let cut = false;
    let timedOut = false;
    let aborted = false;
    const take = (d: Buffer) => {
      if (output.length >= MAX_OUTPUT_BYTES) {
        cut = true;
        return;
      }
      output += d.toString("utf8");
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES);
        cut = true;
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, output, cut, timedOut, aborted });
    };
    child.once("error", (err) => {
      output += `${err.message}\n`;
      done(null);
    });
    child.once("close", (code) => done(code));
  });
}

/** A file's identity for "did it change": whether it exists, its size and its modified time. */
type Snapshot = Map<string, string>;

/**
 * The files a command may have changed, as far as git can tell: the tracked files that differ and
 * the untracked ones that git doesn't ignore, each with size and modified time. Null when the
 * folder isn't a git repository: draft then says it can't list the files.
 */
async function snapshot(folder: string, env: Record<string, string>): Promise<Snapshot | null> {
  const r = await execute(
    "git",
    ["-c", "core.fsmonitor=false", "ls-files", "-m", "-o", "-d", "--exclude-standard", "-z"],
    {
      cwd: folder,
      env,
      timeoutMs: 20_000,
    },
  );
  if (r.exitCode !== 0 || r.cut) return null;
  const out: Snapshot = new Map();
  for (const name of r.output.split("\0")) {
    if (name === "") continue;
    try {
      const st = lstatSync(join(folder, name));
      out.set(name, `${st.size}:${st.mtimeMs}`);
    } catch {
      out.set(name, "gone");
    }
  }
  return out;
}

function diffSnapshots(before: Snapshot | null, after: Snapshot | null): string[] | null {
  if (before === null || after === null) return null;
  const changed = new Set<string>();
  for (const [name, id] of after) if (before.get(name) !== id) changed.add(name);
  for (const name of before.keys()) if (!after.has(name)) changed.add(name);
  return [...changed].sort();
}
