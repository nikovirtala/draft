import type { Block } from "../../../shared/ipc.ts";

/** A note from draft itself, such as how it reaches GitHub. */
export function NoteBlock({ block }: { block: Extract<Block, { kind: "note" }> }) {
  return (
    <section
      className="generic notice"
      data-testid="note"
      data-what={block.what}
      aria-label="A note from draft"
    >
      <p className="secondary">{block.text}</p>
    </section>
  );
}
