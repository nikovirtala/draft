import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson } from "./canonical.ts";
import {
  type AgentState,
  type Audience,
  audienceOf,
  type DraftEvent,
  isUnknown,
  type LogRecord,
  type Target,
  targetKey,
  type UnknownEvent,
} from "./events.ts";
import type { InterruptKind } from "./interrupts.ts";
import { findSessionIds } from "./kiro.ts";
import { type Citations, foldThread, type ThreadEventRow, type ThreadFold } from "./thread.ts";

/**
 * Views of the log in SQLite: conversations, messages, tool calls, reference edges and live
 * stubs. Every table is computed from the log alone, so the database can be deleted at any time
 * and rebuilt; `apply` builds it incrementally and `rebuild` from scratch, with the same result.
 */

/** Bump when the tables change; a projection with another version is rebuilt. */
export const PROJECTION_VERSION = 5;

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists conversations (
  conversation text primary key, context text not null, title text not null,
  parent text, created_at text not null, created_seq integer not null);
create table if not exists messages (
  address text primary key, conversation text not null, role text not null, text text not null,
  at text not null, trace_id text, seq integer not null, actor_json text not null,
  audience_json text not null);
create table if not exists agent_state (
  conversation text primary key, state text not null, at text not null, seq integer not null);
create table if not exists agent_selected (
  address text primary key, conversation text not null, agent text not null, previous text,
  reason text not null, at text not null, seq integer not null);
create table if not exists anomalies (
  address text primary key, conversation text not null, kind text not null,
  tool_use_id text not null, name text not null, input_json text not null, status text not null,
  at text not null, seq integer not null);
create table if not exists recoveries (
  event_id text primary key, sidecar text not null, bytes integer not null, hash text not null,
  at text not null, seq integer not null);
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
create table if not exists steps (
  started text primary key, conversation text not null, idempotency_key text not null,
  tool_use_id text not null, name text not null, input_json text not null,
  started_at text not null, started_seq integer not null,
  outcome text, result_summary text, finished_at text, finished_seq integer,
  resolution text, resolved_at text, retry_of text);
create table if not exists interrupts (
  event_id text primary key, key text not null, kind text not null, conversation text not null,
  target text, summary text not null, detail_json text not null, at text not null,
  seq integer not null, cleared_at text, cleared_seq integer, cleared_reason text);
create table if not exists settlements (
  event_id text primary key, key text not null, kind text not null, conversation text not null,
  outcome text not null, started text, via text, detail_json text not null, actor_json text not null,
  at text not null, seq integer not null);
create table if not exists thread_events (
  address text primary key, conversation text not null, type text not null, at text not null,
  seq integer not null, actor_json text not null, text text, cites_json text, proposal text,
  ended_as text, reason text);
create table if not exists notices (
  event_id text primary key, what text not null, text text not null, at text not null,
  seq integer not null);
create table if not exists folder_decisions (
  event_id text primary key, decision text not null, remote text, path_hash text not null,
  actor_json text not null, at text not null, seq integer not null);
create table if not exists crossings (
  event_id text primary key, conversation text not null, purpose text not null,
  context text not null, target text, from_address text, snapshot_hash text, via text,
  at text not null, seq integer not null);
create table if not exists unknown_events (
  event_id text primary key, type text not null, schema integer not null, reason text not null,
  conversation text, at text, seq integer not null);
