import type { Prompt } from "../../../shared/ipc.ts";

export const ACTIONS: Record<string, string> = {
  kiro_launch_session: "launch a Kiro session",
  kiro_adopt_session: "adopt a Kiro session",
  kiro_send_prompt: "send a prompt to a Kiro session",
  kiro_answer_permission: "answer a permission request",
  kiro_set_config: "change a session's configuration",
  kiro_link_pull_request: "link a pull request to a session",
  kiro_unlink_pull_request: "unlink a pull request from a session",
  kiro_cancel_turn: "cancel a session's running turn",
  kiro_delete_session: "delete a Kiro session",
  // draft's own tools for the project folder (agent-tools.ts in core)
  write_file: "write a file in the project folder",
  edit_file: "edit a file in the project folder",
  run_command: "run a command in the project folder",
};

/** The confirm prompt for a tool that changes things, inside the conversation. */
export function PromptCard({
  prompt,
  onAnswer,
}: {
  prompt: Prompt;
  onAnswer: (allow: boolean) => void;
}) {
  const bare = prompt.tool.replace(/^mcp__(kiro-remote|draft)__/, "");
  return (
    <section
      className="prompt"
      data-fill="ask"
      data-testid="prompt"
      data-key={prompt.id}
      aria-label="The agent asks for permission"
    >
      <p className="prompt-title">
        The agent wants to <strong>{ACTIONS[bare] ?? bare}</strong>.
      </p>
      <pre className="prompt-input">{JSON.stringify(prompt.input, null, 2)}</pre>
      <div className="prompt-actions">
        <button type="button" className="secondary-button" onClick={() => onAnswer(false)}>
          Don’t allow
        </button>
        <button
          type="button"
          className="primary-button"
          data-fill="action"
          onClick={() => onAnswer(true)}
        >
          Allow
        </button>
      </div>
    </section>
  );
}
