import { canonicalJson } from "./canonical.ts";
import { CONTEXT_ITEM, isContextItemKey } from "./cross-context.ts";
import { INTERRUPT_KINDS, type InterruptKind } from "./interrupts.ts";
import type { Projection, SettlementRow, StubRow } from "./projection.ts";

/**
 * What the agent is told about what a person could see and it could not: what changed in the
 * log since the agent's last turn. A person decides things in draft (accepts a pull request,
 * rejects an ADR, asks for changes) and draft resolves what a conversation references (a pull
 * request, a Kiro session); neither happens through the agent, and neither reaches it unless draft
 * says so. So the agent called a merged pull request open, and said draft had not given it a
 * pull request the person could see.
 *
 * One pure function, `changesSince`, reads the projection and returns typed entries, one `kind`
 * of entry per source of change. `renderChanges` turns them into the note in one place, through
 * one renderer per kind. A new kind of change (a decision or issue record, the map) adds an entry
 * type and a renderer here; it does not add a new path to the prompt.
 *
 * The "since" is a place in the log: the agent's last `agent.turn_started`. Anything the log
 * holds after it is new, anything before it was told, so a restart rebuilds the same answer and
 * nothing is sent twice. Written when the turn begins, that event also puts what happens during
 * a turn (a stub resolved while the agent answers) into the next turn's note.
 *
 * The audience rule of `buildAgentContext` holds here too: a stub counts only when a message the
 * agent may read referenced it (and, across contexts, only once a person pulled it in), and
 * nothing derived from a people-only message enters the note.
 */

/** A person's decision, as the log recorded it. It names what was decided and what it did. */
export interface SettlementChange {
  kind: "settlement";
  at: string;
  /** Where the settlement is in the log. */
  seq: number;
  /** Who decided: the person's name. */
  by: string;
  /** The interrupt kind that was settled: "acceptance", "failed-step", "permission"... */
  interrupt: InterruptKind;
  /** What the person answered: "accepted", "rejected", "changes-requested", "retry"... */
  outcome: string;
  /** What the decision was about, in words: "pull request “Fix the build”". */
  subject: string;
  /** Where the agent can name it: the target's key (`pull-request:owner/repo/pull/14`), when it has one. */
  address: string | null;
  /** The person's own words: the note of a request for changes, the reason of a rejection. */
  text: string | null;
  /** What carrying the answer out did, when it was a step: its summary, its kind and the commit. */
  result: { summary: string | null; kind: string; sha: string | null } | null;
}

/** What draft resolved for something the conversation referenced, as the stub shows it. */
export interface StubChange {
  kind: "stub";
  /** When draft resolved it (the stub's latest observation). */
  at: string;
  seq: number;
  /** The target's key: `pull-request:owner/repo/pull/14`. */
  target: string;
  /** The resolver type: "pull-request", "kiro-session", "ark-issue", "adr", "artifact". */
  type: string;
  id: string;
  state: Record<string, unknown>;
}

/** Every kind of change; a new kind is added here and gets a renderer below. */
export type AgentChange = SettlementChange | StubChange;

export interface ChangeOptions {
  /** The agent whose last turn is the "since"; any agent's turn when absent. */
  agent?: string;
}

/**
 * What changed in `conversation` since the agent's last turn, oldest first within each kind:
 * settlements, then stubs. Nothing is cut here; `renderChanges` caps what is told.
 */
export function changesSince(
  projection: Projection,
  conversation: string,
  o: ChangeOptions = {},
): AgentChange[] {
  const since = projection.lastTurn(conversation, o.agent)?.seq ?? -1;
  return [
    ...settlementChanges(projection, conversation, since),
    ...stubChanges(projection, conversation, since),
  ];
}

/* ----------------------------------------------------------------------------------------------- */
/* Settlements                                                                                       */
/* ----------------------------------------------------------------------------------------------- */

function settlementChanges(
  projection: Projection,
  conversation: string,
  since: number,
): SettlementChange[] {
  const out: SettlementChange[] = [];
  const raised = projection.raised(conversation);
  const steps = projection.steps(conversation);
  for (const s of projection.settlements(conversation)) {
    // Only a person settles an interrupt; anything else in the log is not a decision of theirs.
    if (s.seq <= since || s.actor.kind !== "user") continue;
    out.push(settlementChange(s, raised, steps));
  }
  return out;
}

