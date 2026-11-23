import type { DraftEvent } from "./events.ts";
import {
  classifyFeedEvent,
  FEED_TYPES,
  type FeedType,
  KIRO_FEED,
  type KnownFeedEvent,
  type WaitEndReason,
  type WakeCause,
} from "./feed.ts";
import {
  type FeedProvenance,
  stoppedText,
  type UiSessionFeed,
  wakeText,
} from "./kiro-feed-types.ts";

/**
 * Kiro Remote's change feed, folded: which session waits for which pull request, why a session
 * last woke, and which waits ended without the pull request merging. A pure function of the feed's
 * facts in draft's log (`feed.event`, `feed.baseline`, `feed.stopped`, `feed.restarted`), so the
 * map, a session's stub and "needs you" all read the same thing, and no state of the service is
 * kept a second time.
 *
 * - **Links and waits** start from each session's baseline (what the service said it had when the
 *   feed began to be followed for it, because nothing before the feed has an event) and follow the
 *   feed's state events after the baseline's cursor. Applying an event the baseline already
 *   reflects changes nothing: they are set operations, replayed in order.
 * - **Wakes** are the feed's annotations, kept for every session whatever its baseline, with their
 *   cause. A session's wakes and causes are what a later "wakes done by hand" count reads: a wake
 *   Kiro Remote sent is here, a prompt the person sent is not.
 * - A restart (`feed.restarted`) rebuilds links and waits from the baselines after it; wakes and
 *   ended waits are history and stay.
 */

type Ev = { event: DraftEvent; seq: number };

export interface KiroLink {
  pr: string;
  method: string;
  prState: string;
}

export interface KiroWait {
  pr: string;
  source: string;
  /** When the wait was registered, as far as the feed or the service says. */
  since: string;
}

export interface KiroWake {
  sessionId: string;
  itemId: string;
  kind: string;
  cause: WakeCause;
  pr: string | null;
  /** queued: in the inbox (or pending again); delivered: sent as a turn; dropped: never sent. */
  state: "queued" | "delivered" | "dropped";
  /** Folded into a pending item instead of becoming a new one. */
  merged: boolean;
  queuedAt: string | null;
  deliveredAt: string | null;
  /** The turn that carried it, once delivered. */
  turnId: string | null;
  droppedReason: string | null;
  /** When and where in the feed it last changed. */
  at: string;
  seq: number;
  /** Who caused the change: kept as the feed said it, an unknown value opaque. */
  source: string;
}

export interface KiroEndedWait {
  pr: string | null;
  reason: WaitEndReason;
  at: string;
  seq: number;
  /** Seen after the session's baseline, so it happened while draft followed: not history. */
  fresh: boolean;
}

export interface KiroSessionFeed {
  session: string;
  /** The cursor its links and waits start from; null until the service was asked for it. */
  baseline: number | null;
  links: KiroLink[];
  waits: KiroWait[];
  ended: KiroEndedWait[];
  wakes: KiroWake[];
}

export interface KiroFeedFold {
  feed: typeof KIRO_FEED;
  /** The last `seq` read, and where the next read starts. */
  cursor: number;
  /** The feed has been followed: a restart or a first baseline is in the log. */
  started: boolean;
  /** Following stopped at an event that can't be read; links and waits are stale. */
  stopped: { seq: number | null; type: string; reason: string; at: string } | null;
  restarts: number;
  sessions: ReadonlyMap<string, KiroSessionFeed>;
}

const empty = (session: string): KiroSessionFeed => ({
  session,
  baseline: null,
  links: [],
  waits: [],
  ended: [],
  wakes: [],
});

/** The feed's facts in a log, in log order: what `foldKiroFeed` reads. */
export function feedFacts(events: readonly Ev[]): Ev[] {
  return events.filter(
    (e) =>
      e.event.type === "feed.event" ||
      e.event.type === "feed.baseline" ||
      e.event.type === "feed.stopped" ||
      e.event.type === "feed.restarted",
  );
}

