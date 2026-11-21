import type { Block } from "../../../shared/ipc.ts";

/** An event a newer draft (or another context) wrote: kept in the log, shown without interpreting it. */
export function UnknownBlock({ block }: { block: Extract<Block, { kind: "unknown" }> }) {
  return (
    <section
      className="generic"
      data-testid="unknown-event"
      aria-label="An event this version doesn't understand"
    >
      <p className="generic-title">An event this version of draft doesn’t understand</p>
      <p className="secondary">
        <code>{block.type}</code>, schema version {block.schema}
        {block.at === null ? "" : `, ${new Date(block.at).toLocaleString()}`}. It is kept in the log
        as it was written; a newer version of draft can show it.
      </p>
    </section>
  );
}
