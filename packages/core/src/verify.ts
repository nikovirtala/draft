import { type DraftEvent, eventHash, GENESIS_HASH, parseEvent } from "./events.ts";

export type VerifyResult =
  | { ok: true; events: DraftEvent[] }
  | {
      ok: false;
      /** Zero-based position of the first bad event. */
      index: number;
      /** Its id, when the line could be read far enough to have one. */
      id: string | null;
      reason: string;
    };

/**
 * Walks the chain from the start and names the first bad event: a line that isn't JSON, an
 * envelope or data that fails its schema, a previous hash that doesn't match the event before, or
 * a hash that doesn't match the event's own content.
 */
export function verifyChain(raw: readonly unknown[]): VerifyResult {
  const events: DraftEvent[] = [];
  let prev = GENESIS_HASH;
  for (const [index, r] of raw.entries()) {
    const id =
      typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string"
        ? ((r as { id: string }).id as string)
        : null;
    const parsed = parseEvent(r);
    if (!parsed.ok) return { ok: false, index, id, reason: `is invalid: ${parsed.reason}` };
    const e = parsed.event;
    if (e.prevHash !== prev) {
      return {
        ok: false,
        index,
        id,
        reason: "does not chain to the event before it (previous hash mismatch)",
      };
    }
    if (eventHash(e) !== e.hash) {
      return { ok: false, index, id, reason: "was changed after it was written (hash mismatch)" };
    }
    events.push(e);
    prev = e.hash;
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
