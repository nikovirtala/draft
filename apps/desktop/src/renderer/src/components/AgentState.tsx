import type { ConversationState, AgentEnvironment as Environment } from "../../../shared/ipc.ts";

/** A short name for an agent by its configured id. */
export function agentName(id: string): string {
  const names: Record<string, string> = { kiro: "Kiro", claude: "Claude", fake: "the agent" };
  return names[id] ?? id;
}

/** A short name for the agent: its configured id, and the model it reports. */
export function agentLabel(agent: ConversationState["agent"]): string {
  return agentName(agent.id);
}

/** The agent's name, its state, and the control that pauses or plays it. */
export function AgentState({
  agent,
  onChange,
}: {
  agent: ConversationState["agent"];
  onChange: (state: "active" | "paused") => void;
}) {
  const paused = agent.state === "paused";
  const model = agent.model === "unreported" ? null : agent.model;
  return (
    <div className="agent-state" data-testid="agent-state" data-state={agent.state}>
      <span className="agent-name" title={agent.version}>
        {agentLabel(agent)}
        {model === null ? "" : <span className="agent-model"> · {model}</span>}
      </span>
      <span className={`agent-badge ${agent.state}`} data-fill="chip">
        {paused ? "Paused" : "Active"}
      </span>
      <button
        type="button"
        className="agent-toggle"
        aria-label={paused ? "Play the agent" : "Pause the agent"}
        title={
          paused ? "Play: the agent reads and answers again" : "Pause: the agent stops reading"
        }
        onClick={() => onChange(paused ? "active" : "paused")}
      >
        {paused ? "Play" : "Pause"}
      </button>
    </div>
  );
}

const GROUPS: Record<string, string> = {
  github: "GitHub",
  git: "git",
  ssh: "SSH",
  aws: "AWS",
  npm: "npm and package registries",
  draft: "draft's own settings",
  "other-agent": "another agent's key",
};

/**
 * One line saying the person's sign-ins are withheld from the agent, and on demand which variables
 * were (names only), what draft set instead, and any exception the person configured.
 */
export function AgentEnvironment({ environment }: { environment: Environment }) {
  const byGroup = new Map<string, string[]>();
  for (const w of environment.withheld) {
    byGroup.set(w.group, [...(byGroup.get(w.group) ?? []), w.name]);
  }
  const exceptions = environment.passed.length > 0;
  return (
    <details className="agent-environment" data-testid="agent-environment">
      <summary data-testid="agent-environment-summary">
        Your GitHub, git, SSH, AWS and npm sign-ins are withheld from the agent
        {exceptions ? `, except what you pass with passEnv: ${environment.passed.join(", ")}` : ""}
      </summary>
      <div className="agent-environment-list" data-testid="agent-environment-list">
        {byGroup.size === 0 && <p>None of your environment variables carried one.</p>}
        {[...byGroup].map(([group, names]) => (
          <p key={group}>
            <strong>{GROUPS[group] ?? group}:</strong> {names.join(", ")}
          </p>
        ))}
        <p>
          Set by draft instead, so the agent's tools find nothing:{" "}
          {environment.overridden.join(", ")}
        </p>
        {exceptions && (
          <p>
            Passed on purpose (<code>passEnv</code> in config.json): {environment.passed.join(", ")}
          </p>
        )}
        {environment.refused.length > 0 && (
          <p>Never passed, because they are draft's own: {environment.refused.join(", ")}</p>
        )}
      </div>
    </details>
  );
}
