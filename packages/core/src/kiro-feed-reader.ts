import { itemAddress } from "./address.ts";
import {
  type Actor,
  type DraftEvent,
  type EventDraft,
  isUnknown,
  type LogRecord,
} from "./events.ts";
import { classifyFeedEvent, KIRO_FEED, KNOWN_FEED_TYPES } from "./feed.ts";
import { type Classified, type Followed, followPages } from "./feed-follow.ts";
import { newItemId, ulid } from "./ids.ts";
import { foldKiroFeed, type KiroFeedFold } from "./kiro-feed.ts";
import { endWords } from "./kiro-feed-types.ts";
import type { KiroFeedApi } from "./kiro-remote-rest.ts";
import { DRAFT_VERSION } from "./version.ts";

/**
 * Reads Kiro Remote's change feed into draft's own log, and raises what needs a person. The
 * feed's parsing (feed.ts), the cursor loop (feed-follow.ts) and the fold (kiro-feed.ts) are pure;
 * this is the only part that talks to the service and writes.
 *
 * - **Where it starts.** Links and waits from before the feed have no event, so for each session
 *   the context mentions it asks the service (GET /v1/sessions/{id}) and writes a `feed.baseline`
 *   at the cursor it had read before asking. The feed is then followed from that cursor.
 * - **Where the cursor lives.** In draft's log, per context: it is the last `seq` of a `feed.event`
 *   (or of a baseline or restart), so a restart resumes and never replays.
 * - **When it reads.** On a constant interval while the app runs, and at once when the app gains
 *   focus, a page at a time until the feed has no more.
 * - **What it does with an event.** As the contract says: a type it knows is followed, an
 *   annotation it doesn't is skipped (and kept), and a state change it can't read stops the fold
 *   with one notice naming the type. A `seq` missing after the cursor means events expired: it
 *   starts again from the starting state and says so.
 */

const ACTOR: Actor = { kind: "resolver", id: "kiro-remote-feed", version: DRAFT_VERSION };

/** What the reader needs of the context it reads for. */
export interface KiroFeedHost {
  /** The context's id, which addresses its context-level facts. */
  context: string;
  events(): readonly LogRecord[];
  /** Appends facts to the log and the projection, in order. */
  append(drafts: EventDraft[]): Promise<DraftEvent[]>;
  /** The Kiro sessions the context mentions: the ones the feed is read for. */
  sessions(): string[];
  /** The conversation that holds a session's stub, or null when it has none. */
  ownerOf(session: string): string | null;
  sessionTitle(session: string): string | null;
  /** Whether an interrupt with this key was raised already (open, settled or cleared). */
  isRaised(key: string): boolean;
  /** A notice in the main conversation, once per distinct text. */
  note(what: string, text: string): Promise<void>;
  /** Something the views show changed. */
  changed(): void;
}

export interface KiroFeedReaderOptions {
  api: KiroFeedApi;
  host: KiroFeedHost;
  /** Between reads while the app runs. Default 15 s. */
  intervalMs?: number;
  /** The longest a failing read waits before trying again. Default 5 min. */
  maxBackoffMs?: number;
  now?: () => number;
  newId?: () => string;
  /** The types this reader knows; an older draft knows fewer. Default: every type of the contract. */
  known?: ReadonlySet<string>;
}

const FEED_ADDRESS = (context: string) => `${context}@1`;

export class KiroFeedReader {
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly known: ReadonlySet<string>;
  private folded: { length: number; fold: KiroFeedFold } | null = null;
  private dueAt = 0;
  private waitMs: number;
  private running: Promise<void> | null = null;
  /** Sessions the service didn't know, by when they are asked again. */
  private readonly skipUntil = new Map<string, number>();
  /** Why the last read failed, or null. In memory: a failed read leaves nothing in the log. */
  lastError: string | null = null;

  constructor(private readonly o: KiroFeedReaderOptions) {
    this.intervalMs = o.intervalMs ?? 15_000;
    this.maxBackoffMs = o.maxBackoffMs ?? 5 * 60_000;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? ulid;
    this.known = o.known ?? KNOWN_FEED_TYPES;
    this.waitMs = this.intervalMs;
  }