`;

const TABLES = [
  "meta",
  "conversations",
  "messages",
  "agent_state",
  "agent_selected",
  "anomalies",
  "recoveries",
  "tool_calls",
  "edges",
  "stubs",
  "steps",
  "interrupts",
  "settlements",
  "thread_events",
  "notices",
  "folder_decisions",
  "crossings",
  "unknown_events",
] as const;

export interface MessageRow {
  address: string;
  conversation: string;
  role: "user" | "agent";
  text: string;
  at: string;
  traceId: string | null;
  seq: number;
  audience: Audience;
}

export interface AgentSelectionRow {
  address: string;
  agent: string;
  previous: string | null;
  reason: "thread-start" | "switch";
  at: string;
  seq: number;
}

/** A call that ran without the agent asking first. */
export interface AnomalyRow {
  address: string;
  conversation: string;
  kind: string;
  toolUseId: string;
  name: string;
  input: unknown;
  status: string;
  at: string;
  seq: number;
}

/** A half-written last line that opening the log moved aside. */
export interface RecoveryRow {
  eventId: string;
  sidecar: string;
  bytes: number;
  hash: string;
  at: string;
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

/** A call that changes something: started, then completed or failed, or neither (interrupted). */
export interface StepRow {
  /** The address of its `step.started` event. */
  started: string;
  conversation: string;
  idempotencyKey: string;
  toolUseId: string;
  name: string;
  input: unknown;
  startedAt: string;
  startedSeq: number;
  outcome: "completed" | "failed" | null;
  resultSummary: string | null;
  /** When the outcome was recorded. */
  finishedAt: string | null;
  /**
   * What a person settled the step as, when they did: "done", "failed" or "retry" for one that was
   * interrupted, "acknowledged" or "retry" for one that failed. A settled step is never run again.
   */
  resolution: string | null;
  resolvedAt: string | null;
  /** The step this one retries. */
  retryOf: string | null;
}

/** A thing outside the log that needed a person, as one interrupt event raised it. */
export interface RaisedRow {
  eventId: string;
  key: string;
  kind: InterruptKind;
  conversation: string;
  target: string | null;
  summary: string;
  detail: Record<string, unknown>;
  at: string;
  seq: number;
  clearedAt: string | null;
  clearedReason: string | null;
  /** Open until it is settled or cleared. */
  state: "open" | "settled" | "cleared";
  settlement: SettlementRow | null;
}

export interface SettlementRow {
  eventId: string;
  key: string;
  kind: InterruptKind;
  conversation: string;
  outcome: string;
  started: string | null;
  via: string | null;
  detail: Record<string, unknown>;
  actor: { kind: string; id: string; name?: string };
  at: string;
  seq: number;
}

export interface NoticeRow {
  eventId: string;
  what: string;
  text: string;
  at: string;
  seq: number;
}

/** A person's answer about a folder, as the log recorded it. */
export interface FolderDecisionRow {
  eventId: string;
  decision: "trusted" | "declined";
  remote: string | null;
  pathHash: string;
  actor: { kind: string; id: string; name?: string };
  at: string;
}

/** One time something crossed into another context, made from a conversation. */
export interface CrossingRow {
  eventId: string;
  conversation: string;
  purpose: "referenced" | "followed" | "pulled" | "opened";
  context: string;
  target: string | null;
  from: string | null;
  snapshotHash: string | null;
  via: string | null;
  at: string;
}

/** An event this build doesn't understand, as the conversation shows it. */
export interface UnknownRow {
  eventId: string;
  type: string;
  schema: number;
  reason: UnknownEvent["reason"];
  conversation: string | null;
  at: string | null;
  seq: number;
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
  apply(e: LogRecord, seq: number = this.count()): void {
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

  applyAll(events: readonly LogRecord[]): void {
    for (const e of events) this.apply(e);
  }

  /** Drops every view and builds it again from the log alone. */
  rebuild(events: readonly LogRecord[]): void {
    for (const t of TABLES) this.db.exec(`drop table if exists ${t}`);
    this.db.exec(SCHEMA);
    this.setMeta("version", String(PROJECTION_VERSION));
    this.applyAll(events);
  }

  /**
   * Brings the projection up to date with the log: applies the missing tail when the projection
   * is a prefix of the log, and rebuilds otherwise (another version, another log, a gap).
   */
  sync(events: readonly LogRecord[]): "current" | "incremental" | "rebuilt" {
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
    for (let i = n; i < events.length; i++) this.apply(events[i] as LogRecord, i);
    return "incremental";
  }

  private applyOne(r: LogRecord, seq: number): void {
    if (isUnknown(r)) {
      // Kept and counted, never interpreted: a later build may know what it means.
      this.run(
        "insert into unknown_events values (?, ?, ?, ?, ?, ?, ?)",
        r.id,
        r.type,
        r.schema,
        r.reason,
        r.conversation,
        r.at,
        seq,
      );
      return;
    }
    const e: DraftEvent = r;
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
          "insert or replace into messages values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.address,
          e.conversation as string,
          e.data.role,
          e.data.text,
          e.at,
          e.traceId,
          seq,
          canonicalJson(e.actor),
          canonicalJson(audienceOf(e.data)),
        );
        return;
      case "agent.state_changed":
        this.run(
          `insert into agent_state values (?, ?, ?, ?)
           on conflict(conversation) do update set state = excluded.state, at = excluded.at,
             seq = excluded.seq`,
          e.conversation as string,
          e.data.state,
          e.at,
          seq,
        );
        return;
      case "agent.anomaly":
        this.run(
          "insert or replace into anomalies values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.address,
          e.conversation as string,
          e.data.kind,
          e.data.toolUseId,
          e.data.name,
          canonicalJson(e.data.input ?? null),
          e.data.status,
          e.at,
          seq,
        );
        return;
      case "agent.selected":
        this.run(
          "insert or replace into agent_selected values (?, ?, ?, ?, ?, ?, ?)",
          e.address,
          e.conversation as string,
          e.data.agent,
          e.data.previous,
          e.data.reason,
          e.at,
          seq,
        );
        return;
      case "agent.session_started":
      case "agent.permission_asked":
        // Recorded for the audit and for the age of a local prompt; no table needs it.
        return;
      case "log.recovered":
        this.run(
          "insert or replace into recoveries values (?, ?, ?, ?, ?, ?)",
          e.id,
          e.data.sidecar,
          e.data.bytes,
          e.data.hash,
          e.at,
          seq,
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
      case "step.started":
        this.run(
          "insert into steps values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, null, ?)",
          e.address,
          e.conversation as string,
          e.data.idempotencyKey,
          e.data.toolUseId,
          e.data.name,
          canonicalJson(e.data.input ?? null),
          e.at,
          seq,
          e.data.retryOf ?? null,
        );
        return;
      case "interrupt.raised":
        this.run(
          "insert into interrupts values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null)",
          e.id,
          e.data.key,
          e.data.kind,
          e.conversation as string,
          e.data.target === null ? null : targetKey(e.data.target),
          e.data.summary,
          canonicalJson(e.data.detail),
          e.at,
          seq,
        );
        return;
      case "interrupt.cleared":
        this.run(
          `update interrupts set cleared_at = ?, cleared_seq = ?, cleared_reason = ?
           where key = ? and cleared_seq is null`,
          e.at,
          seq,
          e.data.reason,
          e.data.key,
        );
        return;
      case "interrupt.settled":
        this.run(
          "insert into settlements values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.id,
          e.data.key,
          e.data.kind,
          e.conversation as string,
          e.data.outcome,
          e.data.started,
          e.data.via,
          canonicalJson(e.data.detail),
          canonicalJson(e.actor),
          e.at,
          seq,
        );
        if (e.data.started !== null)
          this.run(
            "update steps set resolution = ?, resolved_at = ? where started = ?",
            e.data.outcome,
            e.at,
            e.data.started,
          );
        return;
      case "thread.conclusion_proposed":
      case "thread.wrapped_up":
      case "thread.conclusion_declined":
      case "thread.ended": {
        const d = e.data as Record<string, unknown>;
        const type =
          e.type === "thread.conclusion_proposed"
            ? "proposed"
            : e.type === "thread.wrapped_up"
              ? "wrapped-up"
              : e.type === "thread.conclusion_declined"
                ? "declined"
                : "ended";
        this.run(
          "insert into thread_events values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.address,
          e.conversation as string,
          type,
          e.at,
          seq,
          canonicalJson(e.actor),
          (d.text as string | undefined) ?? null,
          d.cites === undefined ? null : canonicalJson(d.cites),
          (d.proposal as string | undefined) ?? null,
          type === "ended" ? (d.state as string) : null,
          (d.reason as string | undefined) ?? null,
        );
        return;
      }
      case "notice.posted":
        this.run(
          "insert into notices values (?, ?, ?, ?, ?)",
          e.id,
          e.data.what,
          e.data.text,
          e.at,
          seq,
        );
        return;
      case "step.completed":
      case "step.failed":
        // The first completion of a step counts; a step completes once.
        this.run(
          `update steps set outcome = ?, result_summary = ?, finished_at = ?, finished_seq = ?
           where started = ? and outcome is null`,
          e.type === "step.completed" ? "completed" : "failed",
          e.data.resultSummary,
          e.at,
          seq,
          e.data.started,
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
      case "context.folder_decided":
        this.run(
          "insert or replace into folder_decisions values (?, ?, ?, ?, ?, ?, ?)",
          e.id,
          e.data.decision,
          e.data.remote,
          e.data.pathHash,
          canonicalJson(e.actor),
          e.at,
          seq,
        );
        return;
      case "context.crossed":
        this.run(
          "insert or replace into crossings values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.id,
          e.conversation as string,
          e.data.purpose,
          e.data.context,
          e.data.target,
          e.data.from,
          e.data.snapshotHash,
          e.data.via,
          e.at,
          seq,
        );
        return;
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
          "select address, conversation, role, text, at, trace_id, seq, audience_json from messages where conversation = ? order by seq",
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
      audience: JSON.parse(r.audience_json as string) as Audience,
    }));
  }

  /** Whether the agent takes part in `conversation`: active until someone pauses it. */
  agentState(conversation: string): AgentState {
    const r = this.db
      .prepare("select state from agent_state where conversation = ?")
      .get(conversation) as { state: AgentState } | undefined;
    return r?.state ?? "active";
  }

  /** The agent a person chose for `conversation`, or null: it runs on the default agent. */
  agentOf(conversation: string): string | null {
    const r = this.db
      .prepare("select agent from agent_selected where conversation = ? order by seq desc limit 1")
      .get(conversation) as { agent: string } | undefined;
    return r?.agent ?? null;
  }

  /** Every choice of agent for `conversation`, oldest first: the audit of who acted from where. */
  agentSelections(conversation: string): AgentSelectionRow[] {
    return (
      this.db
        .prepare("select * from agent_selected where conversation = ? order by seq")
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      address: r.address as string,
      agent: r.agent as string,
      previous: (r.previous as string | null) ?? null,
      reason: r.reason as "thread-start" | "switch",
      at: r.at as string,
      seq: Number(r.seq),
    }));
  }

  /** Calls that ran without asking, in the order draft saw them. */
  anomalies(conversation: string): AnomalyRow[] {
    return (
      this.db
        .prepare("select * from anomalies where conversation = ? order by seq")
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      address: r.address as string,
      conversation: r.conversation as string,
      kind: r.kind as string,
      toolUseId: r.tool_use_id as string,
      name: r.name as string,
      input: JSON.parse(r.input_json as string) as unknown,
      status: r.status as string,
      at: r.at as string,
      seq: Number(r.seq),
    }));
  }

  recoveries(): RecoveryRow[] {
    return (
      this.db.prepare("select * from recoveries order by seq").all() as Record<string, unknown>[]
    ).map((r) => ({
      eventId: r.event_id as string,
      sidecar: r.sidecar as string,
      bytes: Number(r.bytes),
      hash: r.hash as string,
      at: r.at as string,
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

  /** Every answer about a folder, oldest first. The latest one is the one in force. */
  folderDecisions(): FolderDecisionRow[] {
    return (
      this.db.prepare("select * from folder_decisions order by seq").all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      eventId: r.event_id as string,
      decision: r.decision as "trusted" | "declined",
      remote: (r.remote as string | null) ?? null,
      pathHash: r.path_hash as string,
      actor: JSON.parse(r.actor_json as string) as FolderDecisionRow["actor"],
      at: r.at as string,
    }));
  }

  /** The crossings made from a conversation, or from every conversation, oldest first. */
  crossings(conversation?: string): CrossingRow[] {
    const rows =
      conversation === undefined
        ? this.db.prepare("select * from crossings order by seq").all()
        : this.db
            .prepare("select * from crossings where conversation = ? order by seq")
            .all(conversation);
    return (rows as Record<string, unknown>[]).map((r) => ({
      eventId: r.event_id as string,
      conversation: r.conversation as string,
      purpose: r.purpose as CrossingRow["purpose"],
      context: r.context as string,
      target: (r.target as string | null) ?? null,
      from: (r.from_address as string | null) ?? null,
      snapshotHash: (r.snapshot_hash as string | null) ?? null,
      via: (r.via as string | null) ?? null,
      at: r.at as string,
    }));
  }

  /** The targets in other contexts that a person pulled into `conversation`. */
  pulledTargets(conversation: string): Set<string> {
    return new Set(
      this.crossings(conversation)
        .filter((c) => c.purpose === "pulled" && c.target !== null)
        .map((c) => c.target as string),
    );
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

  /**
   * The events this build doesn't understand that belong to `conversation`, and those whose
   * conversation can't be read (they might belong to it), in log order.
   */
  unknownEvents(conversation: string): UnknownRow[] {
    return (
      this.db
        .prepare(
          "select * from unknown_events where conversation = ? or conversation is null order by seq",
        )
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      eventId: r.event_id as string,
      type: r.type as string,
      schema: Number(r.schema),
      reason: r.reason as UnknownEvent["reason"],
      conversation: (r.conversation as string | null) ?? null,
      at: (r.at as string | null) ?? null,
      seq: Number(r.seq),
    }));
  }

  /** The steps of `conversation`, in the order they started. */
  steps(conversation: string): StepRow[] {
    return (
      this.db
        .prepare("select * from steps where conversation = ? order by started_seq")
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      started: r.started as string,
      conversation: r.conversation as string,
      idempotencyKey: r.idempotency_key as string,
      toolUseId: r.tool_use_id as string,
      name: r.name as string,
      input: JSON.parse(r.input_json as string) as unknown,
      startedAt: r.started_at as string,
      startedSeq: Number(r.started_seq),
      outcome: (r.outcome as "completed" | "failed" | null) ?? null,
      resultSummary: (r.result_summary as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      resolution: (r.resolution as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      retryOf: (r.retry_of as string | null) ?? null,
    }));
  }

  /** Every interrupt a resolver raised for `conversation` (or all), oldest first, with its state. */
  raised(conversation?: string): RaisedRow[] {
    const rows = (
      conversation === undefined
        ? this.db.prepare("select * from interrupts order by seq").all()
        : this.db
            .prepare("select * from interrupts where conversation = ? order by seq")
            .all(conversation)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.toRaised(r));
  }

  /** The raised interrupts of one target that are still open. */
  openRaisedFor(target: string): RaisedRow[] {
    return (
      this.db
        .prepare("select * from interrupts where target = ? order by seq")
        .all(target) as Record<string, unknown>[]
    )
      .map((r) => this.toRaised(r))
      .filter((r) => r.state === "open");
  }

  /** The newest episode of an interrupt key, whatever its state. */
  latestRaised(key: string): RaisedRow | null {
    const r = this.db
      .prepare("select * from interrupts where key = ? order by seq desc limit 1")
      .get(key) as Record<string, unknown> | undefined;
    return r === undefined ? null : this.toRaised(r);
  }

  private toRaised(r: Record<string, unknown>): RaisedRow {
    const key = r.key as string;
    const seq = Number(r.seq);
    const settled = this.db
      .prepare("select * from settlements where key = ? and seq > ? order by seq desc limit 1")
      .get(key, seq) as Record<string, unknown> | undefined;
    const settlement = settled === undefined ? null : toSettlement(settled);
    return {
      eventId: r.event_id as string,
      key,
      kind: r.kind as InterruptKind,
      conversation: r.conversation as string,
      target: (r.target as string | null) ?? null,
      summary: r.summary as string,
      detail: JSON.parse(r.detail_json as string) as Record<string, unknown>,
      at: r.at as string,
      seq,
      clearedAt: (r.cleared_at as string | null) ?? null,
      clearedReason: (r.cleared_reason as string | null) ?? null,
      state: settlement !== null ? "settled" : r.cleared_seq !== null ? "cleared" : "open",
      settlement,
    };
  }

  /** A person's settlements for `conversation`, in the order they were made. */
  settlements(conversation: string): SettlementRow[] {
    return (
      this.db
        .prepare("select * from settlements where conversation = ? order by seq")
        .all(conversation) as Record<string, unknown>[]
    ).map(toSettlement);
  }

  /** The newest settlement of an interrupt key, for the ones computed from other events. */
  settlementOf(key: string): SettlementRow | null {
    const r = this.db
      .prepare("select * from settlements where key = ? order by seq desc limit 1")
      .get(key) as Record<string, unknown> | undefined;
    return r === undefined ? null : toSettlement(r);
  }

  /** The thread events of `conversation`, in order. */
  threadEvents(conversation: string): ThreadEventRow[] {
    return (
      this.db
        .prepare("select * from thread_events where conversation = ? order by seq")
        .all(conversation) as Record<string, unknown>[]
    ).map((r) => ({
      type: r.type as ThreadEventRow["type"],
      address: r.address as string,
      at: r.at as string,
      actor: JSON.parse(r.actor_json as string) as ThreadEventRow["actor"],
      text: (r.text as string | null) ?? null,
      cites: r.cites_json === null ? null : (JSON.parse(r.cites_json as string) as Citations),
      proposal: (r.proposal as string | null) ?? null,
      endedAs: (r.ended_as as ThreadEventRow["endedAs"]) ?? null,
      reason: (r.reason as string | null) ?? null,
    }));
  }

  /** A thread's state and conclusion: its events folded through the thread machine. */
  thread(conversation: string): ThreadFold {
    return foldThread(this.threadEvents(conversation));
  }

  notices(): NoticeRow[] {
    return (
      this.db.prepare("select * from notices order by seq").all() as Record<string, unknown>[]
    ).map((r) => ({
      eventId: r.event_id as string,
      what: r.what as string,
      text: r.text as string,
      at: r.at as string,
      seq: Number(r.seq),
    }));
  }

  /**
   * The conversation a target's interrupts belong to. A hosted session belongs to the
   * conversation whose step launched it (the step's result names the session), else to the one
   * that first referenced it, else to the main conversation. Anything else belongs to the first
   * conversation that referenced it, else to the main one.
   */
  ownerOf(target: Target): string {
    if (target.type === "kiro-session") {
      const launches = this.db
        .prepare(
          `select conversation, result_summary from steps
           where outcome = 'completed' and name like '%kiro_launch_session' order by started_seq`,
        )
        .all() as { conversation: string; result_summary: string | null }[];
      const launched = launches.find((s) =>
        findSessionIds(s.result_summary ?? "").includes(target.id),
      );
      if (launched !== undefined && this.hasConversation(launched.conversation))
        return launched.conversation;
    }
    const first = this.db
      .prepare("select conversation from edges where target = ? order by seq limit 1")
      .get(targetKey(target)) as { conversation: string } | undefined;
    if (first !== undefined && this.hasConversation(first.conversation)) return first.conversation;
    return this.conversations()[0]?.conversation as string;
  }

  private hasConversation(conversation: string): boolean {
    return this.conversations().some((c) => c.conversation === conversation);
  }

  /** How many events the projection kept without understanding them. */
  unknownCount(): number {
    return Number(
      (this.db.prepare("select count(*) as n from unknown_events").get() as { n: number }).n,
    );
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

function toSettlement(r: Record<string, unknown>): SettlementRow {
  return {
    eventId: r.event_id as string,
    key: r.key as string,
    kind: r.kind as InterruptKind,
    conversation: r.conversation as string,
    outcome: r.outcome as string,
    started: (r.started as string | null) ?? null,
    via: (r.via as string | null) ?? null,
    detail: JSON.parse(r.detail_json as string) as Record<string, unknown>,
    actor: JSON.parse(r.actor_json as string) as SettlementRow["actor"],
    at: r.at as string,
    seq: Number(r.seq),
  };
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
