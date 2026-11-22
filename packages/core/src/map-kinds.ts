import { acceptanceSpec, evidenceGreen } from "./acceptance.ts";
import { tryParseAddress } from "./address.ts";
import { type DraftEvent, type LogRecord, type Target, targetKey } from "./events.ts";
import { INTERRUPT_KINDS, type InterruptKind, interruptMachine } from "./interrupts.ts";
import { bareToolName } from "./kiro.ts";
import {
  type EdgeDraft,
  foldMap,
  type ItemDraft,
  type KindDecl,
  type KindInput,
  KindRegistry,
  type MapQuery,
  type MapSnapshot,
  type PathEntry,
  statesOfMachine,
} from "./map.ts";
import { isFailedConclusion, pullRequestAcceptance } from "./pull-request.ts";
import { type THREAD_STATES, threadMachine } from "./thread.ts";

/**
 * The kinds draft runs today, as rows of the map. Each one reads what it needs from the log and
 * says which states it has; none of this is known to the fold in map.ts, so a kind that arrives
 * later registers the same way.
 *
 * Where a kind has a state machine (threads, interrupts, acceptance requests) its states are the
 * machine's. Steps and stubs have none yet, so their states are derived and the registry says so.
 */

type Ev = { event: DraftEvent; seq: number };

const entry = (state: string, e: Ev): PathEntry => ({ state, at: e.event.at, seq: e.seq });

/** Moves a path to `state` unless it is there already. */
function enter(path: PathEntry[], state: string, e: Ev): void {
  if (path.at(-1)?.state !== state) path.push(entry(state, e));
}

/** The conversation an address is in, as conversations are named: `context/conversation`. */
function conversationOf(address: string): string | null {
  const a = tryParseAddress(address);
  return a === null || a.conversation === null ? null : `${a.context}/${a.conversation}`;
}

/** The item a reference target is, when its resolver's kind is on the map. */
function targetItem(input: KindInput, t: Target): { kind: string; id: string } | null {
  const kind = input.kindOfTarget(t.type);
  return kind === null ? null : { kind, id: t.id };
}

const inConversation = (conversation: string, anchor: string | null = null) =>
  ({ kind: "conversation", conversation, anchor }) as const;

/* ----------------------------------------------------------------------------------------------- */
/* Threads                                                                                          */
/* ----------------------------------------------------------------------------------------------- */

function threadItems({ events }: KindInput): ItemDraft[] {
  const machine = threadMachine();
  const threads = new Map<string, { label: string; path: PathEntry[] }>();
  for (const e of events) {
    const d = e.event;
    if (d.type === "conversation.created" && d.data.parent !== null) {
      threads.set(d.data.conversation, { label: d.data.title, path: [entry(machine.initial, e)] });
      continue;
    }
    const t = d.conversation === null ? undefined : threads.get(d.conversation);
    if (t === undefined) continue;
    const state = t.path.at(-1)?.state as (typeof THREAD_STATES)[number];
    const fired =
      d.type === "thread.conclusion_proposed"
        ? machine.next(state, "propose", d.actor.kind)
        : d.type === "thread.wrapped_up"
          ? machine.next(state, "confirm", d.actor.kind)
          : d.type === "thread.conclusion_declined"
            ? machine.next(state, "decline", d.actor.kind)
            : d.type === "thread.ended"
              ? machine.next(state, d.data.state, d.actor.kind, d.data.reason)
              : null;
    // What the machine doesn't allow is a broken invariant, reported elsewhere; it moves nothing.
    if (fired?.ok === true) enter(t.path, fired.to, e);
  }
  return [...threads].map(([conversation, t]) => ({
    id: conversation,
    label: t.label,
    open: inConversation(conversation),
    path: t.path,
  }));
}

/**
 * What a thread says it is joined to: the thread it branched from, what its messages mention
 * (`reference.made`) and what its confirmed conclusion produced. A thread that branches off the
 * main conversation has no parent item, so it has no such edge.
 */
