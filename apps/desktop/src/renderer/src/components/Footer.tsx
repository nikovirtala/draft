import type { ConversationState } from "../../../shared/ipc.ts";
import { AgentEnvironment, AgentState } from "./AgentState.tsx";
import { ContextFolder } from "./ContextBar.tsx";
import { GlobalWorking } from "./Working.tsx";

/**
 * What a person rarely acts on, under the composer. At the left: the folder the agent works in and
 * the line about the sign-ins draft withholds from it. At the right end, against the window's
 * edge: the agent's name, its state and Pause or Play, last in the keyboard order. The top bar
 * keeps what is used all the time. `footer-activity` is the quiet place where draft shows that it is working, for work that has no
 * block of its own; it is empty otherwise.
 */
export function Footer({
  agent,
  onChange,
}: {
  agent: ConversationState["agent"];
  onChange: (state: "active" | "paused") => void;
}) {
  return (
    <footer className="footer" data-testid="footer">
      <ContextFolder />
      {agent.environment !== null && <AgentEnvironment environment={agent.environment} />}
      <span className="footer-activity" data-testid="footer-activity">
        <GlobalWorking />
      </span>
      <AgentState agent={agent} onChange={onChange} />
    </footer>
  );
}