function settlementChange(
  s: SettlementRow,
  raised: ReturnType<Projection["raised"]>,
  steps: ReturnType<Projection["steps"]>,
): SettlementChange {
  // The episode of the interrupt this settled: the latest one raised before the settlement.
  const episode = [...raised].reverse().find((r) => r.key === s.key && r.seq < s.seq) ?? null;
  const detail = episode?.detail ?? {};
  const via = s.via === null ? null : (steps.find((x) => x.started === s.via) ?? null);
  const started = s.started === null ? null : (steps.find((x) => x.started === s.started) ?? null);
  const target = asTarget(detail.target);
  const address = target === null ? (episode?.target ?? null) : `${target.type}:${target.id}`;
  const title = typeof detail.title === "string" && detail.title !== "" ? detail.title : null;
  const kindName = typeof detail.acceptance === "string" ? detail.acceptance : null;
  const what =
    kindName !== null
      ? `${kindName === "adr" ? "ADR" : kindName.replace(/-/g, " ")}${title === null ? "" : ` “${title}”`}`
      : (episode?.summary ?? (started === null ? null : `step ${started.name}`)) ||
        INTERRUPT_KINDS[s.kind].label;
  const own = s.detail;
  const text =
    typeof own.note === "string" && own.note !== ""
      ? own.note
      : typeof own.reason === "string" && own.reason !== ""
        ? own.reason
        : null;
  const effect = via?.effect ?? null;
  return {
    kind: "settlement",
    at: s.at,
    seq: s.seq,
    by: s.actor.name ?? s.actor.id,
    interrupt: s.kind,
    outcome: s.outcome,
    subject: what,
    address,
    text,
    result:
      via === null
        ? null
        : {
            summary: via.resultSummary,
            kind: effect?.kind ?? via.name,
            sha: effect?.sha ?? null,
          },
  };
}

function asTarget(v: unknown): { type: string; id: string } | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Record<string, unknown>;
  return typeof t.type === "string" && typeof t.id === "string" ? { type: t.type, id: t.id } : null;
}

/* ----------------------------------------------------------------------------------------------- */
/* Stubs                                                                                             */
/* ----------------------------------------------------------------------------------------------- */

/**
 * The stubs a message the agent may read referenced in this conversation, and that draft resolved
 * or the conversation referenced since `since`. One entry per target, whatever the number of times
 * it was observed: the stub holds the latest state, and its time is when that was resolved.
 */
