import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { type DraftEvent, type EventDraft, GENESIS_HASH, sealEvent } from "./events.ts";
import { ulid } from "./ids.ts";
import { type VerifyResult, verifyLines } from "./verify.ts";

/**
 * The append-only, hash-chained log of one context. Behind this interface so that ark's ledger
 * (or anything else) can replace the file store later without touching callers.
 */
export interface LogStore {
  /** Seals and appends drafts in order, as one batch; returns the sealed events. */
  append(drafts: readonly EventDraft[]): Promise<DraftEvent[]>;
  /** Every event in log order. Only valid after `open` succeeded. */
  events(): readonly DraftEvent[];
  /** The hash of the last event, or the genesis hash for an empty log. */
  head(): string;
  close(): void;
}

export class LogRefusedError extends Error {
  readonly result: Extract<VerifyResult, { ok: false }>;
  constructor(path: string, result: Extract<VerifyResult, { ok: false }>) {
    super(
      `refusing to open ${path}: event ${result.index + 1}${result.id === null ? "" : ` (${result.id})`} ${result.reason}`,
    );
    this.name = "LogRefusedError";
    this.result = result;
  }
}

interface Clock {
  readonly now?: () => number;
  readonly newId?: () => string;
}

abstract class BaseLog implements LogStore {
  protected readonly list: DraftEvent[] = [];
  private readonly now: () => number;
  private readonly newId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: Clock) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? ulid;
  }

  events(): readonly DraftEvent[] {
    return this.list;
  }

  head(): string {
    return this.list.at(-1)?.hash ?? GENESIS_HASH;
  }

  append(drafts: readonly EventDraft[]): Promise<DraftEvent[]> {
    // Appends are serialized, so concurrent writers (a turn and a resolver) never fork the chain.
    const run = this.queue.then(() => {
      let prev = this.head();
      const sealed: DraftEvent[] = [];
      for (const d of drafts) {
        const e = sealEvent(d, {
          id: this.newId(),
          at: new Date(this.now()).toISOString(),
          prevHash: prev,
        });
        sealed.push(e);
        prev = e.hash;
      }
      this.write(sealed);
      this.list.push(...sealed);
      return sealed;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  protected abstract write(events: readonly DraftEvent[]): void;
  abstract close(): void;
}

/** A log kept in memory, for tests and previews. */
export class MemoryLogStore extends BaseLog {
  readonly lines: string[] = [];
  constructor(o: Clock = {}) {
    super(o);
  }
  protected write(events: readonly DraftEvent[]): void {
    for (const e of events) this.lines.push(JSON.stringify(e));
  }
  close(): void {}
}

/**
 * The log as a JSON Lines file: one event per line, written as received and never rewritten.
 * A batch is one write followed by an fsync.
 */
export class FileLogStore extends BaseLog {
  private fd: number | null;
  readonly path: string;

  private constructor(path: string, events: DraftEvent[], o: Clock) {
    super(o);
    this.path = path;
    this.list.push(...events);
    this.fd = openSync(path, "a");
  }

  /** Opens (or creates) a log and verifies its whole chain; throws `LogRefusedError` if it fails. */
  static open(path: string, o: Clock = {}): FileLogStore {
    mkdirSync(dirname(path), { recursive: true });
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const result = verifyLines(splitLines(text));
    if (!result.ok) throw new LogRefusedError(path, result);
    return new FileLogStore(path, result.events, o);
  }

  protected write(events: readonly DraftEvent[]): void {
    if (this.fd === null) throw new Error("log is closed");
    writeSync(this.fd, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** The log's lines; a file must end with a newline, so a torn last write shows as a bad line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const last = lines.pop();
  if (last !== "") lines.push(last as string);
  return lines;
}
