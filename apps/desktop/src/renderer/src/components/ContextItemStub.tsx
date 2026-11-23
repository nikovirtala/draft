import type { Reference } from "../../../shared/ipc.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A reference to an item in another context, as it was when it was referenced: the other
 * context's name, the item and when it was written. It is a snapshot and never changes. Nothing
 * of it reaches this conversation's agent unless a person pulls it in; following it opens the
 * other context in its own window. Both are recorded.
 */
export function ContextItemStub({
  reference,
  conversation,
}: {
  reference: Reference;
  conversation: string;
}) {
  const s = reference.snapshot;
  const context = str(s.context);
  const address = reference.id;
  return (
    <section
      className="stub context-item"
      data-testid="context-item"
      data-context={context}
      data-address={address}
      data-pulled={reference.pulled}
      aria-label={`An item of the context ${context}`}
    >
      <div className="stub-line">
        <span className="context-badge" data-fill="chip" data-testid="context-item-context">
          {context}
        </span>
        <span className="stub-title" data-testid="context-item-title">
          {str(s.title)}
        </span>
        <span className="stub-status" data-testid="context-item-kind">
          {str(s.kind) === "conversation"
            ? "Conversation"
            : str(s.role) === "agent"
              ? "Agent message"
              : "Message"}
        </span>
        <span className="spacer" />
        {reference.pulled ? (
          <span className="pending good" data-fill="chip" data-testid="context-item-pulled">
            In the agent's context
          </span>
        ) : (
          <button
            type="button"
            className="secondary-button small"
            data-testid="context-item-pull"
            title="Let this conversation's agent read this snapshot"
            onClick={() => void window.draft.pullReference(conversation, address)}
          >
            Pull in
          </button>
        )}
        <button
          type="button"
          className="secondary-button small"
          data-testid="context-item-open"
          onClick={() => void window.draft.followReference(conversation, address)}
        >
          Open {context}
        </button>
      </div>
      <p className="snapshot-note secondary" data-testid="context-item-snapshot">
        Snapshot of {address}, written {str(s.at).replace("T", " ").slice(0, 16)}, hash{" "}
        <code>{str(s.hash).slice(0, 12)}</code>
      </p>
    </section>
  );
}