function upsert<T extends { pr: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.pr === item.pr);
  if (i < 0) list.push(item);
  else list[i] = item;
}

/** Applies one state event to a session's links and waits. */
function applyState(s: KiroSessionFeed, e: KnownFeedEvent): void {
  const pr = e.pr;
  switch (e.type) {
    case "link.added":
      if (pr !== null)
        upsert(s.links, { pr, method: e.payload.method, prState: e.payload.prState });
      break;
    case "link.removed":
      if (pr !== null) s.links = s.links.filter((l) => l.pr !== pr);
      break;
    case "link.state_changed": {
      const link = s.links.find((l) => l.pr === pr);
      if (link !== undefined) link.prState = e.payload.to;
      break;
    }
    case "wait.registered":
      if (pr !== null) upsert(s.waits, { pr, source: e.payload.waitSource, since: e.ts });
      break;
    case "wait.removed":
      if (pr !== null) s.waits = s.waits.filter((w) => w.pr !== pr);
      break;
  }
}

function applyWake(s: KiroSessionFeed, e: KnownFeedEvent, seq: number): void {
  if (
    e.type !== "wake.queued" &&
    e.type !== "wake.delivered" &&
    e.type !== "wake.released" &&
    e.type !== "wake.dropped"
  )
    return;
  const p = e.payload;
  let w = s.wakes.find((x) => x.itemId === p.itemId);
  if (w === undefined) {
    w = {
      sessionId: e.sessionId,
      itemId: p.itemId,
      kind: p.kind,
      cause: p.cause,
      pr: e.pr,
      state: "queued",
      merged: false,
      queuedAt: null,
      deliveredAt: null,
      turnId: null,
      droppedReason: null,
      at: e.ts,
      seq,
      source: e.source,
    };
    s.wakes.push(w);
  }
  w.at = e.ts;
  w.seq = seq;
  w.source = e.source;
  switch (e.type) {
    case "wake.queued":
      w.state = "queued";
      w.merged = e.payload.merged;
      w.queuedAt ??= e.ts;
      break;
    case "wake.delivered":
      w.state = "delivered";
      w.deliveredAt = e.ts;
      w.turnId = e.payload.turnId;
      break;
    case "wake.released":
      // The turn did not start: the wake is pending again.
      w.state = "queued";
      w.turnId = null;
      break;
    case "wake.dropped":
      w.state = "dropped";
      w.droppedReason = e.payload.reason;
      break;
  }
}

/**
 * The feed as the log holds it. Total: an event the log keeps as received but this build can't
 * follow (an annotation it doesn't know) is skipped, as the contract says.
 */
