import { useState } from "react";
import type { Block } from "../../../shared/ipc.ts";

type Interrupt = Extract<Block, { kind: "interrupt" }>;

interface Evidence {
  id: string;
  label: string;
  status: "green" | "red" | "pending";
  detail: string | null;
  url: string | null;
}

interface Answer {
  label: string;
  effect: string;
  inverse: { kind: string; step?: string; reason?: string };
}

/** The word for each status: the colour is never the only cue, so the words say it. */
const MARK: Record<Evidence["status"], string> = {
  green: "Passed",
  red: "Failed",
  pending: "Waiting",
};

function inverseText(i: Answer["inverse"]): string {
  if (i.kind === "irreversible") return `can’t be undone: ${i.reason ?? ""}`;
  return `${i.kind === "reversible" ? "undone by" : "compensated by"} ${i.step ?? ""}`;
}

/** What an acceptance request shows: the record, its evidence, and the three ways to answer. */
export function AcceptanceBody({ block }: { block: Interrupt }) {
  const d = block.detail as {
    title?: string;
    sha?: string;
    url?: string | null;
    evidence?: Evidence[];
    accepts?: string;
    rejects?: string;
    answers?: { accepted?: Answer; rejected?: Answer };
    acceptance?: string;
  };
  const evidence = d.evidence ?? [];
  return (
    <>
      <p className="prompt-title" data-testid="interrupt-summary">
        {block.summary}
        {typeof d.url === "string" && (
          <>
            {" "}
            <a href={d.url} target="_blank" rel="noreferrer">
              Open
            </a>
          </>
        )}
      </p>
      <ul className="evidence" data-testid="evidence">
        {evidence.map((e) => (
          <li key={e.id} className={`evidence-${e.status}`} data-testid={`evidence-${e.id}`}>
            <span className="evidence-mark" data-fill="chip">
              {MARK[e.status]}
            </span>{" "}
            <strong>{e.label}</strong>
            {e.detail !== null && <span className="secondary"> · {e.detail}</span>}
          </li>
        ))}
      </ul>
      <p className="secondary" data-testid="acceptance-effects">
        Accept: {d.accepts}
        {d.answers?.accepted !== undefined && <> ({inverseText(d.answers.accepted.inverse)})</>}
      </p>
    </>
  );
}

/** Accept, request changes (with a note) and reject (with a reason): the person's three answers. */
export function AcceptanceActions({
  block,
  conversation,
}: {
  block: Interrupt;
  conversation: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"changes-requested" | "rejected" | null>(null);
  const [words, setWords] = useState("");
  const answers = (block.detail.answers ?? {}) as { accepted?: Answer };
  const answer = (outcome: string, input: { note?: string; reason?: string } = {}) => {
    setBusy(outcome);
    setError(null);
    window.draft
      .settleInterrupt(conversation, block.id, outcome, input)
      .then(() => {
        setAsking(null);
        setWords("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <div className="prompt-actions">
        <button
          type="button"
          className="primary-button"
          data-fill="action"
          data-testid="settle-accepted"
          disabled={busy !== null}
          onClick={() => answer("accepted")}
        >
          {busy === "accepted" ? "Working…" : (answers.accepted?.label ?? "Accept")}
        </button>
        <button
          type="button"
          className="secondary-button"
          data-testid="settle-changes-requested"
          disabled={busy !== null}
          onClick={() => setAsking(asking === "changes-requested" ? null : "changes-requested")}
        >
          Request changes
        </button>
        <button
          type="button"
          className="secondary-button"
          data-testid="settle-rejected"
          disabled={busy !== null}
          onClick={() => setAsking(asking === "rejected" ? null : "rejected")}
        >
          Reject
        </button>
      </div>
      {asking !== null && (
        <div className="acceptance-words">
          <textarea
            data-testid="acceptance-words"
            rows={3}
            value={words}
            placeholder={
              asking === "rejected"
                ? "Why? The reason is recorded with the rejection."
                : "What should change? This goes to the agent as a message."
            }
            onChange={(e) => setWords(e.target.value)}
          />
          <button
            type="button"
            className="primary-button"
            data-fill="action"
            data-testid="acceptance-send"
            disabled={busy !== null || words.trim() === ""}
            onClick={() =>
              answer(asking, asking === "rejected" ? { reason: words } : { note: words })
            }
          >
            {asking === "rejected" ? "Reject with this reason" : "Send to the agent"}
          </button>
        </div>
      )}
      {error !== null && (
        <p className="error" data-fill="notice" role="alert" data-testid="acceptance-error">
          {error}
        </p>
      )}
    </>
  );
}