function threadEdges(input: KindInput): EdgeDraft[] {
  const threads = new Set<string>();
  for (const { event: d } of input.events)
    if (d.type === "conversation.created" && d.data.parent !== null)
      threads.add(d.data.conversation);
  const out: EdgeDraft[] = [];
  for (const { event: d } of input.events) {
    if (d.type === "conversation.created" && d.data.parent !== null) {
      const parent = conversationOf(d.data.parent);
      if (parent !== null && threads.has(parent))
        out.push({
          from: { kind: "thread", id: d.data.conversation },
          to: { kind: "thread", id: parent },
          rel: "part-of",
          at: d.at,
        });
    } else if (d.type === "reference.made") {
      const from = conversationOf(d.data.from);
      const to = targetItem(input, d.data.target);
      if (from !== null && threads.has(from) && to !== null)
        out.push({ from: { kind: "thread", id: from }, to, rel: d.data.relation, at: d.at });
    } else if (d.type === "thread.wrapped_up" && d.conversation !== null) {
      for (const t of d.data.cites.produced) {
        const to = targetItem(input, t);
        if (to !== null)
          out.push({ from: { kind: "thread", id: d.conversation }, to, rel: "produced", at: d.at });
      }
    }
  }
  return out;
}

export const THREAD_KIND: KindDecl = {
  id: "thread",
  label: "Threads",
  source: "machine",
  derivation: "the thread machine (thread.ts)",
  states: statesOfMachine(threadMachine().spec),
  alwaysShown: true,
  items: threadItems,
  edges: threadEdges,
};

/* ----------------------------------------------------------------------------------------------- */
/* Steps                                                                                            */
/* ----------------------------------------------------------------------------------------------- */

function stepItems({ events, live }: KindInput): ItemDraft[] {
  const steps = new Map<string, { label: string; conversation: string; path: PathEntry[] }>();
  for (const e of events) {
    const d = e.event;
    switch (d.type) {
      case "step.started":
        // A person answering a permission shows on the permission it answers, not as a step.
        if (bareToolName(d.data.name) === "kiro_answer_permission") break;
        steps.set(d.address, {
          label: d.data.name,
          conversation: d.conversation as string,
          path: [entry("running", e)],
        });
        break;
      case "step.completed":
      case "step.failed": {
        const s = steps.get(d.data.started);
        // The first outcome of a step is the one that counts.
        if (s !== undefined && s.path.length === 1)
          s.path.push(entry(d.type === "step.completed" ? "completed" : "failed", e));
        break;
      }
      case "interrupt.settled": {
        const s = d.data.started === null ? undefined : steps.get(d.data.started);
        if (s !== undefined && s.path.at(-1)?.state !== "completed") enter(s.path, "settled", e);
        break;
      }
    }
  }
  return [...steps].map(([address, s]) => {
    // The log doesn't say when a process lost a step, so it appears as interrupted from the start.
    if (live !== null && s.path.length === 1 && !live.runningSteps.has(address))
      s.path = [{ ...(s.path[0] as PathEntry), state: "interrupted" }];
    return {
      id: address,
      label: s.label,
      open: inConversation(s.conversation, address),
      path: s.path,
    };
  });
}

export const STEP_KIND: KindDecl = {
  id: "step",
  label: "Steps",
  source: "derived",
  derivation:
    "step.started, then step.completed or step.failed, then a person's settlement; unfinished and not running in this process is interrupted",
  states: [
    { id: "running", label: "Running", class: "active" },
    { id: "failed", label: "Failed", class: "waiting", waitsOn: "user" },
    { id: "interrupted", label: "Interrupted", class: "waiting", waitsOn: "user" },
    { id: "completed", label: "Completed", class: "terminal" },
    { id: "settled", label: "Settled", class: "terminal" },
  ],
  alwaysShown: true,
  items: stepItems,
};

/* ----------------------------------------------------------------------------------------------- */
/* Interrupts, by kind                                                                              */
/* ----------------------------------------------------------------------------------------------- */

