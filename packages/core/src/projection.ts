import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson } from "./canonical.ts";
import { type DraftEvent, targetKey } from "./events.ts";

/**
 * Views of the log in SQLite: conversations, messages, tool calls, reference edges and live
 * stubs. Every table is computed from the log alone, so the database can be deleted at any time
 * and rebuilt; `apply` builds it incrementally and `rebuild` from scratch, with the same result.
 */

/** Bump when the tables change; a projection with another version is rebuilt. */
export const PROJECTION_VERSION = 1;

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists conversations (
  conversation text primary key, context text not null, title text not null,
  parent text, created_at text not null, created_seq integer not null);
create table if not exists messages (
  address text primary key, conversation text not null, role text not null, text text not null,
  at text not null, trace_id text, seq integer not null, actor_json text not null);
create table if not exists tool_calls (
  address text primary key, conversation text not null, tool_use_id text not null,
  name text not null, decision text not null, is_error integer not null,
  result_summary text, at text not null, seq integer not null);
create table if not exists edges (
  event_id text primary key, conversation text not null, from_address text not null,
  target text not null, kind text not null, relation text not null, source text not null,
  snapshot_json text not null, at text not null, seq integer not null);
create table if not exists stubs (
  target text primary key, type text not null, id text not null, state_json text not null,
  observed_at text not null, first_seq integer not null, last_seq integer not null);
