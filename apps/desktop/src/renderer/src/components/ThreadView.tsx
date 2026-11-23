import { useState } from "react";
import type { SwitchPreview } from "../../../shared/ipc.ts";
import type { Entry } from "../../../shared/placement.ts";
import { useWorkspace } from "../workspace.tsx";
import { AgentState, agentName } from "./AgentState.tsx";
import { ConversationView } from "./ConversationView.tsx";
import { EndThread } from "./EndThread.tsx";
import { BlockControls } from "./Icons.tsx";
import { useSelectable } from "./selectable.ts";

/**
 * What switching to another agent starts from, shown before the person decides: counts and
 * characters, as far as draft can measure them. The new session starts from the log, not from
 * anything the other agent remembers.
 */
function SwitchCard({
  preview,
  onAnswer,
}: {
  preview: SwitchPreview;
  onAnswer: (go: boolean) => void;
}) {
  const s = preview.size;
  return (
    <section
      className="prompt switch"
      data-fill="ask"
      data-testid="switch-card"
      aria-label="Switch agent"
    >
      <p className="prompt-title">
        Switch this thread from <strong>{agentName(preview.from)}</strong> to{" "}
        <strong>{agentName(preview.to)}</strong>?
      </p>
      <p className="secondary" data-testid="switch-size">
        The new session starts from the log: {s.messages}{" "}
        {s.messages === 1 ? "message" : "messages"}, {s.openItems} open{" "}
        {s.openItems === 1 ? "item" : "items"}, {s.decisions}{" "}
        {s.decisions === 1 ? "decision" : "decisions"} and {s.references}{" "}
        {s.references === 1 ? "reference" : "references"}: about {s.characters.toLocaleString()}{" "}
        characters, plus its first message.
      </p>
      <div className="prompt-actions">
        <button type="button" className="secondary-button" onClick={() => onAnswer(false)}>
          Keep {agentName(preview.from)}
        </button>
        <button
          type="button"
          className="primary-button"
          data-fill="action"
          onClick={() => onAnswer(true)}
        >
          Switch
        </button>
      </div>
    </section>
  );
}

/** A thread in full, in the panel or its own window: its header, its agent, and its conversation. */
export function ThreadView({ entry }: { entry: Entry }) {
  const ws = useWorkspace();
  const conversation = entry.info.opens as string;
  const thread = ws.threadOf(conversation);
  const state = ws.states[conversation];
  const selectable = useSelectable(entry.info.address, conversation);
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (thread === undefined || state === undefined) return null;
  const choose = (agent: string) => {
    setError(null);
    if (agent === thread.agent) return setPreview(null);
    window.draft.previewSwitch(conversation, agent).then(setPreview, (e: unknown) => {
      setError(e instanceof Error ? e.message : "couldn't measure the switch");
    });
  };
  return (
    <section
      {...selectable}
      className="block-full thread-view"
      data-testid="block-full"
      data-kind="thread"
      data-block={entry.info.address}
      aria-label={`Thread ${thread.title}`}
    >
      <header className="block-header">
        <div className="stub-line">
          <span className="thread-mark" aria-hidden="true">
            ↳
          </span>
          <span className="stub-title" data-testid="panel-title">
            {thread.title}
          </span>
          <span className="spacer" />
          <BlockControls entry={entry} />
        </div>
        <div className="thread-agent-row">
          <select
            aria-label="Agent for this thread"
            data-testid="thread-agent"
            value={thread.agent}
            disabled={state.busy}
            onChange={(e) => choose(e.target.value)}
          >
            {ws.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {agentName(a.id)}
              </option>
            ))}
          </select>
          <AgentState
            agent={state.agent}
            onChange={(s) => void window.draft.setAgentState(conversation, s)}
          />
        </div>
        <div className="thread-actions">
          <button
            type="button"
            className="agent-toggle"
            data-testid="wrap-up"
            disabled={
              state.busy ||
              state.thread === null ||
              state.thread.state === "wrapped-up" ||
              state.thread.state === "superseded" ||
              state.thread.state === "withdrawn"
            }
            title="Ask the agent to draft this thread's conclusion for the main conversation"
            onClick={() => void window.draft.wrapUp(conversation)}
          >
            Wrap up
          </button>
          {state.thread !== null &&
            !["wrapped-up", "superseded", "withdrawn"].includes(state.thread.state) && (
              <EndThread conversation={conversation} />
            )}
        </div>
        {error !== null && (
          <p className="error" data-fill="notice" role="alert">
            {error}
          </p>
        )}
        {preview !== null && (
          <SwitchCard
            preview={preview}
            onAnswer={(go) => {
              setPreview(null);
              if (go) {
                window.draft.switchAgent(conversation, preview.to).catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : "couldn't switch");
                });
              }
            }}
          />
        )}
      </header>
      <ConversationView conversation={conversation} />
    </section>
  );
}