  /** The feed as the log holds it now; folded again only when the log has grown. */
  fold(): KiroFeedFold {
    const records = this.o.host.events();
    if (this.folded?.length === records.length) return this.folded.fold;
    const events: { event: DraftEvent; seq: number }[] = [];
    records.forEach((r, seq) => {
      if (!isUnknown(r) && r.type.startsWith("feed.")) events.push({ event: r, seq });
    });
    const fold = foldKiroFeed(events);
    this.folded = { length: records.length, fold };
    return fold;
  }

  /** Reads when it is due: the host calls this on its timer. */
  async tick(): Promise<void> {
    if (this.now() < this.dueAt) return;
    await this.poll();
  }

  /** The app gained focus: read now, not at the next interval. */
  focus(): Promise<void> {
    this.dueAt = 0;
    this.waitMs = this.intervalMs;
    return this.poll();
  }

  /** Reads now. A read under way is the one returned. */
  poll(): Promise<void> {
    if (this.running !== null) return this.running;
    this.dueAt = this.now() + this.waitMs;
    this.running = this.read()
      .then(() => {
        this.lastError = null;
        this.waitMs = this.intervalMs;
      })
      .catch((err: unknown) => {
        // The service is away, or the person isn't signed in: try again later, a little less often.
        this.lastError = err instanceof Error ? err.message : String(err);
        this.waitMs = Math.min(this.waitMs * 2, this.maxBackoffMs);
      })
      .finally(() => {
        this.dueAt = this.now() + this.waitMs;
        this.running = null;
      });
    return this.running;
  }

  private classify(raw: unknown): Classified<unknown> {
    const c = classifyFeedEvent(raw, this.known);
    if (c.kind === "handle") return { kind: "handle", event: c.event, seq: c.event.seq };
    if (c.kind === "skip") return { kind: "skip", event: c.event, seq: c.event.seq };
    return { kind: "stop", seq: c.seq, type: c.type, reason: c.reason };
  }

  private fact(data: Record<string, unknown>, type: string): EventDraft {
    return {
      type,
      address: FEED_ADDRESS(this.o.host.context),
      conversation: null,
      actor: ACTOR,
      traceId: null,
      data,
    } as unknown as EventDraft;
  }

  private async read(): Promise<void> {
    const { host } = this.o;
    // Nothing to follow it for until the context mentions a session.
    if (host.sessions().length === 0) return;
    let fold = this.fold();
    if (fold.stopped !== null) {
      // Following stopped at a type this draft didn't know. When it knows it now, start again.
      const s = fold.stopped;
      if (s.reason !== "type" || !this.known.has(s.type)) return;
      await host.append([
        this.fact(
          {
            feed: KIRO_FEED,
            reason: "resumed",
            cursor: Math.max(0, (s.seq ?? fold.cursor + 1) - 1),
            expected: null,
            got: null,
          },
          "feed.restarted",
        ),
      ]);
      fold = this.fold();
    }
    if (!fold.started) await this.start(fold.cursor);
    else await this.follow(fold.cursor);
    // Even when following stopped: the service's own state is the best a stale view can show.
    await this.baselines();
    await this.raise();
    host.changed();
  }

  /** Records what a read returned, and what ended it. Returns the end. */
  private async record(r: Followed<unknown>): Promise<Followed<unknown>["end"]> {
    const { host } = this.o;
    const events = [
      ...r.handled.map((h) => ({ seq: h.seq, event: h.event })),
      ...r.skipped.map((s) => ({ seq: s.seq, event: s.event })),
    ].sort((a, b) => a.seq - b.seq);
    const drafts = events.map((e) => this.fact({ feed: KIRO_FEED, event: e.event }, "feed.event"));
    if (r.end.kind === "stopped")
      drafts.push(
        this.fact(
          {
            feed: KIRO_FEED,
            seq: r.end.seq,
            type: r.end.type,
            reason: r.end.reason,
          },
          "feed.stopped",
        ),
      );
    if (drafts.length > 0) await host.append(drafts);
    if (r.end.kind === "stopped")
      await host.note(
        "kiro-feed-stopped",
        `Kiro Remote's change feed has an event draft can't read (${r.end.type}${r.end.seq === null ? "" : `, number ${r.end.seq}`}). It changes what sessions wait for, so draft stopped following the feed, and what it shows of waits and links may be out of date. Update draft to read it again.`,
      );
    return r.end;
  }