/**
 * What a resolver raised, by its key. A key that comes back after it was cleared is a new episode,
 * so each episode is an item of its own, as it is in the conversation.
 */
function raisedEpisodes(events: readonly Ev[], kind: InterruptKind): ItemDraft[] {
  const episodes: {
    id: string;
    key: string;
    label: string;
    conversation: string;
    path: PathEntry[];
  }[] = [];
  const latest = (key: string) => episodes.findLast((x) => x.key === key);
  for (const e of events) {
    const d = e.event;
    if (d.type === "interrupt.raised" && d.data.kind === kind)
      episodes.push({
        id: d.id,
        key: d.data.key,
        label: d.data.summary,
        conversation: d.conversation as string,
        path: [entry("open", e)],
      });
    else if (d.type === "interrupt.cleared" && d.data.kind === kind) {
      for (const x of episodes)
        if (x.key === d.data.key && x.path.at(-1)?.state === "open")
          x.path.push(entry("cleared", e));
    } else if (d.type === "interrupt.settled" && d.data.kind === kind) {
      const x = latest(d.data.key);
      if (x !== undefined && x.path.at(-1)?.state === "open") x.path.push(entry("settled", e));
    }
  }
  return episodes.map((x) => ({
    id: x.id,
    label: x.label,
    open: inConversation(x.conversation, x.key),
    path: x.path,
  }));
}

/** A permission the agent asked of the person in this process, and how it ended. */
function localPermissions(events: readonly Ev[]): ItemDraft[] {
  const asked = new Map<
    string,
    { label: string; conversation: string; toolUseId: string; path: PathEntry[] }
  >();
  for (const e of events) {
    const d = e.event;
    if (d.type === "agent.permission_asked")
      asked.set(d.address, {
        label: `Allow ${d.data.name}?`,
        conversation: d.conversation as string,
        toolUseId: d.data.toolUseId,
        path: [entry("open", e)],
      });
    else if (d.type === "step.started" || d.type === "agent.tool_called") {
      // The answer is the step that follows (allowed) or the refused call (denied).
      for (const x of asked.values())
        if (
          x.conversation === d.conversation &&
          x.toolUseId === d.data.toolUseId &&
          x.path.length === 1
        )
          x.path.push(entry("settled", e));
    } else if (d.type === "agent.session_started") {
      // A session that starts again means the process that held the prompt is gone.
      for (const x of asked.values())
        if (x.conversation === d.conversation && x.path.length === 1)
          x.path.push(entry("cleared", e));
    }
  }
  return [...asked].map(([address, x]) => ({
    id: address,
    label: x.label,
    open: inConversation(x.conversation, address),
    path: x.path,
  }));
}

/** Calls that ran without the agent asking, settled by a person acknowledging them. */
function unaskedCalls(events: readonly Ev[]): ItemDraft[] {
  const calls = new Map<string, { label: string; conversation: string; path: PathEntry[] }>();
  for (const e of events) {
    const d = e.event;
    if (d.type === "agent.anomaly")
      calls.set(d.address, {
        label: `${d.data.name} ran without asking`,
        conversation: d.conversation as string,
        path: [entry("open", e)],
      });
    else if (d.type === "interrupt.settled" && d.data.kind === "unasked-call") {
      const c = calls.get(d.data.key);
      if (c !== undefined && c.path.length === 1) c.path.push(entry("settled", e));
    }
  }
  return [...calls].map(([address, c]) => ({
    id: address,
    label: c.label,
    open: inConversation(c.conversation, address),
    path: c.path,
  }));
}

/** Kinds of interrupt a resolver raises, and the rest that have a source of their own. */
const RAISED_KINDS: readonly InterruptKind[] = [
  "failed-check",
  "merge-conflict",
  "changes-requested",
  "review-requested",
];