export function foldKiroFeed(events: readonly Ev[]): KiroFeedFold {
  const facts = feedFacts(events).filter((e) => {
    const d = e.event;
    return "feed" in d.data && (d.data as { feed: string }).feed === KIRO_FEED;
  });
  // The last restart starts the epoch links and waits are rebuilt from.
  let epoch = -1;
  facts.forEach((e, i) => {
    if (e.event.type === "feed.restarted") epoch = i;
  });
  let cursor = 0;
  let stopped: KiroFeedFold["stopped"] = null;
  let restarts = 0;
  let started = false;
  const sessions = new Map<string, KiroSessionFeed>();
  const of = (id: string): KiroSessionFeed => {
    let s = sessions.get(id);
    if (s === undefined) {
      s = empty(id);
      sessions.set(id, s);
    }
    return s;
  };
  const epochEvents: { e: KnownFeedEvent; seq: number }[] = [];
  const every: { e: KnownFeedEvent; seq: number }[] = [];
  facts.forEach((f, i) => {
    const d = f.event;
    switch (d.type) {
      case "feed.event": {
        const c = classifyFeedEvent(d.data.event);
        cursor = Math.max(cursor, d.data.event.seq);
        if (c.kind !== "handle") break;
        every.push({ e: c.event, seq: d.data.event.seq });
        if (i > epoch) epochEvents.push({ e: c.event, seq: d.data.event.seq });
        break;
      }
      case "feed.baseline": {
        cursor = Math.max(cursor, d.data.cursor);
        if (i < epoch) break;
        started = true;
        const s = of(d.data.session);
        // A later baseline of the same session replaces the earlier one.
        s.baseline = d.data.cursor;
        s.links = d.data.links.map((l) => ({ ...l }));
        s.waits = d.data.waits.map((w) => ({ ...w }));
        break;
      }
      case "feed.stopped":
        if (i > epoch)
          stopped = { seq: d.data.seq, type: d.data.type, reason: d.data.reason, at: d.at };
        break;
      case "feed.restarted":
        restarts++;
        cursor = Math.max(cursor, d.data.cursor);
        if (i === epoch) {
          started = false;
          stopped = null;
        }
        break;
    }
  });
  // Links and waits: the baselines, then the epoch's state events after each baseline's cursor.
  for (const { e, seq } of epochEvents) {
    if (FEED_TYPES[e.type as FeedType].effect !== "state") continue;
    const s = sessions.get(e.sessionId);
    if (s === undefined || s.baseline === null || seq <= s.baseline) continue;
    applyState(s, e);
  }
  // Waits that ended, and wakes: history for every session, in the order the feed gave them.
  for (const { e, seq } of every) {
    if (e.type === "wait.removed") {
      const s = of(e.sessionId);
      s.ended.push({
        pr: e.pr,
        reason: e.payload.reason,
        at: e.ts,
        seq,
        fresh: s.baseline !== null && seq > s.baseline,
      });
    } else applyWake(of(e.sessionId), e, seq);
  }
  // A session known only by its wakes has no baseline: its links and waits are unknown, not empty.
  return { feed: KIRO_FEED, cursor, started, stopped, restarts, sessions };
}

/** The last wake a session was sent: the one delivered most recently. Null when none was. */
export function lastWake(s: KiroSessionFeed | undefined): KiroWake | null {
  if (s === undefined) return null;
  let last: KiroWake | null = null;
  for (const w of s.wakes)
    if (w.state === "delivered" && (last === null || w.seq > last.seq)) last = w;
  return last;
}

/**
 * A session's wakes and why each was sent: the query a count of wakes done by hand reads (a wake
 * Kiro Remote sent is in the feed; a prompt the person sent is not), by cause.
 */
export function wakesOf(fold: KiroFeedFold, session: string): readonly KiroWake[] {
  return fold.sessions.get(session)?.wakes ?? [];
}

/** Why the derived links and waits may not be current; null when they are. */
export function feedStale(fold: KiroFeedFold): string | null {
  return fold.stopped === null ? null : stoppedText(fold.stopped.type, fold.stopped.seq);
}

export function feedProvenance(fold: KiroFeedFold): FeedProvenance {
  return { feed: fold.feed, cursor: fold.cursor, stale: feedStale(fold) };
}

/** What a stub and a node say of one session, or null when the feed holds nothing of it. */
export function sessionFeedView(fold: KiroFeedFold, session: string): UiSessionFeed | null {
  const s = fold.sessions.get(session);
  if (s === undefined) return null;
  const w = lastWake(s);
  return {
    ...feedProvenance(fold),
    baseline: s.baseline,
    waits: s.waits.map((x) => ({ pr: x.pr, since: x.since })),
    links: s.links.map((x) => ({ pr: x.pr, prState: x.prState })),
    lastWake:
      w === null
        ? null
        : {
            itemId: w.itemId,
            kind: w.kind,
            cause: w.cause,
            pr: w.pr,
            at: w.deliveredAt ?? w.at,
            text: wakeText(w.cause, w.kind, w.pr),
          },
    ended: s.ended
      .filter((x) => x.reason !== "merged")
      .map((x) => ({ pr: x.pr, reason: x.reason, at: x.at })),
  };
}
