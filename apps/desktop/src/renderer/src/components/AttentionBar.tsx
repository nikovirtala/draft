import { attentionText } from "../../../shared/placement.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * What needs a person, counted per conversation from the log. In focus it reads "N in focus, M
 * elsewhere": only the focused conversation shows its interrupts in full, the rest only count.
 */
export function AttentionBar() {
  const ws = useWorkspace();
  const focus = ws.view.layout.focus;
  const text = attentionText(ws.attentionCount, focus !== null);
  const title =
    focus === null ? null : (ws.view.layout.blocks[focus.block ?? ""]?.info.title ?? null);
  if (focus === null && text === "") return null;
  return (
    <div className="attention" data-testid="attention" data-focused={focus !== null}>
      {focus !== null && (
        <span className="focus-mark" data-testid="focus-mark">
          In focus{title === null ? "" : `: ${title}`} · Esc leaves
        </span>
      )}
      <span data-testid="attention-count">{text}</span>
    </div>
  );
}