function interruptKind(
  kind: InterruptKind,
  items: (i: KindInput) => ItemDraft[],
  alwaysShown: boolean,
): KindDecl {
  return {
    id: `interrupt:${kind}`,
    label: `Interrupts: ${INTERRUPT_KINDS[kind].label.toLowerCase()}`,
    source: "machine",
    derivation: `the interrupt machine of ${kind} (interrupts.ts)`,
    states: statesOfMachine(interruptMachine(kind).spec),
    alwaysShown,
    items,
  };
}

export const INTERRUPT_KIND_DECLS: readonly KindDecl[] = [
  interruptKind(
    "permission",
    ({ events }) => [...raisedEpisodes(events, "permission"), ...localPermissions(events)],
    true,
  ),
  interruptKind("unasked-call", ({ events }) => unaskedCalls(events), true),
  interruptKind("acceptance", ({ events }) => raisedEpisodes(events, "acceptance"), true),
  ...RAISED_KINDS.map((k) => interruptKind(k, ({ events }) => raisedEpisodes(events, k), false)),
];

/* ----------------------------------------------------------------------------------------------- */
/* Acceptance requests                                                                              */
/* ----------------------------------------------------------------------------------------------- */

/** What a person's answer to an acceptance request is, as a state of the request. */
const ANSWER_STATE: Record<string, string> = {
  accepted: "accepted",
  rejected: "rejected",
  "changes-requested": "changes-requested",
};

function acceptanceItems({ events }: KindInput): ItemDraft[] {
  const requests = new Map<
    string,
    {
      label: string;
      conversation: string;
      target: Target | null;
      from: string | null;
      path: PathEntry[];
    }
  >();
  const stubs = firstReferences(events);
  for (const e of events) {
    const d = e.event;
    if (d.type === "interrupt.raised" && d.data.kind === "acceptance") {
      const r = requests.get(d.data.key);
      const title = typeof d.data.detail.title === "string" ? d.data.detail.title : d.data.summary;
      if (r === undefined)
        requests.set(d.data.key, {
          label: title,
          conversation: d.conversation as string,
          target: d.data.target,
          from: null,
          path: [entry("requested", e)],
        });
      // The same request again, after its evidence went red and came back.
      else if (r.path.at(-1)?.state === "waiting") r.path.push(entry("requested", e));
    } else if (d.type === "interrupt.cleared" && d.data.kind === "acceptance") {
      const r = requests.get(d.data.key);
      if (r?.path.at(-1)?.state === "requested") r.path.push(entry("waiting", e));
    } else if (d.type === "interrupt.settled" && d.data.kind === "acceptance") {
      const r = requests.get(d.data.key);
      const to = ANSWER_STATE[d.data.outcome];
      if (r?.path.at(-1)?.state === "requested" && to !== undefined) r.path.push(entry(to, e));
    }
  }
  return [...requests].map(([key, r]) => {
    const stub = r.target === null ? undefined : stubs.get(targetKey(r.target));
    return {
      id: key,
      label: r.label,
      // A request lives where the thing it asks about does; without a stub, in its conversation.
      open:
        stub === undefined || r.target === null
          ? inConversation(r.conversation, key)
          : ({
              kind: "stub",
              target: targetKey(r.target),
              from: stub.from,
              conversation: stub.conversation,
            } as const),
      path: r.path,
    };
  });
}

/** An acceptance request is about the thing it asks to accept. */
function acceptanceEdges(input: KindInput): EdgeDraft[] {
  const out: EdgeDraft[] = [];
  const seen = new Set<string>();
  for (const { event: d } of input.events) {
    if (d.type !== "interrupt.raised" || d.data.kind !== "acceptance" || d.data.target === null)
      continue;
    const to = targetItem(input, d.data.target);
    if (to === null || seen.has(d.data.key)) continue;
    seen.add(d.data.key);
    out.push({ from: { kind: "acceptance", id: d.data.key }, to, rel: "asks-about", at: d.at });
  }
  return out;
}

export const ACCEPTANCE_KIND: KindDecl = {
  id: "acceptance",
  label: "Acceptance requests",
  source: "machine",
  derivation: "the acceptance machine (acceptance.ts), the same for every kind of record",
  states: statesOfMachine(acceptanceSpec(pullRequestAcceptance)),
  alwaysShown: true,
  items: acceptanceItems,
  edges: acceptanceEdges,
};

