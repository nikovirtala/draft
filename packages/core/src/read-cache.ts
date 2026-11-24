import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * What draft read from outside, kept across launches (ADR t76jn29d): a small store of two kinds of
 * thing, and nothing specific to any source.
 *
 * - **Content by address**, which can never change: a git blob by its sha. Read once per device.
 * - **Conditional responses**, by URL: the ETag and body of the last answer, so a read that
 *   hasn't changed is a 304, which GitHub doesn't count against the rate limit.
 * - **Sources**: per source (a context's ark records, a feed) the last marker seen (a tree sha, an
 *   ETag, a cursor) and, when the reader wants one, what it derived from it, with when.
 *
 * It is a cache and never a source of truth (ADR q7hkbw4h, t8bp85a7): the file can be deleted at
 * any time and the next launch reads again, losing time and nothing else. So it never throws: a
 * file that can't be opened or read is a cache that is empty, and one that fails midway is one
 * that stops remembering. Content and responses are bounded in size; the least recently used go
 * first.
 */

/** The most the content and responses may take, in bytes of text, before the oldest are dropped. */
export const READ_CACHE_MAX_BYTES = 50 * 1024 * 1024;

/** Changes when a table's shape does; an older file is emptied and filled again. */
const SCHEMA = 1;

export interface SourceMark {
  marker: string;
  /** What the reader derived from the source, as text; null when it keeps none. */
  data: string | null;
  /** When the source was last read, as an ISO time. */
  at: string;
}

export interface ReadCacheOptions {
  maxBytes?: number;
}

type Kind = "blob" | "http";

export class ReadCache {
  private db: DatabaseSync | null;
  private readonly max: number;
  private tick = 0;
  private bytes = 0;

  /** An empty cache that remembers nothing across launches: in memory, gone with the process. */
  static memory(o: ReadCacheOptions = {}): ReadCache {
    return new ReadCache(":memory:", o);
  }

  /** The cache in `path`, created when it isn't there; one that can't be read is started again. */
  constructor(path: string, o: ReadCacheOptions = {}) {
    this.max = o.maxBytes ?? READ_CACHE_MAX_BYTES;
    this.db = this.open(path);
    if (this.db !== null) this.start();
    if (this.db === null && path !== ":memory:") {
      // A file that can't be read is only a cache: it is made again.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
      this.db = this.open(path);
      if (this.db !== null) this.start();
    }
  }

  private open(path: string): DatabaseSync | null {
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      return new DatabaseSync(path);
    } catch {
      return null;
    }
  }

  private start(): void {
    this.guard(() => {
      const db = this.db as DatabaseSync;
      const version = (db.prepare("pragma user_version").get() as { user_version: number })
        .user_version;
      if (version !== SCHEMA) {
        db.exec("drop table if exists entries; drop table if exists sources");
      }
      db.exec(`
        create table if not exists entries (
          kind text not null, key text not null, etag text, body text not null,
          size integer not null, used integer not null, primary key (kind, key));
        create index if not exists entries_used on entries (used);
        create table if not exists sources (
          source text primary key, marker text not null, data text, at text not null);
        pragma user_version = ${SCHEMA};
      `);
      const row = db
        .prepare(
          "select coalesce(sum(size), 0) as bytes, coalesce(max(used), 0) as top from entries",
        )
        .get() as {
        bytes: number;
        top: number;
      };
      this.bytes = Number(row.bytes);
      this.tick = Number(row.top);
    });
  }

  /** Runs one step on the database; a failure turns the cache off instead of reaching the app. */
  private guard<T>(run: () => T, otherwise?: T): T | undefined {
    if (this.db === null) return otherwise;
    try {
      return run();
    } catch {
      try {
        this.db.close();
      } catch {
        // Closing a broken database may fail too.
      }
      this.db = null;
      return otherwise;
    }
  }

  /** Whether the cache is working; false once the file couldn't be opened or a step failed. */
  get working(): boolean {
    return this.db !== null;
  }

  /** Bytes of text held in content and responses. */
  get size(): number {
    return this.bytes;
  }

  private read(kind: Kind, key: string): { etag: string | null; body: string } | null {
    return (
      this.guard(() => {
        const db = this.db as DatabaseSync;
        const row = db
          .prepare("select etag, body from entries where kind = ? and key = ?")
          .get(kind, key) as { etag: string | null; body: string } | undefined;
        if (row === undefined) return null;
        db.prepare("update entries set used = ? where kind = ? and key = ?").run(
          ++this.tick,
          kind,
          key,
        );
        return row;
      }) ?? null
    );
  }

  private write(kind: Kind, key: string, etag: string | null, body: string): void {
    this.guard(() => {
      const db = this.db as DatabaseSync;
      const size = Buffer.byteLength(body) + Buffer.byteLength(key);
      // A single entry larger than the whole cache is not worth keeping.
      if (size > this.max) return;
      const old = db
        .prepare("select size from entries where kind = ? and key = ?")
        .get(kind, key) as { size: number } | undefined;
      db.prepare(
        `insert into entries (kind, key, etag, body, size, used) values (?, ?, ?, ?, ?, ?)
         on conflict(kind, key) do update set etag = excluded.etag, body = excluded.body,
           size = excluded.size, used = excluded.used`,
      ).run(kind, key, etag, body, size, ++this.tick);
      this.bytes += size - Number(old?.size ?? 0);
      this.trim(db);
    });
  }

  /** Drops the least recently used entries until what is held fits. */
  private trim(db: DatabaseSync): void {
    if (this.bytes <= this.max) return;
    const rows = db.prepare("select kind, key, size from entries order by used").all() as {
      kind: string;
      key: string;
      size: number;
    }[];
    const drop = db.prepare("delete from entries where kind = ? and key = ?");
    for (const r of rows) {
      if (this.bytes <= this.max) break;
      drop.run(r.kind, r.key);
      this.bytes -= Number(r.size);
    }
  }

  /** A git blob's text by its sha, or null when it isn't kept. */
  blob(sha: string): string | null {
    return this.read("blob", sha)?.body ?? null;
  }

  putBlob(sha: string, text: string): void {
    this.write("blob", sha, null, text);
  }

  /** The ETag and body of the last answer to a URL, or null. */
  response(key: string): { etag: string; body: string } | null {
    const r = this.read("http", key);
    return r === null || r.etag === null ? null : { etag: r.etag, body: r.body };
  }

  putResponse(key: string, etag: string, body: string): void {
    this.write("http", key, etag, body);
  }

  /** What was last seen of a source, or null. */
  source(source: string): SourceMark | null {
    return (
      this.guard(() => {
        const row = (this.db as DatabaseSync)
          .prepare("select marker, data, at from sources where source = ?")
          .get(source) as SourceMark | undefined;
        return row === undefined ? null : { marker: row.marker, data: row.data, at: row.at };
      }) ?? null
    );
  }

  /**
   * Records the marker of a source and when it was read. `data` replaces what was derived; left
   * out, what is kept stays, so a read that found nothing new only moves the time.
   */
  putSource(source: string, marker: string, at: string, data?: string): void {
    this.guard(() => {
      (this.db as DatabaseSync)
        .prepare(
          `insert into sources (source, marker, data, at) values (?, ?, ?, ?)
           on conflict(source) do update set marker = excluded.marker, at = excluded.at,
             data = coalesce(excluded.data, sources.data)`,
        )
        .run(source, marker, data ?? null, at);
    });
  }

  close(): void {
    this.guard(() => (this.db as DatabaseSync).close());
    this.db = null;
  }
}
