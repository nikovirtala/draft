import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The agent configuration draft owns for Kiro's sessions, and where it lives.
 *
 * Kiro CLI V3 reads custom agents from `<workspace>/.kiro/agents`, `~/.kiro/agents` and, when
 * KIRO_HOME is set, `$KIRO_HOME/agents`; a client picks one for a session with `_meta.kiro.modeId`
 * in `session/new`. The agent's `tools` field decides which tools exist for it, and permission
 * rules only decide what an existing tool may do, so a rule in the person's permissions.yaml can't
 * bring back a tool this list leaves out (https://kiro.dev/docs/custom-agents/configuration-reference/:
 * "The tools field decides which tools the agent can see and call; the permissions field decides
 * what those tools may do when called").
 *
 * draft writes this file in its own folder, which Kiro is pointed at with KIRO_HOME, and never in
 * `~/.kiro` or in a project. KIRO_HOME moves Kiro's configuration, sign-ins and sessions together
 * (https://kiro.dev/docs/reference/settings/), so the person's rules, MCP servers and steering
 * don't reach draft's sessions, and Kiro is signed in there once, on its own.
 */

export function kiroHomePaths(dataDir: string) {
  const home = join(dataDir, "kiro-home");
  return { home, agents: join(home, "agents"), nameFile: join(home, "agent-name") };
}

/**
 * The name of draft's agent in Kiro, and the mode id a session asks for. It carries a random part
 * kept in draft's data folder: over ACP Kiro loads a project's own `.kiro/agents` whether the
 * folder is trusted or not (checked on kiro-cli 3.5.0, see docs/implementation.md), and a project's
 * agent of the same name would take precedence over draft's. A project can't have an agent with a
 * name nobody has seen.
 */
export function kiroAgentName(dataDir: string): string {
  const { home, nameFile } = kiroHomePaths(dataDir);
  try {
    const known = readFileSync(nameFile, "utf8").trim();
    if (/^draft-[0-9a-f]{16}$/.test(known)) return known;
  } catch {
    // Made below.
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const name = `draft-${randomBytes(8).toString("hex")}`;
  const tmp = `${nameFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${name}\n`, { mode: 0o600 });
  renameSync(tmp, nameFile);
  return name;
}

/** The agent's file, by name. */
export const kiroAgentPath = (dataDir: string, name: string): string =>
  join(kiroHomePaths(dataDir).agents, `${name}.json`);

/**
 * The agent: no built-in tool at all. `@mcp` selects the tools of the MCP servers the session
 * brings (Kiro Remote's, and draft's own in a trusted folder); `includeMcpJson` is off so nothing
 * from an mcp.json joins them. The deny rules are a second lock: they refuse the capabilities of
 * every built-in tool that writes, runs commands or starts another agent, whatever else allows.
 */
export function kiroAgentConfig(name: string): Record<string, unknown> {
  return {
    name,
    description:
      "draft's agent: no built-in tool that changes things. It works through the tools draft gives it, which ask before they change anything.",
    tools: ["@mcp"],
    includeMcpJson: false,
    includePowers: false,
    permissions: {
      rules: [
        { capability: "fs_write", effect: "deny" },
        { capability: "shell", effect: "deny" },
        { capability: "subagent", effect: "deny" },
      ],
    },
  };
}

export const kiroAgentFile = (name: string): string =>
  `${JSON.stringify(kiroAgentConfig(name), null, 2)}\n`;

/** Whether a new session's reply says the session runs the draft agent. Unknown counts as no. */
export function sessionRunsDraftAgent(
  created: {
    modes?: { currentModeId?: string } | null;
    configOptions?: unknown;
  },
  name: string,
): boolean {
  if (created.modes?.currentModeId !== undefined) return created.modes.currentModeId === name;
  const options = Array.isArray(created.configOptions)
    ? (created.configOptions as Record<string, unknown>[])
    : [];
  const mode = options.find((o) => o?.id === "mode" || o?.category === "mode");
  return mode?.currentValue === name;
}
