import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * draft's own tools for the agent: the file and shell tools of a trusted folder (issue aefrmdf4).
 *
 * In draft's sessions the agent has no built-in tool that changes things (ADR on running the agent
 * without them). What it has instead is this registry, served by draft's MCP server. Every tool
 * is one entry; `toolPolicy` is the one function that says what a call is, and it is pure over
 * its inputs: a tool, an input and a context (the trusted folder and a way to resolve real paths).
 * New tools add an entry here and never a second path:
 *
 * - `read`: runs without asking and is logged.
 * - `change`: is a step. It asks the person first, runs only on yes, and records its result.
 * - `refused`: never runs. It says why, to the agent.
 *
 * The instructions the agent gets (`toolsBriefing`) are derived from the same registry, so they
 * can't disagree with what it can call.
 */

/** The name draft's MCP server has in a session; the Agent SDK prefixes tools with it. */
export const DRAFT_SERVER = "draft";

/** The tool name as logged and as the Agent SDK spells it. */
export const draftToolName = (bare: string): string => `mcp__${DRAFT_SERVER}__${bare}`;

/** The bare tool name from either the bare or the prefixed spelling, when it is a draft tool. */
export function bareDraftToolName(name: string): string | null {
  const prefix = `mcp__${DRAFT_SERVER}__`;
  const bare = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return DRAFT_TOOLS.some((t) => t.name === bare) ? bare : null;
}

/** How a tool treats the folder, before its input is looked at. */
export type ToolAccess = "read" | "change" | "command";

export interface DraftTool {
  /** The bare name the agent calls. */
  name: string;
  /** Said to the person, in the prompt that asks. */
  title: string;
  /** Said to the agent, in the tool's description. */
  description: string;
  access: ToolAccess;
  input: z.ZodType<Record<string, unknown>>;
}

export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 600;

const path = z.string().min(1).max(4096);

export const DRAFT_TOOLS: readonly DraftTool[] = [
  {
    name: "read_file",
    title: "read a file",
    description:
      "Read a text file in the project folder. `offset` and `limit` are line numbers (1-based) for a part of a long file.",
    access: "read",
    input: z.object({
      path,
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }),
  },
  {
    name: "list_files",
    title: "list files",
    description:
      "List the files and folders in a folder of the project, `depth` levels down (default 1, at most 4).",
    access: "read",
    input: z.object({
      path: path.optional(),
      depth: z.number().int().min(1).max(4).optional(),
    }),
  },
  {
    name: "search_files",
    title: "search files",
    description:
      "Search the project's text files for a plain string (not a regular expression), case-insensitively. For a regular expression, run `rg`.",
    access: "read",
    input: z.object({ query: z.string().min(1).max(500), path: path.optional() }),
  },
  {
    name: "write_file",
    title: "write a file",
    description:
      "Create a file in the project folder, or replace its whole content. The user is asked first.",
    access: "change",
    input: z.object({ path, content: z.string().max(2_000_000) }),
  },
  {
    name: "edit_file",
    title: "edit a file",
    description:
      "Replace text in a file of the project folder. `old_string` must match exactly once unless `replace_all` is set. The user is asked first.",
    access: "change",
    input: z.object({
      path,
      old_string: z.string().min(1).max(500_000),
      new_string: z.string().max(500_000),
      replace_all: z.boolean().optional(),
    }),
  },
  {
    name: "run_command",
    title: "run a command",
    description: `Run a command with sh in the project folder (or a folder below it), for at most \`timeout_seconds\` (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}). Read-only commands from a short list run at once; every other command asks the user first. The command has no access to the user's GitHub, git, SSH, AWS or npm sign-ins.`,
    access: "command",
    input: z.object({
      command: z.string().min(1).max(10_000),
      cwd: path.optional(),
      timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
    }),
  },
];

/** Folders the agent never writes into: what another tool of the person's would run from. */
export const PROTECTED_DIRECTORIES: readonly string[] = [".git", ".kiro", ".claude", ".vscode"];

/* ----------------------------------------------------------------------------------------------- */
/* The command allowlist: the one place that decides a command only reads                           */
/* ----------------------------------------------------------------------------------------------- */

