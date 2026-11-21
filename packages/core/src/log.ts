import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type DraftEvent,
  type EventDraft,
  GENESIS_HASH,
  type LogRecord,
  sealEvent,
} from "./events.ts";
import { ulid } from "./ids.ts";
import { type VerifyResult, verifyLines } from "./verify.ts";
import { DRAFT_VERSION } from "./version.ts";

/**
 * The append-only, hash-chained log of one context. Behind this interface so that ark's ledger
 * (or anything else) can replace the file store later without touching callers.
 */
export interface LogStore {
  /** Seals and appends drafts in order, as one batch; returns the sealed events. */
  append(drafts: readonly EventDraft[]): Promise<DraftEvent[]>;
  /**
   * Every record in log order, including events this build doesn't understand. Only valid after
   * `open` succeeded.
   */
  events(): readonly LogRecord[];
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
  protected readonly list: LogRecord[] = [];
  private readonly now: () => number;
  private readonly newId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: Clock) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? ulid;
  }

  events(): readonly LogRecord[] {
    return this.list;
  }

  head(): string {
    return this.list.at(-1)?.hash ?? GENESIS_HASH;
  }

  append(drafts: readonly EventDraft[]): Promise<DraftEvent[]> {
    // Appends are serialized, so concurrent writers (a turn and a resolver) never fork the chain.
    const run = this.queue.then(() => this.appendNow(drafts));
    this.queue = run.catch(() => {});
    return run;
  }

  protected appendNow(drafts: readonly EventDraft[]): DraftEvent[] {
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

/** What opening a log did about a last line that was never completed. */
export interface LogRecovery {
  /** The sidecar file's name, next to the log. */
  sidecar: string;
  bytes: number;
  /** sha256 of the moved bytes. */
  hash: string;
}

export interface FileLogOptions extends Clock {
  /** The context a recovery event is written for when the log has no `context.created` yet. */
  readonly context?: string;
}

/**
 * The log as a JSON Lines file: one event per line, written as received and never rewritten.
 * A batch is one write followed by an fsync.
 */
export class FileLogStore extends BaseLog {
  private fd: number | null;
  readonly path: string;
  /** Set when opening moved a half-written last line aside. */
  readonly recovery: LogRecovery | null;

  private constructor(path: string, events: LogRecord[], o: Clock, recovery: LogRecovery | null) {
    super(o);
    this.path = path;
    this.list.push(...events);
    this.recovery = recovery;
    this.fd = openSync(path, "a");
  }

  /**
   * Opens (or creates) a log and verifies its whole chain; throws `LogRefusedError` if it fails.
   *
   * One problem is not a refusal: a last line without its newline. A batch is one write, then an
   * fsync, so a line that never got its newline was never confirmed to anyone. If everything
   * before it verifies, its bytes move to a sidecar file next to the log, the log is cut back to
   * the last complete line, and a `log.recovered` event records the sidecar and the bytes' hash.
   * Anything wrong before the last line is still a refusal.
   */
  static open(path: string, o: FileLogOptions = {}): FileLogStore {
    mkdirSync(dirname(path), { recursive: true });
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const complete = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
    const cut = complete ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
    const result = verifyLines(splitLines(bytes.subarray(0, cut).toString("utf8")));
    if (!result.ok) throw new LogRefusedError(path, result);
    if (complete) return new FileLogStore(path, result.events, o, null);

    const tail = bytes.subarray(cut);
    const hash = createHash("sha256").update(tail).digest("hex");
    const stamp = new Date((o.now ?? Date.now)()).toISOString().replace(/[-:.]/g, "");
    const sidecar = `${basename(path)}.torn-${stamp}-${hash.slice(0, 8)}`;
    // Sidecar first: if draft stops before the cut, the next open does the same again.
    writeFileSync(join(dirname(path), sidecar), tail, { mode: 0o600 });
    syncFile(join(dirname(path), sidecar));
    truncateSync(path, cut);
    syncFile(path);
    const recovery = { sidecar, bytes: tail.length, hash };
    const log = new FileLogStore(path, result.events, o, recovery);
    const first = result.events[0];
    const context = (first === undefined ? "" : contextOf(first)) || (o.context ?? "local");
    log.appendNow([
      {
        type: "log.recovered",
        address: `${context}@1`,
        conversation: null,
        actor: { kind: "system", id: "draft", version: DRAFT_VERSION },
        traceId: null,
        data: recovery,
      },
    ]);
    return log;
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

/**
 * Reads and verifies a log file without opening it: nothing is written or moved, and a last line
 * without its newline is left out, as opening would. For reading another context's log, and for
 * checking a log before it is copied.
 */
export function readLogRecords(path: string): VerifyResult {
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const complete = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
  const cut = complete ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
  return verifyLines(splitLines(bytes.subarray(0, cut).toString("utf8")));
}

function contextOf(first: LogRecord): string {
  const address = "address" in first ? first.address : "";
  return address.split("/")[0]?.split("@")[0] ?? "";
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