/* ----------------------------------------------------------------------------------------------- */
/* Stubs: Kiro sessions and pull requests                                                           */
/* ----------------------------------------------------------------------------------------------- */

/** Where each target was first mentioned: the message, and the conversation it is in. */
function firstReferences(
  events: readonly Ev[],
): Map<string, { from: string; conversation: string }> {
  const out = new Map<string, { from: string; conversation: string }>();
  for (const e of events) {
    const d = e.event;
    if (d.type !== "reference.made") continue;
    const key = targetKey(d.data.target);
    if (!out.has(key)) out.set(key, { from: d.data.from, conversation: d.conversation as string });
  }
  return out;
}

/**
 * A stub's states over time: what the resolver said of its target, each time it said something
 * different. The first reference seeds it with the snapshot; later references leave it alone.
 */
function stubItems(
  type: string,
  stateOf: (id: string, state: Record<string, unknown>) => string,
  labelOf: (id: string, state: Record<string, unknown>) => string,
): (i: KindInput) => ItemDraft[] {
  return ({ events }) => {
    const refs = firstReferences(events);
    const stubs = new Map<string, { id: string; label: string; path: PathEntry[] }>();
    for (const e of events) {
      const d = e.event;
      if (
        (d.type !== "reference.made" && d.type !== "status.observed") ||
        d.data.target.type !== type
      )
        continue;
      const key = targetKey(d.data.target);
      const known = stubs.get(key);
      if (d.type === "reference.made" && known !== undefined) continue;
      const state = d.type === "reference.made" ? d.data.snapshot : d.data.state;
      const now = stateOf(d.data.target.id, state);
      const label = labelOf(d.data.target.id, state);
      if (known === undefined)
        stubs.set(key, { id: d.data.target.id, label, path: [entry(now, e)] });
      else {
        known.label = label;
        enter(known.path, now, e);
      }
    }
    return [...stubs].flatMap(([key, s]) => {
      const where = refs.get(key);
      return where === undefined
        ? []
        : [
            {
              id: s.id,
              label: s.label,
              open: {
                kind: "stub",
                target: key,
                from: where.from,
                conversation: where.conversation,
              } as const,
              path: s.path,
            },
          ];
    });
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** What Kiro Remote reports a session's status as (kiro.ts); anything else is "unknown". */
export const KIRO_SESSION_STATES: readonly KindDecl["states"][number][] = [
  { id: "provisioning", label: "Starting", class: "active" },
  { id: "running", label: "Running", class: "active" },
  { id: "idle", label: "Idle", class: "active" },
  { id: "awaiting_permission", label: "Waiting for you", class: "waiting", waitsOn: "user" },
  { id: "unknown", label: "Unknown", class: "active" },
  { id: "failed", label: "Failed", class: "terminal" },
  { id: "deleted", label: "Deleted", class: "terminal" },
];

export const KIRO_SESSION_KIND: KindDecl = {
  id: "kiro-session",
  label: "Kiro sessions",
  source: "derived",
  derivation: "the status Kiro Remote reports for the session; a status it doesn't know is unknown",
  states: KIRO_SESSION_STATES,
  targetType: "kiro-session",
  alwaysShown: true,
  items: stubItems(
    "kiro-session",
    (_id, s) => {
      const status = str(s.status);
      return KIRO_SESSION_STATES.some((x) => x.id === status) ? (status as string) : "unknown";
    },
    (id, s) => str(s.title) ?? `Session ${id.slice(0, 8)}`,
  ),
};

/**
 * A pull request's state as a person meets it, the first that applies: it ended; a check failed or
 * it has a conflict; changes were requested; it is a draft; it is ready (the evidence acceptance
 * asks for is green); a review is asked of the person; checks are still running; else open.
 */
export function pullRequestMapState(id: string, s: Record<string, unknown>): string {
  if (s.state === "merged") return "merged";
  if (s.state === "closed") return "closed";
  const checks = Array.isArray(s.checks)
    ? (s.checks as { status?: string; conclusion?: string | null }[])
    : [];
  if (
    s.mergeableState === "dirty" ||
    checks.some((c) => c.status === "completed" && isFailedConclusion(c.conclusion ?? null))
  )
    return "failing";
  const review = s.review as { decision?: string } | undefined;
  if (review?.decision === "changes_requested") return "changes-requested";
  if (s.draft === true) return "draft";
  try {
    const subject = pullRequestAcceptance.subject({ type: "pull-request", id }, s);
    if (subject !== null && evidenceGreen(subject.evidence)) return "ready";
  } catch {
    // A snapshot too thin to judge: it is open, nothing more.
  }
  if (s.viewerReviewRequested === true) return "review-requested";
  if (checks.some((c) => c.status !== "completed") || s.mergeable === null) return "checking";
  return "open";
}

export const PULL_REQUEST_KIND: KindDecl = {
  id: "pull-request",
  label: "Pull requests",
  source: "derived",
  derivation:
    "the resolved pull request: its checks, conflicts, reviews and the acceptance evidence (pullRequestMapState)",
  states: [
    { id: "draft", label: "Draft", class: "active" },
    { id: "open", label: "Open", class: "active" },
    { id: "checking", label: "Checking", class: "active" },
    { id: "failing", label: "Failing", class: "waiting", waitsOn: "user" },
    { id: "changes-requested", label: "Changes requested", class: "waiting", waitsOn: "user" },
    { id: "ready", label: "Ready to merge", class: "waiting", waitsOn: "user" },
    { id: "review-requested", label: "Review requested", class: "waiting", waitsOn: "user" },
    { id: "merged", label: "Merged", class: "terminal" },
    { id: "closed", label: "Closed", class: "terminal" },
  ],
  targetType: "pull-request",
  alwaysShown: true,
  items: stubItems("pull-request", pullRequestMapState, (id, s) => {
    const repo = str(s.repo);
    const title = str(s.title);
    const name = repo !== null && typeof s.number === "number" ? `${repo}#${s.number}` : id;
    return title === null ? name : `${name}: ${title}`;
  }),
};

/**
 * The merge commit of each merged pull request the log knows, by repository and commit: the last
 * state the log holds of it. A pull request whose state predates the field has none.
 */
export function mergedPullRequests(
  events: readonly Ev[],
): { id: string; repo: string; sha: string }[] {
  const latest = new Map<string, Record<string, unknown>>();
  for (const { event: d } of events) {
    if (
      (d.type !== "reference.made" && d.type !== "status.observed") ||
      d.data.target.type !== "pull-request"
    )
      continue;
    const state = d.type === "reference.made" ? d.data.snapshot : d.data.state;
    // A reference keeps the first snapshot as the stub's; a later observation is what is known now.
    if (d.type === "reference.made" && latest.has(d.data.target.id)) continue;
    latest.set(d.data.target.id, state);
  }
  return [...latest].flatMap(([id, s]) =>
    s.state === "merged" && str(s.repo) !== null && str(s.mergeCommitSha) !== null
      ? [{ id, repo: str(s.repo) as string, sha: str(s.mergeCommitSha) as string }]
      : [],
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* The registry                                                                                     */
/* ----------------------------------------------------------------------------------------------- */

/** The kinds of this build, in the order of the rows. A kind that arrives later registers here. */
export const mapRegistry = new KindRegistry();
for (const k of [
  THREAD_KIND,
  STEP_KIND,
  ...INTERRUPT_KIND_DECLS,
  ACCEPTANCE_KIND,
  KIRO_SESSION_KIND,
  PULL_REQUEST_KIND,
])
  mapRegistry.register(k);

/** The map of a context's log with the registered kinds. */
export function mapOf(records: readonly LogRecord[], query: MapQuery = {}): MapSnapshot {
  return foldMap(records, mapRegistry, query);
}
