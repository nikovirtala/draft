/**
 * What a window shows of Kiro Remote's change feed. Plain data and no imports, so the renderer
 * shares the types without reaching into the log (as check-types.ts and map-types.ts do).
 */

/** Which feed and which cursor a view was built from. */
export interface FeedProvenance {
  feed: string;
  /** The `seq` of the last event of the feed the log holds. */
  cursor: number;
  /** Why the view may not be current; null when it is. */
  stale: string | null;
}

export interface UiWake {
  itemId: string;
  kind: string;
  cause: string;
  /** The pull request it is about, `owner/repo#n`. */
  pr: string | null;
  at: string;
  /** In words: "a pull request it waited for owner/repo#7 merged". */
  text: string;
}

/** What Kiro Remote's feed says of one session: shown on its stub and its node. */
export interface UiSessionFeed extends FeedProvenance {
  /** The cursor the session's links and waits start from: what the service said it had then. */
  baseline: number | null;
  waits: { pr: string; since: string }[];
  links: { pr: string; prState: string }[];
  lastWake: UiWake | null;
  /** The waits that ended without the pull request merging, newest last. */
  ended: { pr: string | null; reason: string; at: string }[];
}

const CAUSE_WORDS: Record<string, string> = {
  linked_pr_event: "its pull request",
  conflict: "its pull request",
  wait: "a pull request it waited for",
};

const KIND_WORDS: Record<string, string> = {
  pr_merged: "merged",
  pr_closed: "closed",
  review: "was reviewed",
  comment: "was commented on",
  checks_failed: "failed its checks",
  pr_conflict: "no longer merges",
  pr_behind: "is behind its base",
  pr_wait_merged: "merged",
  pr_wait_closed: "closed",
  pr_wait_unreadable: "couldn't be read",
};

/** Why a session woke, in words, from the cause and kind Kiro Remote named. */
export function wakeText(cause: string, kind: string, pr: string | null): string {
  const what = CAUSE_WORDS[cause] ?? "something";
  const happened = KIND_WORDS[kind] ?? kind.replace(/_/g, " ");
  return `${what}${pr === null ? "" : ` ${pr}`} ${happened}`;
}

const END_WORDS: Record<string, string> = {
  merged: "merged",
  closed: "closed",
  unreadable: "couldn't be read",
  stopped: "stopped by the caller",
  registration_failed: "couldn't be checked when it was registered",
};

/** Why a wait ended, in words. */
export function endWords(reason: string): string {
  return END_WORDS[reason] ?? reason.replace(/_/g, " ");
}

/** Why the feed's derived state may not be current, once the reader stopped. */
export function stoppedText(type: string, seq: number | null): string {
  return `the Kiro Remote feed stopped${seq === null ? "" : ` at event ${seq}`}: draft can't read ${type}, so the waits and links shown may be out of date`;
}
