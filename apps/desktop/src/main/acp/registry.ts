import type { AgentDirectory, AgentRuntime } from "@nikovirtala/draft-core";
import { type AgentConfig, builtinAgentIds, resolveAgent } from "./agents.ts";
import type { AcpRuntime } from "./runtime.ts";

/**
 * The agents a thread can run on: the default, the other built-in one, and any configured under
 * `agents` in config.json. Each is one ACP agent process, started the first time a conversation
 * runs on it and shared by every conversation that chose it; each conversation keeps its own ACP
 * session on it.
 */
export class AgentRegistry implements AgentDirectory {
  readonly defaultId: string;
  private readonly runtimes = new Map<string, AcpRuntime>();

  constructor(
    private readonly config: AgentConfig,
    private readonly make: (spec: ReturnType<typeof resolveAgent>) => AcpRuntime,
  ) {
    this.defaultId = config.agent;
  }

  /** Configured ids, the default first. A built-in agent that isn't installed still lists. */
  list(): { id: string; label: string }[] {
    const ids = [
      this.defaultId,
      ...[...builtinAgentIds(), ...Object.keys(this.config.agents)].filter(
        (id) => id !== this.defaultId,
      ),
    ];
    return [...new Set(ids)].map((id) => ({
      id,
      label: resolveAgent({ agent: id, agents: this.config.agents }).label,
    }));
  }

  get(id: string): AgentRuntime {
    let r = this.runtimes.get(id);
    if (r === undefined) {
      if (!this.list().some((a) => a.id === id))
        throw new Error(`the agent "${id}" isn't configured`);
      r = this.make(resolveAgent({ agent: id, agents: this.config.agents }));
      this.runtimes.set(id, r);
    }
    return r;
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((r) => r.close()));
  }
}
