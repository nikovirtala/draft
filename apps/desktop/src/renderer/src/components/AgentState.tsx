import type { ConversationState } from "../../../shared/ipc.ts";

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
      <span className={`agent-badge ${agent.state}`}>{paused ? "Paused" : "Active"}</span>
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
