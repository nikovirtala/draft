import { useState } from "react";
import type { TrustQuestion } from "../../../shared/ipc.ts";

/**
 * The first time a folder is opened, before a context's agent works in it. The answer is a
 * decision in the context's log as the person; the path stays on this device.
 */
export function TrustStep({
  question,
  onAnswered,
}: {
  question: TrustQuestion;
  onAnswered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (a: "trusted" | "declined") => {
    setBusy(true);
    setError(null);
    window.draft.trust(a).then(onAnswered, (err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">draft</span>
        <span className="title" data-testid="trust-context">
          {question.context}
        </span>
      </header>
      <main className="trust" data-testid="trust-step">
        <h1>Trust this folder?</h1>
        <p>
          {question.imported
            ? "This data directory's agent workspace was a link to a folder. "
            : ""}
          The agent of <strong>{question.context}</strong> will work in{" "}
          <strong>{question.folder.name}</strong>. It can read what is there, and anything it wants
          to change asks you first, as always.
        </p>
        <dl className="trust-facts">
          <dt>Folder</dt>
          <dd>
            <code data-testid="trust-path">{question.folder.path}</code>
          </dd>
          <dt>Git remote</dt>
          <dd>
            {question.folder.remote === null ? (
              <span className="secondary" data-testid="trust-remote">
                none
              </span>
            ) : (
              <code data-testid="trust-remote">{question.folder.remote}</code>
            )}
          </dd>
        </dl>
        <p className="secondary">
          Your answer goes into this context's log as you, with the remote and a hash of the path,
          not the path. If you don't trust it, the context still opens, and its agent stays in its
          own workspace.
        </p>
        {error !== null && (
          <p className="error" data-fill="notice" role="alert">
            {error}
          </p>
        )}
        <div className="prompt-actions">
          <button
            type="button"
            className="secondary-button"
            data-testid="trust-decline"
            disabled={busy}
            onClick={() => answer("declined")}
          >
            Don’t trust
          </button>
          <button
            type="button"
            className="primary-button"
            data-fill="action"
            data-testid="trust-accept"
            disabled={busy}
            onClick={() => answer("trusted")}
          >
            Trust this folder
          </button>
        </div>
      </main>
    </div>
  );
}
