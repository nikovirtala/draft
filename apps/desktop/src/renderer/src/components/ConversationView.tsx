import { type ReactNode, useEffect, useRef } from "react";
import { useWorkspace } from "../workspace.tsx";
import { agentLabel } from "./AgentState.tsx";
import { CheckBlock, hostedAcceptances } from "./CheckBlock.tsx";
import { Composer } from "./Composer.tsx";
import { ConclusionCard, EndedNote } from "./Conclusion.tsx";
import { InterruptBlock } from "./InterruptBlock.tsx";
import { MapStub } from "./MapBlock.tsx";
import { MessageView, StreamingMessage } from "./MessageView.tsx";
import { NoteBlock } from "./NoteBlock.tsx";
import { NoticeBlock } from "./NoticeBlock.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { ProposalCard } from "./ProposalCard.tsx";
import { UnknownBlock } from "./UnknownBlock.tsx";
import { Working } from "./Working.tsx";

/**
 * One conversation: the main one on the left, or a thread in the panel or a window. Interrupts
 * and permission requests show in full here only while this conversation is the one in focus, or
 * nothing is; elsewhere they only count (see the attention bar).
 */
export function ConversationView({ conversation }: { conversation: string }) {
  const ws = useWorkspace();
  const state = ws.states[conversation];
  const bottom = useRef<HTMLDivElement>(null);
  const messageCount = state?.timeline.length ?? 0;
  const streamingLength = state?.streaming?.text.length ?? 0;
  const promptCount = (state?.prompts.length ?? 0) + (state?.proposals.length ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messageCount, streamingLength, promptCount]);
  if (state === undefined) return null;
  const isMain = conversation === ws.main;
  const threadsHere = (message: string) => ws.threads.filter((t) => t.parent === message);
  const showFull = ws.showsInterrupts(conversation);
  // A passed check that names a decision hosts that decision's acceptance request.
  const hosted = hostedAcceptances(ws.states);
  return (
    <div
      className="conversation-pane"
      data-testid="conversation"
      data-conversation={conversation}
      data-main={isMain}
    >
      <main className="conversation">
        <div className="column">
          {state.timeline.every((b) => b.kind === "note") && state.streaming === null && (
            <p className="empty" data-testid={isMain ? "empty" : "empty-thread"}>
              {isMain
                ? "Ask about your Kiro sessions. Every session mentioned here stays live in the conversation."
                : "A thread continues from the message it branched off. Ask it something."}
            </p>
          )}
          {state.timeline.map((b) => {
            if (b.kind === "unknown") return <UnknownBlock key={b.id} block={b} />;
            if (b.kind === "check")
              return showFull || b.check.state !== "requested" ? (
                <CheckBlock key={b.id} block={b} conversation={conversation} />
              ) : null;
            if (
              b.kind === "interrupt" &&
              b.cause === "acceptance" &&
              b.target !== null &&
              hosted.has(`${b.target.type}:${b.target.id}`)
            )
              return null;
            if (b.kind === "interrupt")
              // What is settled is history and always shows; what is open shows where you are.
              return showFull || b.state !== "open" ? (
                <InterruptBlock key={b.id} block={b} conversation={conversation} />
              ) : null;
            if (b.kind === "notice") return <NoticeBlock key={b.id} block={b} />;
            if (b.kind === "note") return <NoteBlock key={b.id} block={b} />;
            if (b.kind === "map")
              return <MapStub key={`${b.id}#map`} message={b.id} conversation={conversation} />;
            const m = state.messages.find((x) => x.address === b.address);
            return m === undefined ? null : (
              <MessageView
                key={m.address}
                message={m}
                conversation={conversation}
                stubs={ws.stubs}
                threads={threadsHere(m.address)}
              />
            );
          })}
          {state.streaming && <StreamingMessage text={state.streaming.text} />}
          <Working
            active={state.busy}
            label={`${agentLabel(state.agent)} is working`}
            place="turn"
            className="turn-working"
          />
          {showFull &&
            state.prompts.map((p) => (
              <PromptCard
                key={p.id}
                prompt={p}
                onAnswer={(allow) => void window.draft.answerPrompt(conversation, p.id, allow)}
              />
            ))}
          {state.proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} conversation={conversation} />
          ))}
          {state.thread?.state === "concluding" && state.thread.conclusion !== null && (
            <ConclusionCard conversation={conversation} conclusion={state.thread.conclusion} />
          )}
          {state.error && (
            <p className="error" data-fill="notice" role="alert">
              {state.error}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </main>
      {state.thread !== null && ended(state.thread.state) ? (
        <EndedNote thread={state.thread} />
      ) : (
        <Composer
          busy={state.busy}
          agentState={state.agent.state}
          agentLabel={agentLabel(state.agent)}
          thread={!isMain}
          people={state.people}
          onFocus={() => ws.select({ block: isMain ? null : conversation, conversation })}
          onSubmit={(t, aside) => {
            ws.select({ block: isMain ? null : conversation, conversation });
            void window.draft.submit(conversation, t, aside);
          }}
        />
      )}
    </div>
  );
}

function ended(state: string): boolean {
  return state === "wrapped-up" || state === "superseded" || state === "withdrawn";
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>;
}
