import { useState } from "react";
import type { Conclusion, ConversationState } from "../../../shared/ipc.ts";
import { Markdown } from "./Markdown.tsx";

/** What a conclusion rests on: the thread's messages, and what it produced. */
export function Citation({ conclusion, title }: { conclusion: Conclusion; title?: string }) {
  const made = conclusion.cites.produced;
  return (
    <p className="secondary" data-testid="conclusion-cites">
      From {title === undefined ? "the thread" : `the thread “${title}”`}:{" "}
      {conclusion.cites.messages} {conclusion.cites.messages === 1 ? "message" : "messages"}
      {made.length > 0 && (
        <>
          , produced{" "}
          {made.map((m) => (
            <code key={`${m.type}:${m.id}`}>
              {m.type}:{m.id}{" "}
            </code>
          ))}
        </>
      )}
    </p>
  );
}

/**
 * The conclusion the thread's agent drafted, waiting for you. One action wraps the thread up and
 * returns the conclusion to the conversation it branched off; or you send it back.
 */
export function ConclusionCard({
  conversation,
  conclusion,
}: {
  conversation: string;
  conclusion: Conclusion;
}) {
  const [error, setError] = useState<string | null>(null);
  const act = (f: () => Promise<void>) => {
    setError(null);
    f().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section
      className="prompt conclusion-card"
      data-testid="conclusion-card"
      data-key={conclusion.address}
      aria-label="A conclusion to confirm"
    >
      <p className="interrupt-label">
        <span className="chip">Conclusion to confirm</span>
      </p>
      <div data-testid="conclusion-text">
        <Markdown text={conclusion.text} />
      </div>
      <Citation conclusion={conclusion} />
      <div className="prompt-actions">
        <button
          type="button"
          className="secondary-button"
          data-testid="conclusion-decline"
          onClick={() => act(() => window.draft.declineConclusion(conversation))}
        >
          Not yet
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="conclusion-confirm"
          onClick={() => act(() => window.draft.confirmConclusion(conversation))}
        >
          Wrap up and return it
        </button>
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const ENDED: Record<string, string> = {
  "wrapped-up": "This thread wrapped up. Its conclusion is in the conversation it branched off.",
  superseded: "This thread was superseded.",
  withdrawn: "This thread was withdrawn.",
};

/** Shown in place of the composer: an ended thread takes no more turns. */
export function EndedNote({ thread }: { thread: NonNullable<ConversationState["thread"]> }) {
  return (
    <p className="ended-note" data-testid="thread-ended" data-state={thread.state}>
      {ENDED[thread.state] ?? "This thread ended."}
      {thread.endedReason !== null && ` Reason: ${thread.endedReason}`}
    </p>
  );
}
