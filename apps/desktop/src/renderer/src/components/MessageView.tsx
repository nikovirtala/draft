import type { Message, Placement, Stub } from "../../../shared/ipc.ts";
import { ViewBlock } from "./ViewBlock.tsx";

const SESSION_ID = /([0-7][0-9A-HJKMNP-TV-Z]{25})/g;

/** Plain text in paragraphs, with session ids set in monospace. */
export function Prose({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== "");
  return (
    <>
      {paragraphs.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of an immutable message
        <p key={i}>
          {p.split(SESSION_ID).map((part, j) =>
            j % 2 === 1 ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of an immutable paragraph
              <code key={j} className="id">
                {part}
              </code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </>
  );
}

export function MessageView({
  message,
  stubs,
  placements,
  onPlace,
}: {
  message: Message;
  stubs: Record<string, Stub>;
  placements: Record<string, Placement>;
  onPlace: (key: string, p: Placement) => void;
}) {
  const role = message.role;
  return (
    <article
      className={`message ${role}`}
      data-testid={`message-${role}`}
      data-address={message.address}
    >
      <div className="body">
        {message.segments.map((s, i) => {
          // Segments of a posted message never change, so their position is a stable key.
          const key = `${message.address}#${i}`;
          return s.kind === "text" ? (
            <Prose key={key} text={s.text ?? ""} />
          ) : (
            <ViewBlock
              key={key}
              description={s.source ?? ""}
              context={{ stubs, placements, onPlace, from: message.address }}
            />
          );
        })}
      </div>
      {message.references.length > 0 && (
        <div className="stubs">
          {message.references.map((r) => (
            <ViewBlock
              key={r.target}
              description={{ component: "status-stub", target: { type: r.type, id: r.id } }}
              context={{ stubs, placements, onPlace, from: message.address, snapshot: r.snapshot }}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function StreamingMessage({ text }: { text: string }) {
  return (
    <article className="message agent streaming" data-testid="message-streaming" aria-live="polite">
      <div className="body">
        <Prose text={text} />
        <span className="caret" aria-hidden="true" />
      </div>
    </article>
  );
}