export interface ReadOnlyCommand {
  /** For a program with subcommands: the ones that only read. The subcommand comes first. */
  subcommands?: readonly string[];
  /** Flags that make the command change something, run another program or follow a link out. */
  forbidden: readonly string[];
}

/**
 * Programs, and for `git` the subcommands, that run without asking. A command is read-only only if
 * it is a single plain command (no pipe, redirect, substitution, expansion or chaining), its
 * program is here, and none of its arguments names a path outside the folder or a forbidden flag.
 * Anything else asks. An environment assignment in front, or a path to the program, never matches.
 */
export const READ_ONLY_COMMANDS: Readonly<Record<string, ReadOnlyCommand>> = {
  git: {
    subcommands: [
      "status",
      "log",
      "diff",
      "show",
      "blame",
      "ls-files",
      "ls-tree",
      "rev-parse",
      "describe",
      "shortlog",
    ],
    // --output writes a file, --ext-diff and --textconv run configured programs, the rest read
    // outside the folder or open a pager program.
    forbidden: [
      "--output",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--git-dir",
      "--work-tree",
      "--exec-path",
      "--open-files-in-pager",
    ],
  },
  ls: { forbidden: [] },
  pwd: { forbidden: [] },
  cat: { forbidden: [] },
  head: { forbidden: [] },
  tail: { forbidden: ["-f", "-F", "--follow"] },
  wc: { forbidden: [] },
  file: { forbidden: [] },
  stat: { forbidden: [] },
  // --pre and --search-zip run another program, -L and --follow leave the folder through a link.
  rg: {
    forbidden: [
      "--pre",
      "--pre-glob",
      "-z",
      "--search-zip",
      "--hostname-bin",
      "-L",
      "--follow",
      "--ignore-file",
    ],
  },
  grep: { forbidden: ["-R", "--dereference-recursive", "-D", "--devices"] },
};

/** The commands that run without asking, as said to the agent and the person. */
export function readOnlyCommandSummary(): string {
  return Object.entries(READ_ONLY_COMMANDS)
    .map(([program, rule]) =>
      rule.subcommands === undefined
        ? program
        : rule.subcommands.map((s) => `${program} ${s}`).join(", "),
    )
    .join(", ");
}

/**
 * Splits a command into words when it is one plain command, and returns null for anything a shell
 * would do more with: operators, redirects, substitution, globs, expansion, comments, escapes. A
 * quoted word is literal: single quotes keep everything, double quotes keep everything except `$`,
 * backquote, backslash and `!`.
 */
export function plainCommandWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (ch === "\0") return null;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (quote === '"' && "$`\\!".includes(ch)) return null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    if ("\n\r;&|<>()$`\\*?[]{}#!".includes(ch)) return null;
    // A tilde expands only at the start of a word: `HEAD~1` is plain.
    if (ch === "~" && !inWord) return null;
    current += ch;
    inWord = true;
  }
  if (quote !== null) return null;
  if (inWord) words.push(current);
  return words.length === 0 ? null : words;
}

/* ----------------------------------------------------------------------------------------------- */
/* Paths                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

/**
 * The real path of a path that may not exist yet: the real path of its deepest existing ancestor,
 * then the rest. Null when nothing can be resolved. Symlinks along the way are followed, so a
 * link that leaves the folder resolves outside it.
 */
