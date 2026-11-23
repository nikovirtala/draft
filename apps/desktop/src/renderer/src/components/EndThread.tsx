import { useState } from "react";

/** Ends a thread as superseded or withdrawn. It needs a reason, so nothing ends without one. */
export function EndThread({ conversation }: { conversation: string }) {
  const [open, setOpen] = useState(false);
  const [as, setAs] = useState<"superseded" | "withdrawn">("withdrawn");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button
        type="button"
        className="agent-toggle"
        data-testid="end-thread"
        onClick={() => setOpen(true)}
      >
        End thread…
      </button>
    );
  return (
    <form
      className="end-thread"
      data-testid="end-thread-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        window.draft.endThread(conversation, as, reason).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }}
    >
      <select
        aria-label="End as"
        value={as}
        onChange={(e) => setAs(e.target.value as "superseded" | "withdrawn")}
      >
        <option value="withdrawn">Withdrawn</option>
        <option value="superseded">Superseded</option>
      </select>
      <input
        aria-label="Reason"
        placeholder="Why"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" className="agent-toggle" disabled={reason.trim() === ""}>
        End
      </button>
      <button type="button" className="agent-toggle" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error !== null && (
        <span className="error" data-fill="notice" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