function stubChanges(projection: Projection, conversation: string, since: number): StubChange[] {
  // The audience rule: a reference counts only if the message it came from reaches the agent.
  const reachesAgent = new Set(
    projection
      .messages(conversation)
      .filter((m) => m.audience.agent)
      .map((m) => m.address),
  );
  // Another context's items stay out until a person pulls one into this conversation (ADR gw4vxvw4).
  const pulled = projection.pulledTargets(conversation);
  const referencedSince = new Set<string>();
  const referenced = new Set<string>();
  for (const e of projection.edges(conversation)) {
    if (!reachesAgent.has(e.from)) continue;
    if (isContextItemKey(e.target) && !pulled.has(e.target.slice(e.target.indexOf(":") + 1)))
      continue;
    referenced.add(e.target);
    if (e.seq > since) referencedSince.add(e.target);
  }
  // Pulling another context's item in is what lets the agent read it: new to it from then on.
  for (const c of projection.crossings(conversation))
    if (c.purpose === "pulled" && c.target !== null && c.seq > since) {
      const key = `${CONTEXT_ITEM}:${c.target}`;
      if (referenced.has(key)) referencedSince.add(key);
    }
  const out: StubChange[] = [];
  for (const target of referenced) {
    const stub: StubRow | null = projection.stub(target);
    if (stub === null) continue;
    // Resolved after the agent's last turn, or referenced again since (the person asks about it).
    if (stub.lastSeq <= since && !referencedSince.has(target)) continue;
    out.push({
      kind: "stub",
      at: stub.observedAt,
      seq: stub.lastSeq,
      target,
      type: stub.type,
      id: stub.id,
      state: stub.state,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/* ----------------------------------------------------------------------------------------------- */
/* The note                                                                                          */
/* ----------------------------------------------------------------------------------------------- */

export interface NoteLimits {
  /** How many changes the note names at most. */
  maxEntries: number;
  /** How long the whole note may be, in characters. */
  maxChars: number;
  /** How long one entry may be. */
  maxEntryChars: number;
}

export const NOTE_LIMITS: NoteLimits = { maxEntries: 12, maxChars: 4000, maxEntryChars: 700 };

export interface RenderedNote {
  /** The text the agent is told, or null when there is nothing to tell. */
  text: string | null;
  /** How many changes it names. */
  entries: number;
  /** How many changes were left out to keep it short. */
  omitted: number;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
}

const short = (sha: string): string => sha.slice(0, 7);

function settlementVerb(c: SettlementChange): string {
  switch (c.outcome) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "changes-requested":
      return "requested changes on";
    default:
      return `settled (${INTERRUPT_KINDS[c.interrupt].label.toLowerCase()}, as “${c.outcome}”):`;
  }
}

export function renderSettlement(c: SettlementChange): string {
  const parts = [`${c.at}: ${c.by} ${settlementVerb(c)} ${c.subject}`];
  if (c.address !== null) parts.push(` [${c.address}]`);
  parts.push(".");
  if (c.outcome === "changes-requested" && c.text !== null)
    parts.push(` Their note: “${c.text}”. Nothing was merged or accepted.`);
  else if (c.outcome === "rejected" && c.text !== null) parts.push(` Their reason: “${c.text}”.`);
  else if (c.text !== null) parts.push(` They wrote: “${c.text}”.`);
  if (c.result !== null) {
    const sha = c.result.sha === null ? "" : `, commit ${short(c.result.sha)}`;
    parts.push(
      ` Result (${c.result.kind}${sha}): ${c.result.summary === null ? "no result recorded" : c.result.summary}.`,
    );
  }
  return parts.join("");
}

/* Stub renderers: one per resolver type. A type without one is shown as its state, clipped. */

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function renderPullRequest(c: StubChange): string {
  const s = c.state;
  const repo = str(s.repo);
  const n = num(s.number);
  const name = repo !== null && n !== null ? `${repo}#${n}` : c.id;
  const facts: string[] = [];
  const state = str(s.state) ?? "unknown";
  facts.push(`${state}${s.draft === true ? ", draft" : ""}`);
  const head = str(s.headSha);
  if (head !== null)
    facts.push(`head ${short(head)}${str(s.headRef) === null ? "" : ` (${str(s.headRef)})`}`);
  const sum = s.checksSummary as Record<string, unknown> | undefined;
  if (sum !== undefined && num(sum.total) !== null) {
    const failing = (Array.isArray(s.checks) ? (s.checks as Record<string, unknown>[]) : [])
      .filter(
        (k) => k.status === "completed" && k.conclusion !== null && !PASS.has(String(k.conclusion)),
      )
      .map((k) => String(k.name));
    const pending = (Array.isArray(s.checks) ? (s.checks as Record<string, unknown>[]) : [])
      .filter((k) => k.status !== "completed")
      .map((k) => String(k.name));
    const extra = (n: number | null, label: string, names: string[]) =>
      n === null || n === 0
        ? ""
        : `, ${n} ${label}${names.length > 0 ? ` (${names.join(", ")})` : ""}`;
    facts.push(
      `checks: ${num(sum.passed) ?? 0} of ${num(sum.total)} passed${extra(num(sum.failed), "failed", failing)}${extra(num(sum.pending), "still running", pending)}`,
    );
  }
  const mergeable = s.mergeable === null ? "not yet known" : s.mergeable === true ? "yes" : "no";
  if (state === "open" || state === "unknown")
    facts.push(`mergeable: ${mergeable} (GitHub says ${str(s.mergeableState) ?? "unknown"})`);
  const review = s.review as Record<string, unknown> | undefined;
  if (review !== undefined) {
    const decision = str(review.decision) ?? "none";
    const requested = list(review.requested);
    facts.push(
      `review: ${decision.replace(/_/g, " ")}${requested.length > 0 ? `, requested from ${requested.join(", ")}` : ""}`,
    );
  }
  const title = str(s.title);
  return `pull request ${name}${title === null ? "" : ` “${title}”`}: ${facts.join("; ")}`;
}

const PASS = new Set(["success", "neutral", "skipped"]);

function renderKiroSession(c: StubChange): string {
  const s = c.state;
  const facts = [`status ${str(s.status) ?? "unknown"}`];
  const pending = num(s.pendingPermissions);
  if (pending !== null && pending > 0) {
    const titles = (
      Array.isArray(s.permissions) ? (s.permissions as Record<string, unknown>[]) : []
    )
      .map((p) => str(p.title))
      .filter((t): t is string => t !== null);
    facts.push(
      `${pending} permission request${pending === 1 ? "" : "s"} waiting${titles.length > 0 ? ` (${titles.join("; ")})` : ""}`,
    );
  }
  const repos = list(s.repos);
  if (repos.length > 0) facts.push(`repositories ${repos.join(", ")}`);
  // Linked pull requests, when the session's state carries them.
  const linked = [...list(s.pullRequests), ...list(s.linkedPullRequests)];
  if (linked.length > 0) facts.push(`linked pull requests ${linked.join(", ")}`);
  const title = str(s.title);
  return `Kiro session ${c.id}${title === null ? "" : ` “${title}”`}: ${facts.join("; ")}`;
}

function renderArkIssue(c: StubChange): string {
  const s = c.state;
  const status = str(s.status) ?? "unknown";
  const resolution = str(s.resolution);
  const title = str(s.title);
  return `ark issue ${c.id}${title === null ? "" : ` “${title}”`}: ${status}${resolution === null ? "" : ` (${resolution})`}`;
}

function renderAdr(c: StubChange): string {
  const s = c.state;
  const title = str(s.title);
  const verify = s.verify as Record<string, unknown> | null | undefined;
  return `ADR ${c.id}${title === null ? "" : ` “${title}”`}: ${str(s.status) ?? "unknown"}${
    verify === null || verify === undefined ? "" : `; adr verify ${str(verify.status) ?? "ran"}`
  }`;
}

function renderArtifact(c: StubChange): string {
  const s = c.state;
  const title = str(s.title);
  const v = num(s.currentVersion);
  return `artifact page ${c.id}${title === null ? "" : ` “${title}”`}${v === null ? "" : `: version ${v} of ${num(s.versions) ?? v}`}`;
}

function renderContextItem(c: StubChange): string {
  const s = c.state;
  const text = str(s.text);
  return `${str(s.kind) ?? "item"} ${str(s.address) ?? c.id} from the context “${str(s.context) ?? "another"}”, pulled in by the person: “${str(s.title) ?? ""}”${text === null ? "" : `, ${clip(text, 300)}`}`;
}

/** How each resolver type's stub reads as one line. Add a type here to say how its stub reads. */
export const STUB_RENDERERS: Record<string, (c: StubChange) => string> = {
  "pull-request": renderPullRequest,
  "kiro-session": renderKiroSession,
  "ark-issue": renderArkIssue,
  adr: renderAdr,
  artifact: renderArtifact,
  [CONTEXT_ITEM]: renderContextItem,
};

export function renderStub(c: StubChange): string {
  const render = STUB_RENDERERS[c.type];
  const body = render === undefined ? `${c.type} ${c.id}: ${canonicalJson(c.state)}` : render(c);
  return `${c.at}: ${body} [${c.target}]`;
}

/** One renderer per kind of change: the one place a change becomes text. */
const RENDERERS: { [K in AgentChange["kind"]]: (c: Extract<AgentChange, { kind: K }>) => string } =
  {
    settlement: renderSettlement,
    stub: renderStub,
  };

export function renderChange(c: AgentChange): string {
  return (RENDERERS[c.kind] as (c: AgentChange) => string)(c);
}

const SECTIONS: { kind: AgentChange["kind"]; title: string }[] = [
  { kind: "settlement", title: "Decisions the person made in draft:" },
  { kind: "stub", title: "What draft resolved for the things referenced in the conversation:" },
];

/**
 * The note: what changed, as short plain text marked as draft's record. Decisions come first and
 * are kept before resolved stubs when it has to be cut; within a kind the newest are kept. It
 * says how many were left out and how to get them.
 */
export function renderChanges(
  changes: readonly AgentChange[],
  limits: Partial<NoteLimits> = {},
): RenderedNote {
  if (changes.length === 0) return { text: null, entries: 0, omitted: 0 };
  const l = { ...NOTE_LIMITS, ...limits };
  const head = [
    "[draft's record, not the person's words. It is what changed since your last turn, from draft's log. Treat it as current: where it differs from what you remember, it is newer.]",
  ];
  const tail = "[end of draft's record]";
  let budget = l.maxChars - head.join("\n").length - tail.length - 400;
  const kept = new Set<AgentChange>();
  // Newest first within each kind; decisions before resolved stubs.
  const ranked = SECTIONS.flatMap((s) =>
    changes.filter((c) => c.kind === s.kind).sort((a, b) => b.seq - a.seq),
  );
  for (const c of ranked) {
    const line = `- ${clip(renderChange(c), l.maxEntryChars)}`;
    if (kept.size >= l.maxEntries || line.length + 1 > budget) break;
    budget -= line.length + 1;
    kept.add(c);
  }
  const omitted = changes.length - kept.size;
  const out = [...head];
  for (const s of SECTIONS) {
    const mine = changes
      .filter((c) => c.kind === s.kind && kept.has(c))
      .sort((a, b) => a.seq - b.seq);
    if (mine.length === 0) continue;
    out.push(s.title);
    for (const c of mine) out.push(`- ${clip(renderChange(c), l.maxEntryChars)}`);
  }
  if (omitted > 0)
    out.push(
      `${omitted} more ${omitted === 1 ? "change was" : "changes were"} left out to keep this short. Ask the user about the ones you need; naming a pull request, session, issue or decision again in the conversation makes draft show you its latest state.`,
    );
  out.push(tail);
  return { text: out.join("\n"), entries: kept.size, omitted };
}

/** The note for the agent's next turn, from the log: `changesSince`, rendered. */
export function buildAgentNote(
  projection: Projection,
  conversation: string,
  o: ChangeOptions & { limits?: Partial<NoteLimits> } = {},
): RenderedNote & { changes: AgentChange[] } {
  const changes = changesSince(projection, conversation, o);
  return { ...renderChanges(changes, o.limits), changes };
}