export function realpathLoose(p: string): string | null {
  const rest: string[] = [];
  let current = resolve(p);
  for (;;) {
    try {
      return rest.length === 0 ? realpathSync(current) : join(realpathSync(current), ...rest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !isNotDirectory(err)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function isNotDirectory(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOTDIR";
}

/** What `toolPolicy` knows of the world: the trusted folder and how paths resolve. */
export interface PolicyContext {
  /** The real path of the folder the person trusted for this context; null when there is none. */
  folder: string | null;
  /** Resolves a path to its real path, even when it doesn't exist yet. Default: `realpathLoose`. */
  realpath?: (p: string) => string | null;
  /** Whether a path exists, for arguments of a command. Default: `fs.existsSync`. */
  exists?: (p: string) => boolean;
}

export function isInside(folder: string, real: string): boolean {
  if (real === folder) return true;
  const rel = relative(folder, real);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * The absolute path inside the folder that `input` names (relative to `base`, which is the folder
 * or a folder below it), or null when it resolves outside, through a link or not.
 */
export function confine(ctx: PolicyContext, input: string, base?: string): string | null {
  if (ctx.folder === null) return null;
  const real = (ctx.realpath ?? realpathLoose)(resolve(base ?? ctx.folder, input));
  return real !== null && isInside(ctx.folder, real) ? real : null;
}

/** The folder-relative path, for a message, a log and a prompt: never the person's absolute path. */
export function relativeToFolder(folder: string, real: string): string {
  const r = relative(folder, real);
  return r === "" ? "." : r.split(sep).join("/");
}

function inProtectedDirectory(folder: string, real: string): boolean {
  const first = relative(folder, real).split(sep)[0] ?? "";
  return PROTECTED_DIRECTORIES.includes(first);
}

/* ----------------------------------------------------------------------------------------------- */
/* The policy                                                                                       */
/* ----------------------------------------------------------------------------------------------- */

export type ToolVerdict =
  | { class: "read" | "change"; tool: DraftTool; input: Record<string, unknown> }
  | { class: "refused"; reason: string };

const refuse = (reason: string): ToolVerdict => ({ class: "refused", reason });

/**
 * What a call to one of draft's tools is. Pure over its arguments: it reads no file but through
 * `ctx.realpath` and `ctx.exists`, and it runs nothing.
 *
 * - No trusted folder: every tool is refused.
 * - A path outside the folder, or resolving outside it through a symlink: refused.
 * - A write or edit under `.git`, `.kiro`, `.claude` or `.vscode`: refused.
 * - A command is a read only if it is on the allowlist (`READ_ONLY_COMMANDS`) with every path
 *   argument inside the folder; any other command is a change.
 */
export function toolPolicy(tool: string, input: unknown, ctx: PolicyContext): ToolVerdict {
  const bare = bareDraftToolName(tool);
  const def = DRAFT_TOOLS.find((t) => t.name === bare);
  if (def === undefined) return refuse(`${tool} is not one of draft's tools`);
  if (ctx.folder === null)
    return refuse("this context has no folder the user trusted, so there are no file tools");
  const parsed = def.input.safeParse(input ?? {});
  if (!parsed.success)
    return refuse(
      `the input of ${def.name} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`,
    );
  const args = parsed.data;
  const outside = (p: unknown) =>
    refuse(`${String(p)} is outside the project folder, which is all draft's tools reach`);

  switch (def.name) {
    case "read_file":
    case "list_files":
    case "search_files": {
      const p = (args.path as string | undefined) ?? ".";
      return confine(ctx, p) === null ? outside(p) : { class: "read", tool: def, input: args };
    }
    case "write_file":
    case "edit_file": {
      const p = args.path as string;
      const real = confine(ctx, p);
      if (real === null) return outside(p);
      if (inProtectedDirectory(ctx.folder, real))
        return refuse(
          `${p} is inside a folder draft doesn't let the agent write to (${PROTECTED_DIRECTORIES.join(", ")}): other tools of the user run what is in them`,
        );
      return { class: "change", tool: def, input: args };
    }
    case "run_command": {
      const cwd = (args.cwd as string | undefined) ?? ".";
      const base = confine(ctx, cwd);
      if (base === null) return outside(cwd);
      return {
        class: isReadOnlyCommand(args.command as string, base, ctx) ? "read" : "change",
        tool: def,
        input: args,
      };
    }
  }
  return refuse(`${def.name} has no policy`);
}

/** Whether a command only reads, by the allowlist, from the folder `base` inside the context's. */
export function isReadOnlyCommand(command: string, base: string, ctx: PolicyContext): boolean {
  if (ctx.folder === null) return false;
  const words = plainCommandWords(command);
  const program = words?.[0];
  if (words === null || program === undefined) return false;
  const rule = READ_ONLY_COMMANDS[program];
  if (rule === undefined || !Object.hasOwn(READ_ONLY_COMMANDS, program)) return false;
  let args = words.slice(1);
  if (rule.subcommands !== undefined) {
    const sub = args[0];
    if (sub === undefined || !rule.subcommands.includes(sub)) return false;
    args = args.slice(1);
  }
  const exists = ctx.exists ?? existsSync;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      const flag = arg.split("=")[0] ?? arg;
      if (rule.forbidden.includes(flag)) return false;
      // A flag that carries a path, or a combined short flag that includes a forbidden one.
      if (/[/~]|\.\./.test(arg)) return false;
      if (!arg.startsWith("--") && [...arg.slice(1)].some((c) => rule.forbidden.includes(`-${c}`)))
        return false;
      continue;
    }
    const names =
      isAbsolute(arg) ||
      arg.startsWith("~") ||
      arg.split("/").includes("..") ||
      exists(resolve(base, arg));
    if (names && confine(ctx, arg, base) === null) return false;
  }
  return true;
}

/* ----------------------------------------------------------------------------------------------- */
/* What the agent is told, and what it is offered                                                   */
/* ----------------------------------------------------------------------------------------------- */

/** The tools a session offers: draft's, when the agent can't use its own and a folder is trusted. */
export function offeredTools(o: {
  /** Whether the agent is one whose built-in tools draft takes away (Kiro, Claude). */
  builtinsRemoved: boolean;
  /** Whether the agent can reach an HTTP MCP server. */
  http: boolean;
  /** The trusted folder, or null. */
  folder: string | null;
}): readonly DraftTool[] {
  return o.builtinsRemoved && o.http && o.folder !== null ? DRAFT_TOOLS : [];
}

const STILL_DECIDING_BRIEFING =
  "A call that asks the user may come back saying the user hasn't answered yet. Then call the same tool again with exactly the same arguments: draft asks the user once, runs the call once, and the repeated call returns its result. That answer is not a failure, so don't change the call or give up on it.";

/**
 * What the agent is told about its tools besides Kiro Remote's. Derived from the tools the session
 * offers: none, or draft's file and shell tools. A built-in call that changes something and runs
 * without asking is a call without asking, and is said to be wrong.
 */
export function toolsBriefing(tools: readonly DraftTool[]): string {
  const unasked =
    "If a tool of your own (not one named here) ever changes a file or runs a command without asking, that is a fault: draft records it as a call without permission and shows it to the user, who could not answer it before it ran. Don't use such a tool.";
  if (tools.length === 0)
    return `- You have no other tools in draft: no file or shell access.\n- ${unasked}`;
  const reads = tools.filter((t) => t.access === "read").map((t) => t.name);
  const changes = tools.filter((t) => t.access !== "read").map((t) => t.name);
  return `- Besides those you have draft's own tools for the project folder, served by the MCP server "${DRAFT_SERVER}", and no others: ${tools.map((t) => t.name).join(", ")}. They reach only the project folder.
- ${reads.join(", ")} read, run at once and are logged. ${changes.join(", ")} ask the user first and run only if the user says yes; draft records each as a step with its result. run_command runs without asking only for these read-only commands: ${readOnlyCommandSummary()}. Every other command asks.
${changes.length === 0 ? "" : `- ${STILL_DECIDING_BRIEFING}\n`}- Commands run without the user's GitHub, git, SSH, AWS or npm sign-ins, so \`git push\` and \`gh\` fail. Writes under ${PROTECTED_DIRECTORIES.join(", ")} are refused.
- ${unasked}`;
}

/** The input of a call as it is logged and shown: a file's content is a preview and a digest. */
export function loggedInput(
  input: Record<string, unknown>,
  digest: (s: string) => string,
  max = 2000,
): Record<string, unknown> {
  const clip = (s: string) =>
    s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
  const out: Record<string, unknown> = { ...input };
  for (const key of ["content", "old_string", "new_string"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > max) {
      out[key] = clip(v);
      out[`${key}_sha256`] = digest(v);
      out[`${key}_characters`] = v.length;
    }
  }
  return out;
}
