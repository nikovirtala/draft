import { useState } from "react";
import type { Message, Stub, Thread } from "../../../shared/ipc.ts";
import { useWorkspace } from "../workspace.tsx";
import { agentName } from "./AgentState.tsx";
import { BranchIcon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { ThreadStub } from "./ThreadStub.tsx";
import { ViewBlock } from "./ViewBlock.tsx";

/**
 * Branch a thread off a message. With one agent configured the icon starts the thread at once;
 * with more, it first asks which agent the thread runs on: the default, or another.
 */
function BranchControl({ message }: { message: Message }) {
  const ws = useWorkspace();
  const [choosing, setChoosing] = useState(false);
  const several = ws.agents.length > 1;
  return (
    <span className="branch">
      <button
        type="button"
        className="icon branch-icon"
        aria-label="Branch a thread"
        title="Branch a thread off this message"
        data-testid="branch"
        onClick={() => (several ? setChoosing((c) => !c) : ws.branch(message.address))}
      >
        <BranchIcon />
      </button>
      {choosing && (
        <span className="branch-agents" role="menu" data-testid="branch-agents">
          {ws.agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="branch-agent"
              data-agent={a.id}
              onClick={() => {
                setChoosing(false);
                ws.branch(message.address, a.id);
              }}
            >
              {agentName(a.id)}
              {a.id === ws.defaultAgent ? " (default)" : ""}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function MessageView({
  message,
  conversation,
  stubs,
  threads,
}: {
  message: Message;
  conversation: string;
  stubs: Record<string, Stub>;
  threads: Thread[];
}) {
  const role = message.role;
  const aside = !message.audience.agent;
  const context = { stubs, from: message.address, conversation };
  return (
    <article
      className={`message ${role}${aside ? " aside" : ""}`}
      data-testid={`message-${role}`}
      data-address={message.address}
      data-audience={aside ? "people" : "people-and-agent"}
    >
      {aside && (
        <p className="audience" data-testid="aside-label">
          People only · the agent doesn’t read this
        </p>
      )}
      <div className="body">
        {message.segments.map((s, i) => {
          // Segments of a posted message never change, so their position is a stable key.
          const key = `${message.address}#${i}`;
          return s.kind === "text" ? (
            <Markdown key={key} text={s.text ?? ""} />
          ) : (
            <ViewBlock key={key} description={s.source ?? ""} context={context} />
          );
        })}
      </div>
      {message.references.length > 0 && (
        <div className="stubs">
          {message.references.map((r) => (
            <ViewBlock
              key={r.target}
              description={{ component: "status-stub", target: { type: r.type, id: r.id } }}
              context={{ ...context, snapshot: r.snapshot }}
            />
          ))}
        </div>
      )}
      {threads.length > 0 && (
        <div className="threads">
          {threads.map((t) => (
            <ThreadStub key={t.conversation} thread={t} />
          ))}
        </div>
      )}
      <div className="message-actions">
        <BranchControl message={message} />
      </div>
    </article>
  );
}

export function StreamingMessage({ text }: { text: string }) {
  return (
    <article className="message agent streaming" data-testid="message-streaming" aria-live="polite">
      <div className="body">
        <Markdown text={text} live />
        <span className="caret" aria-hidden="true" />
      </div>
    </article>
  );
}
