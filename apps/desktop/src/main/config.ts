import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type AgentSpec, AgentSpecSchema, DEFAULT_AGENT, resolveAgent } from "./acp/agents.ts";

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
  /** The agent conversations run on, and how to start it. */
  agent: AgentSpec;
  /**
   * Where the agent starts: a dedicated directory under the data directory, never a user
   * repository. Kiro treats a folder nobody trusted as untrusted, so it asks before every shell
   * command and MCP call there.
   */
  agentCwd: string;
  pollBaseMs: number;
  pollMaxMs: number;
}

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
    agentCwd: join(dataDir, "agent-workspace"),
    pollBaseMs: Number(env.DRAFT_POLL_BASE_MS ?? 2000),
    pollMaxMs: Number(env.DRAFT_POLL_MAX_MS ?? 60_000),
  };
}
