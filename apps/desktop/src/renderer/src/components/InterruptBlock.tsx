import type { Block } from "../../../shared/ipc.ts";
import { ACTIONS } from "./PromptCard.tsx";

/**
 * Something that needs a person, derived from the log. A step that started and never finished:
 * draft stopped, or lost the result, while it ran, and never runs it again, because it may
 * already have happened. Or a call the agent ran without asking: no step was started before it.
 */
export function InterruptBlock({ block }: { block: Extract<Block, { kind: "interrupt" }> }) {
  const bare = block.tool.replace(/^mcp__kiro-remote__/, "");
  const action = ACTIONS[bare] ?? bare;
  if (block.cause === "unasked-call") {
    return (
      <section
        className="interrupt"
        data-testid="interrupt"
        data-cause="unasked-call"
        aria-label="An action the agent took without asking"
      >
        <p className="prompt-title">
          The agent ran <strong>{action}</strong> without asking you first. draft records every
          action that changes something before it runs, and it didn’t get the chance to. Check what
          it did.
        </p>
        <pre className="prompt-input">{JSON.stringify(block.input, null, 2)}</pre>
        <p className="secondary">
          Seen {new Date(block.at).toLocaleString()} · no step was started
        </p>
      </section>
    );
  }
  return (
    <section
      className="interrupt"
      data-testid="interrupt"
      data-cause="unfinished-step"
      aria-label="An interrupted action"
    >
      <p className="prompt-title">
        draft stopped while the agent was trying to <strong>{action}</strong>. It may or may not
        have happened, so draft won’t run it again. Check before you ask for it again.
      </p>
      <pre className="prompt-input">{JSON.stringify(block.input, null, 2)}</pre>
      <p className="secondary">
        Started {new Date(block.at).toLocaleString()} · idempotency key{" "}
        <code>{block.idempotencyKey}</code>
      </p>
    </section>
  );
}
