import { useEffect } from "react";
import type { Thread } from "../../../shared/ipc.ts";
import { useWorkspace } from "../workspace.tsx";
import { agentName } from "./AgentState.tsx";
import { BlockControls } from "./Icons.tsx";
import { useSelectable } from "./selectable.ts";

const WHERE: Record<string, string> = { panel: "In the panel", window: "In a window" };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Where a thread branched off, kept in the main conversation: a stub with the thread's live
 * state (new messages, waiting on you, artifacts made). Wherever the thread is, this is where it
 * was created.
 */
export function ThreadStub({ thread }: { thread: Thread }) {
  const ws = useWorkspace();
  const entry = ws.entry(thread.conversation);
  const depth = ws.depthOf(thread.parentConversation);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a block is registered once, when it is first seen; its title is fixed then
  useEffect(
    () =>
      ws.register({
        info: {
          address: thread.conversation,
          kind: "thread",
          home: thread.parentConversation,
          depth,
          opens: thread.conversation,
          title: thread.title,
        },
        initial: "minimized",
      }),
    [thread.conversation],
  );
  const placement = entry?.placement ?? "minimized";
  const away = placement === "panel" || placement === "window";
  const fresh = Math.max(0, thread.messages - (ws.view.seen[thread.conversation] ?? 0));
  const last = thread.last;
  const selectable = useSelectable(thread.conversation, thread.conversation);
  return (
    <section
      {...selectable}
      className={`thread-stub ${away ? "away" : placement}${thread.waiting > 0 ? " waiting" : ""}`}
      data-testid="thread-stub"
      data-block={thread.conversation}
      data-placement={placement}
      data-thread={thread.conversation}
      aria-label={`Thread ${thread.title}`}
    >
      <div className="stub-line">
        <span className="thread-mark" aria-hidden="true">
          ↳
        </span>
        <span className="stub-title" data-testid="thread-title">
          {thread.title}
        </span>
        <span className="thread-agent">{agentName(thread.agent)}</span>
        {thread.busy && <span className="thread-chip working">Working</span>}
        {fresh > 0 && (
          <span className="thread-chip new" data-testid="thread-new">
            {fresh} new
          </span>
        )}
        {thread.waiting > 0 && (
          <span className="thread-chip waiting" data-testid="thread-waiting">
            Waiting on you
          </span>
        )}
        {thread.artifacts > 0 && (
          <span className="thread-chip" data-testid="thread-artifacts">
            {plural(thread.artifacts, "artifact", "artifacts")}
          </span>
        )}
        <span className="spacer" />
        {away ? (
          <span className="where" data-testid="stub-where">
            {WHERE[placement]}
          </span>
        ) : (
          entry !== undefined && <BlockControls entry={entry} />
        )}
      </div>
      {placement === "inline" && (
        <p className="thread-preview" data-testid="thread-preview">
          {last === null
            ? "No messages yet."
            : `${last.role === "user" ? "You" : "Agent"}: ${last.text}`}
        </p>
      )}
    </section>
  );
}
