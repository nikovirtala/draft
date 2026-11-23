import { useEffect } from "react";
import type { Thread } from "../../../shared/ipc.ts";
import { useWorkspace } from "../workspace.tsx";
import { agentName } from "./AgentState.tsx";
import { Citation } from "./Conclusion.tsx";
import { BlockControls } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { useSelectable } from "./selectable.ts";
import { Working } from "./Working.tsx";

const WHERE: Record<string, string> = { panel: "In the panel", window: "In a window" };

const STATES: Record<string, string> = {
  "wrapped-up": "Wrapped up",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

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
        <Working
          active={thread.busy}
          label="Working"
          place="turn"
          showLabel
          className="thread-chip working"
        />
        {fresh > 0 && (
          <span className="thread-chip new" data-testid="thread-new">
            {fresh} new
          </span>
        )}
        {thread.waiting > 0 && (
          <span className="thread-chip waiting" data-testid="thread-waiting">
            Waiting on you · {thread.waiting}
          </span>
        )}
        {thread.state !== "open" && thread.state !== "concluding" && (
          <span className="thread-chip" data-testid="thread-state" data-state={thread.state}>
            {STATES[thread.state]}
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
      {thread.state === "wrapped-up" && thread.conclusion !== null && (
        <div className="thread-conclusion" data-testid="thread-conclusion">
          <Markdown text={thread.conclusion.text} />
          <Citation conclusion={thread.conclusion} title={thread.title} />
        </div>
      )}
      {thread.endedReason !== null && (
        <p className="secondary" data-testid="thread-ended-reason">
          {thread.endedReason}
        </p>
      )}
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
