import type { Proposal } from "../../../shared/ipc.ts";

/**
 * A sentence that asked to open a context. draft recognized it itself; nothing opens until one
 * action confirms it, and the agent can only ever suggest, never open.
 */
export function ProposalCard({
  proposal,
  conversation,
}: {
  proposal: Proposal;
  conversation: string;
}) {
  const answer = (accept: boolean) =>
    void window.draft.answerProposal(conversation, proposal.id, accept);
  const i = proposal.intent;
  return (
    <section
      className="prompt proposal"
      data-testid="proposal"
      data-kind={i.kind}
      aria-label="Open another context"
    >
      <p className="prompt-title">
        {i.kind === "open" ? (
          <>
            Open the context <strong data-testid="proposal-target">{i.name}</strong> in its own
            window?
          </>
        ) : (
          <>
            Make a context for <code data-testid="proposal-target">{i.folder}</code> and open it in
            its own window? You will be asked whether to trust the folder.
          </>
        )}
      </p>
      <div className="prompt-actions">
        <button
          type="button"
          className="secondary-button"
          data-testid="proposal-dismiss"
          onClick={() => answer(false)}
        >
          Not now
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="proposal-open"
          onClick={() => answer(true)}
        >
          Open
        </button>
      </div>
    </section>
  );
}
