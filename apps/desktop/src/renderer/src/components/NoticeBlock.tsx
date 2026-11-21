import type { Block } from "../../../shared/ipc.ts";

/** Something draft did to the log itself, shown where it happened. */
export function NoticeBlock({ block }: { block: Extract<Block, { kind: "notice" }> }) {
  return (
    <section
      className="generic notice"
      data-testid="log-recovered"
      aria-label="The log was recovered"
    >
      <p className="generic-title">draft recovered the log</p>
      <p className="secondary">
        The last write to the log never finished, so it was never confirmed. Its {block.bytes}{" "}
        {block.bytes === 1 ? "byte was" : "bytes were"} moved to <code>{block.sidecar}</code> next
        to the log, and everything before it opened as usual. {new Date(block.at).toLocaleString()}
      </p>
    </section>
  );
}