`;

const TABLES = ["meta", "conversations", "messages", "tool_calls", "edges", "stubs"] as const;

export interface MessageRow {
  address: string;
  conversation: string;
  role: "user" | "agent";
  text: string;
  at: string;
  traceId: string | null;
  seq: number;
}

export interface EdgeRow {
  eventId: string;
  conversation: string;
  from: string;
  target: string;
  kind: string;
  relation: string;
  source: string;
  snapshot: Record<string, unknown>;
  at: string;
}

export interface StubRow {
  target: string;
  type: string;
  id: string;
  state: Record<string, unknown>;
  observedAt: string;
}

export interface ToolCallRow {
  address: string;
  conversation: string;
  toolUseId: string;
  name: string;
  decision: string;
  isError: boolean;
  resultSummary: string | null;
  at: string;
}

export class ProjectionGapError extends Error {
  constructor(expected: number, got: number) {
    super(`projection expected event ${expected}, got ${got}`);
    this.name = "ProjectionGapError";
  }
}

export class Projection {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    if (this.meta("version") === null) this.setMeta("version", String(PROJECTION_VERSION));
  }

  static open(path = ":memory:"): Projection {
    return new Projection(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  /** How many events are applied. */
  count(): number {
    return Number(this.meta("count") ?? "0");
  }

  lastHash(): string | null {
    return this.meta("last_hash");
  }

  /** Applies the event at position `seq` (zero-based); events must arrive in log order. */
  apply(e: DraftEvent, seq: number = this.count()): void {
    if (seq !== this.count()) throw new ProjectionGapError(this.count(), seq);
    this.db.exec("begin");
    try {
      this.applyOne(e, seq);
      this.setMeta("count", String(seq + 1));
      this.setMeta("last_hash", e.hash);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  applyAll(events: readonly DraftEvent[]): void {
    for (const e of events) this.apply(e);
  }

  /** Drops every view and builds it again from the log alone. */
  rebuild(events: readonly DraftEvent[]): void {
    for (const t of TABLES) this.db.exec(`drop table if exists ${t}`);
    this.db.exec(SCHEMA);
    this.setMeta("version", String(PROJECTION_VERSION));
    this.applyAll(events);
  }

  /**
   * Brings the projection up to date with the log: applies the missing tail when the projection
   * is a prefix of the log, and rebuilds otherwise (another version, another log, a gap).
   */
  sync(events: readonly DraftEvent[]): "current" | "incremental" | "rebuilt" {
    const n = this.count();
    const prefixOk =
      this.meta("version") === String(PROJECTION_VERSION) &&
      n <= events.length &&
      (n === 0 || events[n - 1]?.hash === this.lastHash());
    if (!prefixOk) {
      this.rebuild(events);
      return "rebuilt";
    }
    if (n === events.length) return "current";
    for (let i = n; i < events.length; i++) this.apply(events[i] as DraftEvent, i);
    return "incremental";
  }

  private applyOne(e: DraftEvent, seq: number): void {
    switch (e.type) {
      case "context.created":
        return;
      case "conversation.created":
        this.run(
          "insert into conversations values (?, ?, ?, ?, ?, ?)",
          e.data.conversation,
          e.data.conversation.split("/")[0] as string,
          e.data.title,
          e.data.parent,
          e.at,
          seq,
        );
        return;
      case "message.posted":
        this.run(
          "insert or replace into messages values (?, ?, ?, ?, ?, ?, ?, ?)",
          e.address,
          e.conversation as string,
          e.data.role,
          e.data.text,
          e.at,
          e.traceId,
          seq,
          canonicalJson(e.actor),
        );
        return;
      case "agent.tool_called":
        this.run(
          "insert or replace into tool_calls values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.address,
          e.conversation as string,
          e.data.toolUseId,
          e.data.name,
          e.data.decision,
          e.data.isError ? 1 : 0,
          e.data.resultSummary,
          e.at,
          seq,
        );
        return;
      case "reference.made": {
        const key = targetKey(e.data.target);
        this.run(
          "insert into edges values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.id,
          e.conversation as string,
          e.data.from,
          key,
          e.data.kind,
          e.data.relation,
          e.data.source,
          canonicalJson(e.data.snapshot),
          e.at,
          seq,
        );
        // The first reference seeds the stub with the snapshot; later ones leave live state alone.
        this.run(
          `insert into stubs values (?, ?, ?, ?, ?, ?, ?) on conflict(target) do nothing`,
          key,
          e.data.target.type,
          e.data.target.id,
          canonicalJson(e.data.snapshot),
          e.at,
          seq,
          seq,
        );
        return;
      }
      case "status.observed": {
        const key = targetKey(e.data.target);
        this.run(
          `insert into stubs values (?, ?, ?, ?, ?, ?, ?)
           on conflict(target) do update set state_json = excluded.state_json,
             observed_at = excluded.observed_at, last_seq = excluded.last_seq`,
          key,
          e.data.target.type,
          e.data.target.id,
          canonicalJson(e.data.state),
          e.at,
          seq,
          seq,
        );
        return;
      }
    }
  }

  conversations(): { conversation: string; title: string; parent: string | null }[] {
    return this.db
      .prepare("select conversation, title, parent from conversations order by created_seq")
      .all() as { conversation: string; title: string; parent: string | null }[];
  }

  messages(conversation: string): MessageRow[] {
    return (
      this.db
        .prepare(
          "select address, conversation, role, text, at, trace_id, seq from messages where conversation = ? order by seq",
        )
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      address: r.address as string,
      conversation: r.conversation as string,
      role: r.role as "user" | "agent",
      text: r.text as string,
      at: r.at as string,
      traceId: (r.trace_id as string | null) ?? null,
      seq: Number(r.seq),
    }));
  }

  edges(conversation: string): EdgeRow[] {
    return (
      this.db
        .prepare("select * from edges where conversation = ? order by seq")
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      eventId: r.event_id as string,
      conversation: r.conversation as string,
      from: r.from_address as string,
      target: r.target as string,
      kind: r.kind as string,
      relation: r.relation as string,
      source: r.source as string,
      snapshot: JSON.parse(r.snapshot_json as string) as Record<string, unknown>,
      at: r.at as string,
    }));
  }

  /** Whether `conversation` already references `target`. */
  hasReference(conversation: string, target: string): boolean {
    return (
      this.db
        .prepare("select 1 from edges where conversation = ? and target = ? limit 1")
        .get(conversation, target) !== undefined
    );
  }

  stubs(): StubRow[] {
    return (
      this.db.prepare("select * from stubs order by first_seq").all() as Record<string, unknown>[]
    ).map(toStub);
  }

  stub(target: string): StubRow | null {
    const r = this.db.prepare("select * from stubs where target = ?").get(target) as
      | Record<string, unknown>
      | undefined;
    return r === undefined ? null : toStub(r);
  }

  toolCalls(conversation: string): ToolCallRow[] {
    return (
      this.db
        .prepare("select * from tool_calls where conversation = ? order by seq")
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      address: r.address as string,
      conversation: r.conversation as string,
      toolUseId: r.tool_use_id as string,
      name: r.name as string,
      decision: r.decision as string,
      isError: Number(r.is_error) === 1,
      resultSummary: (r.result_summary as string | null) ?? null,
      at: r.at as string,
    }));
  }

  /** Every row of every table, in a stable order: what "rebuild equals incremental" compares. */
  dump(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      out[t] = (this.db.prepare(`select * from ${t}`).all() as Record<string, unknown>[])
        .map((r) => canonicalJson(r))
        .sort();
    }
    return out;
  }

  private meta(key: string): string | null {
    const r = this.db.prepare("select value from meta where key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.run(
      "insert into meta values (?, ?) on conflict(key) do update set value = excluded.value",
      key,
      value,
    );
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }
}

function toStub(r: Record<string, unknown>): StubRow {
  return {
    target: r.target as string,
    type: r.type as string,
    id: r.id as string,
    state: JSON.parse(r.state_json as string) as Record<string, unknown>,
    observedAt: r.observed_at as string,
  };
}
