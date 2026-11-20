import { type FormEvent, type KeyboardEvent, useState } from "react";

export function Composer({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (t === "" || busy) return;
    onSubmit(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="Message"
        placeholder="Message draft"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <button type="submit" className="primary-button" disabled={busy || text.trim() === ""}>
        Send
      </button>
    </form>
  );
}
