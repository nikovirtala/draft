import { z } from "zod";

/**
 * Which agent a conversation runs on, and how draft starts it. An agent is configuration: a
 * command that speaks ACP over stdio. Two are built in. Anything else that speaks ACP works from
 * `config.json` without a change to draft.
 */

export const AgentSpecSchema = z
  .object({
    /** What to start: a path, or a name looked up on PATH. */
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Extra environment for this agent's process. Never put secrets here: draft stores none. */
    env: z.record(z.string(), z.string()).default({}),
    /** For a custom agent: which built-in agent it is a build of, so draft configures it the same way. */
    kind: z.enum(["kiro", "claude", "generic"]).optional(),
  })
  .strict();

export type AgentCommand = z.infer<typeof AgentSpecSchema>;

/**
 * How draft makes an agent ask before it changes anything. The agents differ, so this is per
 * kind; an agent of no known kind gets only the standard checks.
 */
export type AgentKind = "kiro" | "claude" | "generic";

export interface AgentSpec {
  /** The id used in config and in the log: "kiro", "claude", or a custom name. */
  id: string;
  kind: AgentKind;
  /** Shown in messages to the user. */
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Environment variables that must be set, passed through from draft's own environment. */
  requires: { name: string; howToSet: string }[];
  /** How to ask the command for its version, when the agent doesn't report one over ACP. */
  versionArgs: string[] | null;
  /** How to sign in, when the agent says it isn't. */
  signIn: string;
}

export const DEFAULT_AGENT = "kiro";

const BUILTIN: Record<string, Omit<AgentSpec, "id">> = {
  kiro: {
    kind: "kiro",
    label: "Kiro",
    command: "kiro-cli",
    // The v3 engine, and sign-in left to the CLI: draft never handles a Kiro credential.
    args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
    env: {},
    requires: [],
    versionArgs: ["--version"],
    signIn: "Run `kiro-cli login` in a terminal, then send your message again.",
  },
  claude: {
    kind: "claude",
    label: "Claude",
    command: "claude-agent-acp",
    args: [],
    env: {},
    requires: [
      {
        name: "ANTHROPIC_API_KEY",
        howToSet:
          "Claude runs with a Claude Console API key. Set ANTHROPIC_API_KEY in the environment you start draft from (for example `ANTHROPIC_API_KEY=… open -a draft`, or export it in your shell profile), then restart draft.",
      },
    ],
    versionArgs: null,
    signIn: "Set ANTHROPIC_API_KEY in the environment you start draft from, then restart draft.",
  },
};

export interface AgentConfig {
  /** The default agent's id. */
  agent: string;
  /** Overrides for built-in agents, and definitions of custom ones. */
  agents: Record<string, AgentCommand>;
}

/** The agent to run: the built-in or custom one named by `config.agent`, with its overrides. */
export function resolveAgent(config: AgentConfig): AgentSpec {
  const id = config.agent;
  const builtin = BUILTIN[id];
  const custom = config.agents[id];
  if (builtin === undefined && custom === undefined) {
    const known = [...new Set([...Object.keys(BUILTIN), ...Object.keys(config.agents)])];
    throw new Error(
      `unknown agent "${id}": configure it under "agents" in config.json, or use one of ${known.join(", ")}`,
    );
  }
  const base: Omit<AgentSpec, "id"> = builtin ?? {
    kind: "generic",
    label: id,
    command: "",
    args: [],
    env: {},
    requires: [],
    versionArgs: null,
    signIn:
      "Sign in to the agent the way its own documentation says, then send your message again.",
  };
  return {
    id,
    ...base,
    ...(custom === undefined
      ? {}
      : {
          command: custom.command,
          args: custom.args,
          env: { ...base.env, ...custom.env },
          ...(builtin === undefined && custom.kind !== undefined ? { kind: custom.kind } : {}),
        }),
  };
}

/** Variables that never reach an agent: draft's own settings and the Electron runtime's. */
const WITHHELD = /^(DRAFT_|ELECTRON_|NODE_OPTIONS$|OTEL_)/;

/**
 * The environment of an agent's process: draft's own environment without its settings, the agent's
 * own variables, and only the secrets the agent needs. draft stores no credential: Claude's
 * adapter reads `ANTHROPIC_API_KEY` from here, and Kiro keeps its own sign-in.
 */
export function agentEnvironment(spec: AgentSpec, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || WITHHELD.test(k)) continue;
    // A key meant for one agent isn't handed to the others.
    if (k === "ANTHROPIC_API_KEY" && !spec.requires.some((r) => r.name === k)) continue;
    out[k] = v;
  }
  return { ...out, ...spec.env };
}

/** What a missing variable means for the user, or null when everything the agent needs is set. */
export function missingRequirement(spec: AgentSpec, env: NodeJS.ProcessEnv): string | null {
  for (const r of spec.requires) {
    if ((env[r.name] ?? "") === "") return r.howToSet;
  }
  return null;
}
