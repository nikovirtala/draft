import type { RawFeedPage } from "./feed.ts";

/**
 * A feed with a cursor that a fold follows: the one small abstraction every feed draft reads
 * shares (Kiro Remote's change feed now; the deploy pipeline and others under ark ADR 9t6n5jc6
 * later). A feed is an append-only, ordered sequence read in pages after a cursor, the `seq` of
 * the last event read. Its `seq` has no gaps, so a jump after the cursor means the events in
 * between have expired.
 *
 * `followPages` is the only loop: it pages until the feed has nothing more, hands every event to
 * the feed's own `classify`, and says how it ended. What an event means (handle, skip, stop) is
 * the feed's; what a gap and a stop do to the cursor is here, once.
 */

/** Where a feed is read from, whatever carries it. */
export interface FeedSource {
  /** The feed's name in the log and the views: "kiro-remote". */
  readonly id: string;
  /** One page after the cursor. Throws when the feed can't be read. */
  page(after: number, limit: number): Promise<RawFeedPage>;
}

/** A feed's own reading of one event; `H` is what it hands the fold. */
export type Classified<H> =
  | { kind: "handle"; event: H; seq: number }
  | { kind: "skip"; seq: number; event: unknown }
  | { kind: "stop"; seq: number | null; type: string; reason: string };

export interface FollowOptions {
  /** Events per request. */
  limit?: number;
  /** Pages per call: a long backlog is read over several calls, and the cursor says where. */
  maxPages?: number;
  /**
   * A first read starts wherever the feed does: events before the first one it has may have
   * expired, and that is not a gap in what it follows.
   */
  fromStart?: boolean;
}

export interface Followed<H> {
  /** Events to follow, in order, with the ones that were skipped (kept as received). */
  handled: { event: H; seq: number }[];
  skipped: { event: unknown; seq: number }[];
  /** The `seq` of the last event read in order; where the next read starts. */
  cursor: number;
  end:
    | { kind: "caught-up" }
    /** `maxPages` were read and the feed has more. */
    | { kind: "more" }
    /** A `seq` is missing after the cursor: `expected` was next, `got` came. */
    | { kind: "gap"; expected: number; got: number }
    /** An event the fold can't follow; the cursor is the event before it. */
    | { kind: "stopped"; type: string; reason: string; seq: number | null };
}

/**
 * Reads a feed from a cursor to its end, or to the first thing that ends the read. Events at or
 * before the cursor are ignored (a page may repeat what was read); an event after the next `seq`
 * is a gap, and nothing after it is trusted.
 */
export async function followPages<H>(
  source: FeedSource,
  classify: (raw: unknown) => Classified<H>,
  from: number,
  o: FollowOptions = {},
): Promise<Followed<H>> {
  const limit = o.limit ?? 200;
  const maxPages = o.maxPages ?? 50;
  const out: Followed<H> = { handled: [], skipped: [], cursor: from, end: { kind: "caught-up" } };
  let started = o.fromStart !== true;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) {
      out.end = { kind: "more" };
      return out;
    }
    const page = await source.page(out.cursor, limit);
    for (const raw of page.events) {
      const c = classify(raw);
      if (c.kind === "stop") {
        out.end = { kind: "stopped", type: c.type, reason: c.reason, seq: c.seq };
        return out;
      }
      if (c.seq <= out.cursor) continue;
      if (started && c.seq !== out.cursor + 1) {
        out.end = { kind: "gap", expected: out.cursor + 1, got: c.seq };
        return out;
      }
      started = true;
      if (c.kind === "handle") out.handled.push({ event: c.event, seq: c.seq });
      else out.skipped.push({ event: c.event, seq: c.seq });
      out.cursor = c.seq;
    }
    if (!page.hasMore) return out;
    // A feed that says there is more and sends nothing would loop for ever.
    if (page.events.length === 0) return out;
  }
}
