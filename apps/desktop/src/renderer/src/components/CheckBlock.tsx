import { useState } from "react";
import { ageText } from "../../../shared/attention.ts";
import type { Block } from "../../../shared/ipc.ts";
import { useWorkspace } from "../workspace.tsx";
import { InterruptBlock } from "./InterruptBlock.tsx";
import { Markdown } from "./Markdown.tsx";

type CheckBlockData = Extract<Block, { kind: "check" }>;
type Interrupt = Extract<Block, { kind: "interrupt" }>;

/** What each state says, in the state chips' own words: waiting is amber, done green, and a failure the waiting colours with its word. */
const STATE: Record<CheckBlockData["check"]["state"], { word: string; chip: string }> = {
  requested: { word: "Waiting for you", chip: "pending" },
  passed: { word: "Passed", chip: "pending good" },
  failed: { word: "Failed", chip: "pending bad" },
};

/** One command, with the one action that copies it exactly as written. */
function Command({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="check-command" data-testid="check-command">
      <pre className="prompt-input" data-testid="check-command-text">
        {text}
      </pre>
      <button
        type="button"
        className="secondary-button small"
        data-testid="check-copy"
        onClick={() => {
          window.draft.copyText(text).then(
            () => setState("copied"),
            () => setState("failed"),
          );
          setTimeout(() => setState("idle"), 1500);
        }}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy" : "Copy"}
      </button>
    </div>
  );
}

/** The acceptance request of a decision, wherever its conversation shows it. */
function useAcceptanceOf(target: string): { block: Interrupt; conversation: string } | null {
  const ws = useWorkspace();
  for (const [conversation, state] of Object.entries(ws.states))
    for (const b of state.timeline)
      if (
        b.kind === "interrupt" &&
        b.cause === "acceptance" &&
        b.target !== null &&
        `${b.target.type}:${b.target.id}` === target
      )
        return { block: b, conversation };
  return null;
}

/** What a passed check offers for a decision it names: its acceptance, through the usual flow. */
function Gate({
  gate,
  state,
}: {
  gate: CheckBlockData["check"]["gates"][number];
  state: CheckBlockData["check"]["state"];
}) {
  const target = `${gate.target.type}:${gate.target.id}`;
  const request = useAcceptanceOf(target);
  const name = gate.title ?? gate.target.id;
  return (
    <div
      className="check-gate"
      data-testid="check-gate"
      data-target={target}
      // The decision's state is read while this is on screen, once the check has passed.
      {...(state === "passed" ? { "data-stub-target": target } : {})}
    >
      <p className="secondary">
        Gates the decision <strong>{name}</strong>
        {state === "requested" && ": its acceptance is offered when this passes."}
        {state === "failed" && ": not offered, because this failed."}
        {state === "passed" && request === null && ": reading it to offer its acceptance…"}
      </p>
      {state === "passed" && request !== null && (
        <InterruptBlock block={request.block} conversation={request.conversation} />
      )}
    </div>
  );
}

/**
 * A check: what a merged pull request still leaves for the person. It opens to its reason and its
 * steps, each with what they should see and a copy button for every command, and they answer it
 * passed or failed with a note. What the pull request wrote that could not be read as steps is
 * shown as written.
 */
export function CheckBlock({
  block,
  conversation,
}: {
  block: CheckBlockData;
  conversation: string;
}) {
  const { check } = block;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = STATE[check.state];
  const answer = (outcome: "passed" | "failed") => {
    if (outcome === "failed" && note.trim() === "") {
      setError("Say what you saw, so whoever fixes it knows.");
      return;
    }
    setBusy(outcome);
    setError(null);
    window.draft
      .answerCheck(conversation, check.key, outcome, note.trim() === "" ? undefined : note)
      .then(() => setNote(""))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  const source = check.source;
  return (
    <section
      className="interrupt check"
      data-fill="ask"
      data-testid="check"
      data-key={check.key}
      data-state={check.state}
      data-source={source.type}
      aria-label={`Check: ${check.title}`}
    >
      <p className="interrupt-label">
        <span className={state.chip} data-fill="chip" data-testid="check-state">
          {state.word}
        </span>
        <strong data-testid="check-title">{check.title}</strong>
        <span className="secondary">
          {source.type === "merged-pull-request" && (
            <>
              after{" "}
              {source.url === null ? (
                source.ref
              ) : (
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.ref}
                </a>
              )}{" "}
              merged
            </>
          )}
          {check.state === "requested" && (
            <>
              {" · "}
              <span data-testid="check-age">waiting {ageText(check.raisedAt)}</span>
              {check.reminders > 0 && <> · reminded {check.reminders}×</>}
            </>
          )}
        </span>
      </p>
      <details open={check.state === "requested"} data-testid="check-details">
        <summary className="secondary">{check.parsed ? "Reason and steps" : "As written"}</summary>
        {check.parsed ? (
          <>
            {check.reason !== "" && (
              <div className="check-reason" data-testid="check-reason">
                <Markdown text={check.reason} />
              </div>
            )}
            <ol className="check-steps" data-testid="check-steps">
              {check.steps.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the steps are fixed text, in order
                <li key={i} data-testid="check-step">
                  <Markdown text={s.do} />
                  {s.commands.map((c) => (
                    <Command key={c} text={c} />
                  ))}
                  {s.see !== null && (
                    <div className="check-see" data-testid="check-see">
                      <Markdown text={s.see} />
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {check.tail !== null && (
              <div className="check-tail" data-testid="check-tail">
                <Markdown text={check.tail} />
              </div>
            )}
          </>
        ) : (
          <div className="check-raw" data-testid="check-raw">
            <Markdown text={check.raw} />
          </div>
        )}
      </details>
      {check.gates.map((g) => (
        <Gate key={`${g.target.type}:${g.target.id}`} gate={g} state={check.state} />
      ))}
      {check.state === "requested" ? (
        <>
          <textarea
            className="check-note"
            data-testid="check-note"
            rows={2}
            value={note}
            aria-label="Note"
            placeholder="What you saw. Needed to fail it, optional to pass it."
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="prompt-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="check-fail"
              disabled={busy !== null}
              onClick={() => answer("failed")}
            >
              {busy === "failed" ? "Working…" : "Failed"}
            </button>
            <button
              type="button"
              className="primary-button"
              data-fill="action"
              data-testid="check-pass"
              disabled={busy !== null}
              onClick={() => answer("passed")}
            >
              {busy === "passed" ? "Working…" : "Passed"}
            </button>
          </div>
        </>
      ) : (
        check.answer !== null && (
          <p className="secondary" data-testid="check-answer">
            {check.answer.outcome === "passed" ? "Passed" : "Failed"} by {check.answer.by},{" "}
            {new Date(check.answer.at).toLocaleString()}
            {check.answer.note !== null && <>: {check.answer.note}</>}
          </p>
        )
      )}
      {error !== null && (
        <p className="error" data-fill="notice" role="alert" data-testid="check-error">
          {error}
        </p>
      )}
    </section>
  );
}

/** The decisions whose acceptance a passed check hosts: the conversation leaves their requests to it. */
export function hostedAcceptances(
  states: Record<string, { timeline: Block[] }>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of Object.values(states))
    for (const b of s.timeline)
      if (b.kind === "check" && b.check.state === "passed")
        for (const g of b.check.gates) out.add(`${g.target.type}:${g.target.id}`);
  return out;
}
