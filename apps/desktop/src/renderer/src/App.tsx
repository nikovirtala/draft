import { useCallback, useEffect, useRef, useState } from "react";
import type { Boot, ConversationState, Placement } from "../../shared/ipc.ts";
import { Composer } from "./components/Composer.tsx";
import { InterruptBlock } from "./components/InterruptBlock.tsx";
import { MessageView, StreamingMessage } from "./components/MessageView.tsx";
import { PromptCard } from "./components/PromptCard.tsx";
import { UnknownBlock } from "./components/UnknownBlock.tsx";
import { useVisibleStubs } from "./visibility.ts";

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [state, setState] = useState<ConversationState | null>(null);
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.draft.onChange((c) => {
      if (c.type === "state") setState(c.state);
      else
        setState((s) =>
          s === null || s.streaming === null || s.streaming.address !== c.address
            ? s
            : { ...s, streaming: { ...s.streaming, text: s.streaming.text + c.text } },
        );
    });
    void window.draft.boot().then((b) => {
      setBoot(b);
      if (b.kind === "ready") setState(b.state);
    });
    void window.draft.placements().then(setPlacements);
    return off;
  }, []);

  const messageCount = state?.timeline.length ?? 0;
  const streamingLength = state?.streaming?.text.length ?? 0;
  const promptCount = state?.prompts.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messageCount, streamingLength, promptCount]);

  useVisibleStubs(column, state);

  const place = useCallback((key: string, p: Placement) => {
    setPlacements((all) => ({ ...all, [key]: p }));
    void window.draft.setPlacement(key, p);
  }, []);

  if (boot?.kind === "refused") {
    return (
      <div className="app">
        <header className="titlebar">
          <span className="brand">draft</span>
        </header>
        <main className="refused" data-testid="refused">
          <h1>draft won’t open this log</h1>
          <p>
            The log’s hash chain doesn’t verify, so its history may have been changed. Nothing was
            read from it.
          </p>
          <pre>{boot.reason}</pre>
          <p className="secondary">
            Restore the file from a backup, or move it aside to start a new log: {boot.path}
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">draft</span>
        <span className="title">{state?.title ?? ""}</span>
      </header>
      <main className="conversation" ref={column}>
        <div className="column">
          {state !== null && state.timeline.length === 0 && state.streaming === null && (
            <p className="empty" data-testid="empty">
              Ask about your Kiro sessions. Every session mentioned here stays live in the
              conversation.
            </p>
          )}
          {state?.timeline.map((b) => {
            if (b.kind === "unknown") return <UnknownBlock key={b.id} block={b} />;
            if (b.kind === "interrupt") return <InterruptBlock key={b.id} block={b} />;
            const m = state.messages.find((x) => x.address === b.address);
            return m === undefined ? null : (
              <MessageView
                key={m.address}
                message={m}
                stubs={state.stubs}
                placements={placements}
                onPlace={place}
              />
            );
          })}
          {state?.streaming && <StreamingMessage text={state.streaming.text} />}
          {state?.prompts.map((p) => (
            <PromptCard
              key={p.id}
              prompt={p}
              onAnswer={(allow) => void window.draft.answerPrompt(p.id, allow)}
            />
          ))}
          {state?.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </main>
      <Composer busy={state?.busy ?? true} onSubmit={(t) => void window.draft.submit(t)} />
    </div>
  );
}
