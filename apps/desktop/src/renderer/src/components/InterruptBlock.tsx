import { useState } from "react";
import {
  ageText,
  CAUSE_LABELS,
  OUTCOME_LABELS,
  SETTLED_LABELS,
} from "../../../shared/attention.ts";
import type { Block } from "../../../shared/ipc.ts";
import { AcceptanceActions, AcceptanceBody } from "./AcceptanceRequest.tsx";
import { ACTIONS } from "./PromptCard.tsx";

type Interrupt = Extract<Block, { kind: "interrupt" }>;

function toolAction(block: Interrupt): string {
  const bare = block.tool.replace(/^mcp__kiro-remote__/, "");
  return ACTIONS[bare] ?? bare;
}

/** What it is, in a sentence, by kind. */
function Body({ block }: { block: Interrupt }) {
  const action = toolAction(block);
  switch (block.cause) {
    case "unasked-call":
      return (
        <>
          <p className="prompt-title">
            The agent ran <strong>{action}</strong> without asking you first. draft records every
            action that changes something before it runs, and it didn’t get the chance to. Check
            what it did.
          </p>
          <pre className="prompt-input">{JSON.stringify(block.input, null, 2)}</pre>
          <p className="secondary">
            Seen {new Date(block.at).toLocaleString()} · no step was started
          </p>
        </>
      );
    case "unfinished-step":
      return (
        <>
          <p className="prompt-title">
            draft stopped while the agent was trying to <strong>{action}</strong>. It may or may not
            have happened, so draft won’t run it again unless you say so. Check, then say what
            happened.
          </p>
          <pre className="prompt-input">{JSON.stringify(block.input, null, 2)}</pre>
          <p className="secondary">
            Started {new Date(block.at).toLocaleString()} · idempotency key{" "}
            <code>{block.idempotencyKey}</code>
          </p>
        </>
      );
    case "failed-step":
      return (
        <>
          <p className="prompt-title">
            The agent’s attempt to <strong>{action}</strong> failed.
          </p>
          <pre className="prompt-input">{JSON.stringify(block.input, null, 2)}</pre>
          {typeof block.detail.result === "string" && (
            <p className="secondary">{block.detail.result}</p>
          )}
        </>
      );
    case "permission": {
      const options = Array.isArray(block.detail.options)
        ? (block.detail.options as { optionId: string; name: string }[])
        : [];
      return (
        <>
          <p className="prompt-title" data-testid="interrupt-summary">
            {block.summary}
          </p>
          {options.length > 0 && (
            <p className="secondary">Its options: {options.map((o) => o.name).join(", ")}</p>
          )}
        </>
      );
    }
    case "acceptance":
      return <AcceptanceBody block={block} />;
    default: {
      const url = typeof block.detail.url === "string" ? block.detail.url : null;
      return (
        <p className="prompt-title" data-testid="interrupt-summary">
          {block.summary}
          {url !== null && (
            <>
              {" "}
              <a href={url} target="_blank" rel="noreferrer">
                Open
              </a>
            </>
          )}
        </p>
      );
    }
  }
}

/**
 * Something that needs a person, in the conversation it belongs to, with the ways to settle it.
 * Open it asks; settled it says who settled it, how and when; cleared it says the source no
 * longer needs anyone. Only a person settles one: the buttons are the only way.
 */
export function InterruptBlock({
  block,
  conversation,
}: {
  block: Interrupt;
  conversation: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = CAUSE_LABELS[block.cause];
  if (block.state !== "open") {
    return (
      <section
        className={`interrupt closed ${block.state}`}
        data-testid="interrupt"
        data-key={block.id}
        data-cause={block.cause}
        data-state={block.state}
        aria-label={`${label}, ${block.state}`}
      >
        <p className="secondary" data-testid="interrupt-closed">
          {label}
          {block.summary !== "" ? ` · ${block.summary}` : ` · ${toolAction(block)}`}
          {" · "}
          {block.settled !== null
            ? `${SETTLED_LABELS[block.settled.outcome] ?? block.settled.outcome} by ${block.settled.by}, ${new Date(block.settled.at).toLocaleTimeString()}`
            : `no longer needed (${block.cleared?.reason ?? "cleared"})`}
        </p>
      </section>
    );
  }
  return (
    <section
      className="interrupt"
      data-testid="interrupt"
      data-key={block.id}
      data-cause={block.cause}
      data-state="open"
      aria-label={label}
      // An open request keeps its target fresh while it is on screen, as a stub does.
      {...(block.target === null
        ? {}
        : { "data-stub-target": `${block.target.type}:${block.target.id}` })}
    >
      <p className="interrupt-label">
        <span className="chip">{label}</span>
        <span className="secondary" data-testid="interrupt-age">
          waiting {ageText(block.at)}
        </span>
      </p>
      <Body block={block} />
      {block.cause === "acceptance" ? (
        <AcceptanceActions block={block} conversation={conversation} />
      ) : (
        <div className="prompt-actions">
          {block.outcomes.map((o) => (
            <button
              key={o}
              type="button"
              className={o === "allowed" || o === "retry" ? "primary-button" : "secondary-button"}
              data-testid={`settle-${o}`}
              disabled={busy !== null}
              onClick={() => {
                setBusy(o);
                setError(null);
                window.draft
                  .settleInterrupt(conversation, block.id, o)
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(null));
              }}
            >
              {OUTCOME_LABELS[o] ?? o}
            </button>
          ))}
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
