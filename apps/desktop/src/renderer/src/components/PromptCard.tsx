import type { Prompt } from "../../../shared/ipc.ts";

const ACTIONS: Record<string, string> = {
  kiro_launch_session: "launch a Kiro session",
  kiro_adopt_session: "adopt a Kiro session",
  kiro_send_prompt: "send a prompt to a Kiro session",
  kiro_answer_permission: "answer a permission request",
  kiro_set_config: "change a session's configuration",
  kiro_link_pull_request: "link a pull request to a session",
  kiro_unlink_pull_request: "unlink a pull request from a session",
  kiro_cancel_turn: "cancel a session's running turn",
  kiro_delete_session: "delete a Kiro session",
};

/** The confirm prompt for a tool that changes things, inside the conversation. */
export function PromptCard({
  prompt,
  onAnswer,
}: {
  prompt: Prompt;
  onAnswer: (allow: boolean) => void;
}) {
  const bare = prompt.tool.replace(/^mcp__kiro-remote__/, "");
  return (
    <section className="prompt" data-testid="prompt" aria-label="The agent asks for permission">
      <p className="prompt-title">
        The agent wants to <strong>{ACTIONS[bare] ?? bare}</strong>.
      </p>
      <pre className="prompt-input">{JSON.stringify(prompt.input, null, 2)}</pre>
      <div className="prompt-actions">
        <button type="button" className="secondary-button" onClick={() => onAnswer(false)}>
          Don’t allow
        </button>
        <button type="button" className="primary-button" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </section>
  );
}
