import type { Block } from "../../../shared/ipc.ts";
import { ACTIONS } from "./PromptCard.tsx";

/**
 * A step that started and never finished: draft stopped, or lost the result, while it ran. draft
 * never runs it again, because it may already have happened.
 */
export function InterruptBlock({ block }: { block: Extract<Block, { kind: "interrupt" }> }) {
  const bare = block.tool.replace(/^mcp__kiro-remote__/, "");
  return (
    <section className="interrupt" data-testid="interrupt" aria-label="An interrupted action">
      <p className="prompt-title">
        draft stopped while the agent was trying to <strong>{ACTIONS[bare] ?? bare}</strong>. It may
        or may not have happened, so draft won’t run it again. Check before you ask for it again.
      </p>
      <pre className="prompt-input">{JSON.stringify(block.input, null, 2)}</pre>
      <p className="secondary">
        Started {new Date(block.at).toLocaleString()} · idempotency key{" "}
        <code>{block.idempotencyKey}</code>
      </p>
    </section>
  );
}
