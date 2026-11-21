import { type ReactNode, useEffect, useRef } from "react";
import { useWorkspace } from "../workspace.tsx";
import { agentLabel } from "./AgentState.tsx";
import { Composer } from "./Composer.tsx";
import { InterruptBlock } from "./InterruptBlock.tsx";
import { MessageView, StreamingMessage } from "./MessageView.tsx";
import { NoticeBlock } from "./NoticeBlock.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { UnknownBlock } from "./UnknownBlock.tsx";

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
  const promptCount = state?.prompts.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messageCount, streamingLength, promptCount]);
  if (state === undefined) return null;
  const isMain = conversation === ws.main;
  const threadsHere = (message: string) => ws.threads.filter((t) => t.parent === message);
  const showFull = ws.showsInterrupts(conversation);
  return (
    <div
      className="conversation-pane"
      data-testid="conversation"
      data-conversation={conversation}
      data-main={isMain}
    >
      <main className="conversation">
        <div className="column">
          {state.timeline.length === 0 && state.streaming === null && (
            <p className="empty" data-testid={isMain ? "empty" : "empty-thread"}>
              {isMain
                ? "Ask about your Kiro sessions. Every session mentioned here stays live in the conversation."
                : "A thread continues from the message it branched off. Ask it something."}
            </p>
          )}
          {state.timeline.map((b) => {
            if (b.kind === "unknown") return <UnknownBlock key={b.id} block={b} />;
            if (b.kind === "interrupt")
              return showFull ? <InterruptBlock key={b.id} block={b} /> : null;
            if (b.kind === "notice") return <NoticeBlock key={b.id} block={b} />;
            const m = state.messages.find((x) => x.address === b.address);
            return m === undefined ? null : (
              <MessageView
                key={m.address}
                message={m}
                conversation={conversation}
                stubs={state.stubs}
                threads={threadsHere(m.address)}
              />
            );
          })}
          {state.streaming && <StreamingMessage text={state.streaming.text} />}
          {showFull &&
            state.prompts.map((p) => (
              <PromptCard
                key={p.id}
                prompt={p}
                onAnswer={(allow) => void window.draft.answerPrompt(conversation, p.id, allow)}
              />
            ))}
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </main>
      <Composer
        busy={state.busy}
        agentState={state.agent.state}
        agentLabel={agentLabel(state.agent)}
        onFocus={() => ws.select({ block: isMain ? null : conversation, conversation })}
        onSubmit={(t, aside) => {
          ws.select({ block: isMain ? null : conversation, conversation });
          void window.draft.submit(conversation, t, aside);
        }}
      />
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>;
}