  /**
   * The first read, and the read after events expired: the feed from where it starts, then the
   * baselines (which wait for a read that has caught up, so a baseline's cursor is the head).
   */
  private async start(from: number, depth = 0): Promise<void> {
    const r = await followPages(this.o.api, (raw) => this.classify(raw), from, {
      fromStart: true,
      maxPages: 500,
    });
    const end = await this.record(r);
    if (end.kind === "gap" && depth < 3) await this.restart(end.expected, end.got, depth + 1);
  }

  private async follow(from: number): Promise<void> {
    const r = await followPages(this.o.api, (raw) => this.classify(raw), from);
    const end = await this.record(r);
    if (end.kind === "gap") await this.restart(end.expected, end.got, 0);
  }

  private async restart(expected: number, got: number, depth: number): Promise<void> {
    await this.o.host.append([
      this.fact(
        { feed: KIRO_FEED, reason: "gap", cursor: got - 1, expected, got },
        "feed.restarted",
      ),
    ]);
    await this.o.host.note(
      "kiro-feed-restarted",
      `Kiro Remote's change feed no longer has the events after ${expected - 1}: the next one it has is ${got}. draft read each session's links and waits again from the service and follows the feed from there.`,
    );
    await this.start(got - 1, depth);
  }

  /** A baseline for each session the context mentions that has none in this epoch. */
  private async baselines(): Promise<void> {
    const { host, api } = this.o;
    const fold = this.fold();
    for (const id of host.sessions()) {
      if (fold.sessions.get(id)?.baseline != null) continue;
      if ((this.skipUntil.get(id) ?? 0) > this.now()) continue;
      // The cursor is read before the service is asked: an event that lands in between is applied
      // on top of what it says, and a replayed set operation changes nothing.
      const cursor = this.fold().cursor;
      const snapshot = await api.session(id);
      if (snapshot === null) {
        this.skipUntil.set(id, this.now() + 5 * 60_000);
        continue;
      }
      await host.append([
        this.fact(
          { feed: KIRO_FEED, cursor, session: id, links: snapshot.links, waits: snapshot.waits },
          "feed.baseline",
        ),
      ]);
    }
  }

  /**
   * One item for each wait that ended because Kiro Remote could not read the pull request, or
   * could not even ask: nothing will wake the session for it. Only waits that ended after the
   * session's baseline raise one, so the feed's history is not an inbox. Once each, and a person
   * dismisses it.
   */
  private async raise(): Promise<void> {
    const { host } = this.o;
    const fold = this.fold();
    const drafts: EventDraft[] = [];
    for (const [session, s] of fold.sessions) {
      const owner = host.ownerOf(session);
      if (owner === null) continue;
      for (const e of s.ended) {
        if (!e.fresh || (e.reason !== "unreadable" && e.reason !== "registration_failed")) continue;
        const key = `kiro-wait:${session}:${e.pr ?? "none"}:${e.seq}`;
        if (host.isRaised(key)) continue;
        const title = host.sessionTitle(session) ?? `Session ${session.slice(0, 8)}`;
        drafts.push({
          type: "interrupt.raised",
          address: itemAddress(owner, newItemId(this.newId)),
          conversation: owner,
          actor: ACTOR,
          traceId: null,
          data: {
            key,
            kind: "wait-ended",
            target: null,
            summary: `${title} stopped waiting for ${e.pr ?? "a pull request"}: it couldn't be read`,
            detail: {
              feed: KIRO_FEED,
              sessionId: session,
              pr: e.pr,
              reason: e.reason,
              reasonText: endWords(e.reason),
              seq: e.seq,
            },
          },
        });
      }
    }
    if (drafts.length > 0) await host.append(drafts);
  }
}
