import { type FormEvent, type KeyboardEvent, useState } from "react";

/**
 * The composer. ↵ sends to the conversation's default audience, which comes from the agent's
 * state: people and the agent while it is active, people only while it is paused. ⌥↵ sends an
 * aside, for people only. The line under the box says which is which.
 */
export function Composer({
  busy,
  agentState,
  agentLabel,
  onSubmit,
  onFocus,
}: {
  busy: boolean;
  agentState: "active" | "paused";
  agentLabel: string;
  onSubmit: (text: string, aside: boolean) => void;
  /** Speaking in a conversation selects it, which is what focus takes. */
  onFocus?: () => void;
}) {
  const [text, setText] = useState("");
  const [altHeld, setAltHeld] = useState(false);
  // While the agent is answering, only an aside can be sent.
  const send = (aside: boolean) => {
    const t = text.trim();
    if (t === "" || (busy && !aside)) return;
    onSubmit(t, aside);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    setAltHeld(e.altKey);
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(e.altKey);
    }
  };
  const paused = agentState === "paused";
  return (
    <form
      className="composer-wrap"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        send(false);
      }}
    >
      <div className="composer">
        <textarea
          aria-label="Message"
          placeholder={paused ? "Message people" : "Message draft"}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={onFocus}
          onKeyDown={onKey}
          onKeyUp={(e) => setAltHeld(e.altKey)}
          onBlur={() => setAltHeld(false)}
        />
        <button
          type="submit"
          className="primary-button"
          disabled={(busy && !altHeld) || text.trim() === ""}
        >
          {altHeld ? "Aside" : "Send"}
        </button>
      </div>
      <p className="composer-hint" data-testid="composer-hint">
        {paused ? (
          <>
            {agentLabel} is paused: messages go to people only. Write <code>@agent</code> to reach
            it for one message.
          </>
        ) : (
          <>
            To people and {agentLabel}. <kbd>Option</kbd>+<kbd>Enter</kbd> (<kbd>Alt</kbd>+
            <kbd>Enter</kbd>) sends an aside, for people only.
          </>
        )}
      </p>
    </form>
  );
}
