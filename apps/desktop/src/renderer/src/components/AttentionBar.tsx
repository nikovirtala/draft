import { useRef } from "react";
import { ageText, CAUSE_LABELS } from "../../../shared/attention.ts";
import { attentionText } from "../../../shared/placement.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * What needs a person, counted once for all conversations and in one order. In focus it reads "N
 * in focus, M elsewhere": only the focused conversation shows its interrupts in full, the rest
 * only count. The list under it is the whole order: permission requests, failures, what is left
 * to resolve, then reviews, oldest first, each with the conversation it is in. Each item is a
 * button that goes to what it counts, the way an item of the map does: click or Enter.
 */
export function AttentionBar() {
  const ws = useWorkspace();
  const list = useRef<HTMLDetailsElement>(null);
  const focus = ws.view.layout.focus;
  const text = attentionText(ws.attentionCount, focus !== null);
  const title =
    focus === null ? null : (ws.view.layout.blocks[focus.block ?? ""]?.info.title ?? null);
  if (focus === null && text === "") return null;
  const nameOf = (conversation: string) =>
    conversation === ws.main
      ? "Main conversation"
      : (ws.threads.find((t) => t.conversation === conversation)?.title ?? "A thread");
  const perConversation = new Map<string, number>();
  for (const a of ws.attention)
    perConversation.set(a.conversation, (perConversation.get(a.conversation) ?? 0) + 1);
  return (
    <div className="attention" data-testid="attention" data-focused={focus !== null}>
      {focus !== null && (
        <span className="focus-mark" data-testid="focus-mark">
          In focus{title === null ? "" : `: ${title}`} · Esc leaves
        </span>
      )}
      <details className="attention-list-wrap" ref={list}>
        <summary data-testid="attention-count">{text}</summary>
        <div className="attention-list" data-testid="attention-list">
          <p className="secondary">
            {[...perConversation].map(([c, n]) => `${nameOf(c)}: ${n}`).join(" · ")}
          </p>
          <ol>
            {ws.attention.map((a) => (
              <li
                key={`${a.conversation}:${a.id}`}
                data-testid="attention-item"
                data-cause={a.cause}
              >
                <button
                  type="button"
                  className="attention-open"
                  data-fill="pointer"
                  data-testid="attention-open"
                  onClick={() => {
                    if (list.current !== null) list.current.open = false;
                    void ws.openAttention(a);
                  }}
                >
                  <span className="chip" data-fill="chip">
                    {CAUSE_LABELS[a.cause]}
                  </span>{" "}
                  {nameOf(a.conversation)} <span className="secondary">· {ageText(a.at)}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </details>
    </div>
  );
}
