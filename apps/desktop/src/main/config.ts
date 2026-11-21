import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentConfig,
  type AgentSpec,
  AgentSpecSchema,
  DEFAULT_AGENT,
  resolveAgent,
} from "./acp/agents.ts";

/**
 * draft's configuration: `config.json` in the data directory, overridden by environment
 * variables. draft stores no secrets: Kiro keeps its own sign-in, the Claude adapter reads
 * `ANTHROPIC_API_KEY` from the environment draft is started from, and Kiro Remote tokens come
 * from the OAuth sign-in (kept in safeStorage).
 */
const FileConfigSchema = z
  .object({
    kiroRemoteUrl: z.url().optional(),
    /** The agent conversations run on: "kiro" (the default), "claude", or one defined in `agents`. */
    agent: z.string().min(1).optional(),
    /** How to start an agent: overrides for "kiro" and "claude", and any other ACP agent. */
    agents: z.record(z.string().min(1), AgentSpecSchema).optional(),
    /** Set by the first slice and ignored now: the agent reports the model it runs. */
    model: z.string().optional(),
    /**
     * ark issue logs by the source name that references use (`draft:15cxvdep`), as the
     * `[[sources]]` of ark's tools name them: the name, then `owner/repo`.
     */
    arkSources: z
      .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), z.string().regex(/^[^/\s]+\/[^/\s]+$/))
      .optional(),
    /** A repository's git remote, when it isn't `https://github.com/<owner>/<repo>.git`. */
    gitRemotes: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/), z.string().min(1)).optional(),
    /** Where the local artifact server runs (nikovirtala/artifact); `http://localhost:4400` by default. */
    artifactUrl: z.url().optional(),
    /** The local identity, written on the first run (see identity.ts). */
    user: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  })
  .strict();

export interface Config {
  dataDir: string;
  /** Kiro Remote's base URL; its MCP endpoint is `<base>/mcp`. Unset: no Kiro tools. */
  kiroRemoteUrl: string | null;
  /** "oauth" for the real service; "none" for a local fake without sign-in. */
  kiroAuth: "oauth" | "none";
  /** The default agent, and how to start it. */
  agent: AgentSpec;
  /** Every agent a thread can run on: the default's id and the configured definitions. */
  agentConfig: AgentConfig;
  /**
   * Where the agent starts: a dedicated directory under the data directory, never a user
   * repository. Kiro treats a folder nobody trusted as untrusted, so it asks before every shell
   * command and MCP call there.
   */
  agentCwd: string;
  pollBaseMs: number;
  pollMaxMs: number;
  /** ark issue logs by source name, for references like `draft:15cxvdep`. */
  arkSources: Record<string, string>;
  /** The artifact server whose page links draft shows as live stubs. */
  artifactUrl: string;
  /** GitHub's API; only a test points it elsewhere. */
  githubApiUrl: string;
  /**
   * The person's own tools for carrying out an acceptance: `gh` and `adr` as commands (null: found
   * on the PATH) and the git remotes of repositories. Tests point them at fakes.
   */
  person: { gh: string[] | null; adr: string[] | null; gitRemotes: Record<string, string> };
}

const Argv = z.array(z.string()).min(1);

export function loadConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = join(dataDir, "config.json");
  const fromFile = existsSync(file)
    ? FileConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : {};
  const id = env.DRAFT_AGENT ?? fromFile.agent ?? DEFAULT_AGENT;
  const agents = { ...(fromFile.agents ?? {}) };
  // The command of the selected agent from the environment: for tests, and for a one-off launch.
  if (env.DRAFT_AGENT_COMMAND !== undefined) {
    const args =
      env.DRAFT_AGENT_ARGS === undefined
        ? []
        : z.array(z.string()).parse(JSON.parse(env.DRAFT_AGENT_ARGS));
    agents[id] = AgentSpecSchema.parse({
      command: env.DRAFT_AGENT_COMMAND,
      args,
      env: agents[id]?.env ?? {},
    });
  }
  return {
    dataDir,
    kiroRemoteUrl: env.DRAFT_KIRO_REMOTE_URL ?? fromFile.kiroRemoteUrl ?? null,
    kiroAuth: env.DRAFT_KIRO_AUTH === "none" ? "none" : "oauth",
    agent: resolveAgent({ agent: id, agents }),
    agentConfig: { agent: id, agents },
    agentCwd: join(dataDir, "agent-workspace"),
    arkSources: fromFile.arkSources ?? { draft: "nikovirtala/draft", ark: "nikovirtala/ark" },
    artifactUrl: env.DRAFT_ARTIFACT_URL ?? fromFile.artifactUrl ?? "http://localhost:4400",
    githubApiUrl: env.DRAFT_GITHUB_API_URL ?? "https://api.github.com",
    person: {
      gh: env.DRAFT_GH_COMMAND === undefined ? null : Argv.parse(JSON.parse(env.DRAFT_GH_COMMAND)),
      adr:
        env.DRAFT_ADR_COMMAND === undefined ? null : Argv.parse(JSON.parse(env.DRAFT_ADR_COMMAND)),
      gitRemotes: {
        ...(fromFile.gitRemotes ?? {}),
        ...(env.DRAFT_GIT_REMOTES === undefined
          ? {}
          : z.record(z.string(), z.string()).parse(JSON.parse(env.DRAFT_GIT_REMOTES))),
      },
    },
    pollBaseMs: Number(env.DRAFT_POLL_BASE_MS ?? 2000),
    pollMaxMs: Number(env.DRAFT_POLL_MAX_MS ?? 60_000),
  };
}
