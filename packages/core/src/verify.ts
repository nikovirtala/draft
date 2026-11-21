import { eventHash, GENESIS_HASH, type LogRecord, readRecord } from "./events.ts";

export type VerifyResult =
  | { ok: true; events: LogRecord[] }
  | {
      ok: false;
      /** Zero-based position of the first bad event. */
      index: number;
      /** Its id, when the line could be read far enough to have one. */
      id: string | null;
      reason: string;
    };

/**
 * Walks the chain from the start and names the first bad event: a line that isn't JSON, a record
 * without the chain fields, a previous hash that doesn't match the event before, a hash that
 * doesn't match the record's own content, or an event of a known type whose envelope or data
 * fails its schema. The chain is checked over every record whatever its type, so events this
 * build doesn't understand are kept, not refused.
 */
export function verifyChain(raw: readonly unknown[]): VerifyResult {
  const events: LogRecord[] = [];
  let prev = GENESIS_HASH;
  for (const [index, r] of raw.entries()) {
    const id =
      typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string"
        ? ((r as { id: string }).id as string)
        : null;
    const read = readRecord(r);
    if (!read.ok) return { ok: false, index, id, reason: `is invalid: ${read.reason}` };
    const rec = r as { prevHash: string; hash: string } & Record<string, unknown>;
    if (rec.prevHash !== prev) {
      return {
        ok: false,
        index,
        id,
        reason: "does not chain to the event before it (previous hash mismatch)",
      };
    }
    if (eventHash(rec) !== rec.hash) {
      return { ok: false, index, id, reason: "was changed after it was written (hash mismatch)" };
    }
    events.push(read.record);
    prev = rec.hash;
  }
  return { ok: true, events };
}

/** `verifyChain` over JSON Lines. */
export function verifyLines(lines: readonly string[]): VerifyResult {
  const raw: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      raw.push(JSON.parse(line));
    } catch {
      const chained = verifyChain(raw);
      if (!chained.ok) return chained;
      return { ok: false, index, id: null, reason: "is not valid JSON (a torn or edited line)" };
    }
  }
  return verifyChain(raw);
}
