import { foldStatus } from "./adr.ts";
import { ARK_ID, type ArkIssueEvent, foldIssueStatus } from "./ark-issue.ts";
import {
  type AdrRecord,
  type ArkProblem,
  ArkRecords,
  type ArkRecordsOptions,
  type ArkSnapshot,
  type DeploymentRecord,
  type IssueRecord,
} from "./ark-records.ts";
import {
  canonicalEnvironment,
  type EnvironmentTopology,
  environmentOrder,
  sameEnvironment,
} from "./environments.ts";
import type { EdgeDraft, ItemDraft, KindDecl, KindInput, KindRegistry } from "./map.ts";
import { mergedPullRequests } from "./map-kinds.ts";
import type { ItemRef, KindOrder, PathEntry, StateDecl } from "./map-types.ts";

/**
 * The ark kinds as rows of the map: decisions, issues and the deployments of each repository and
 * environment. They are kinds like any other. Each declares its states and lists its items from a
 * source the host read (`ArkRecords`), and the fold knows none of them. The folds that turn events
 * into a status are the resolvers' own (`foldStatus`, `foldIssueStatus`), applied to each prefix of
 * a record's history to get the path it took.
 */

/** The source name the host puts the records under in `MapQuery.sources`. */
export const ARK_SOURCE = "ark";

const snapshotOf = (input: KindInput): ArkSnapshot | null =>
  (input.sources[ARK_SOURCE] as ArkSnapshot | undefined) ?? null;

/** Where an item that lives outside the log is in it: nowhere. */
const seq = -1;

/** A time as the log writes it, whatever precision the source gave. */
const time = (at: string): string => new Date(at).toISOString();

/** The states a status took over a record's events, with the time of the event that moved it. */
function pathOf<E extends { at: string }>(
  events: readonly E[],
  status: (prefix: readonly E[]) => string,
): PathEntry[] {
  const path: PathEntry[] = [];
  events.forEach((e, i) => {
    const state = status(events.slice(0, i + 1));
    if (path.at(-1)?.state !== state) path.push({ state, at: time(e.at), seq });
  });
  return path;
}

/**
 * Why a kind's counts may not be current: nothing has been read yet, or something could not be
 * read the last time. Null when they are current.
 */
function freshness(input: KindInput, wanted: (p: ArkProblem) => boolean): string | null {
  const s = snapshotOf(input);
  if (s === null || s.repos.length === 0) return null;
  if (s.loading) return `still reading ${s.repos.join(", ")} from GitHub`;
  const messages = [...new Set(s.problems.filter(wanted).map((p) => p.message))];
  // What an earlier launch kept is on screen until a refresh has read it all again.
  if (s.asOf != null)
    messages.unshift(
      `as of ${s.asOf.slice(0, 16).replace("T", " ")} UTC, as the last launch read it; reading GitHub for what changed`,
    );
  return messages.length === 0 ? null : messages.join("; ");
}

const short = (repo: string) => repo.split("/").pop() ?? repo;

/**
 * The record a link names, as the event wrote it: a bare id, `adr:<id>`, or `<source>:<id>` or
 * `<owner/repo>:<id>`. It is looked for in the repository of the record that made the link first,
 * then anywhere the context covers; null when no such record is there to be drawn.
 */
function recordRef(
  s: ArkSnapshot,
  repo: string,
  to: string,
  fallback: "decision" | "issue",
): ItemRef | null {
  const m = new RegExp(`^(?:(.+):)?(${ARK_ID})$`).exec(to.trim());
  if (m === null) return null;
  const prefix = m[1] ?? null;
  const id = m[2] as string;
  const kind = prefix === "adr" ? "decision" : prefix === "issue" ? "issue" : fallback;
  const records: { repo: string; id: string }[] = kind === "decision" ? s.adrs : s.issues;
  const named = prefix?.includes("/") === true ? prefix : null;
  const found =
    records.find((r) => r.id === id && r.repo === (named ?? repo)) ??
    (named === null ? records.find((r) => r.id === id) : undefined);
  return found === undefined ? null : { kind, id: `${found.repo}:${found.id}` };
}

/* ----------------------------------------------------------------------------------------------- */
/* Decisions                                                                                        */
/* ----------------------------------------------------------------------------------------------- */

export const ADR_STATES: readonly StateDecl[] = [
  { id: "proposed", label: "Proposed", class: "waiting", waitsOn: "user" },
  { id: "accepted", label: "Accepted", class: "terminal" },
  { id: "rejected", label: "Rejected", class: "terminal" },
  { id: "withdrawn", label: "Withdrawn", class: "terminal" },
  { id: "deprecated", label: "Deprecated", class: "terminal" },
  { id: "superseded", label: "Superseded", class: "terminal" },
];

function decision(a: AdrRecord): ItemDraft {
  return {
    id: `${a.repo}:${a.id}`,
    label: `${a.title ?? a.id} · ${short(a.repo)}`,
    open: {
      kind: "links",
      links: [
        { label: "Decision", url: a.url },
        ...(a.proposal === null
          ? []
          : [{ label: `Pull request #${a.proposal.number}`, url: a.proposal.url }]),
      ],
    },
    path: pathOf(a.events, foldStatus),
  };
}

/** What a decision says it replaces, what replaced it, and what it is linked to. */
function decisionEdges(input: KindInput): EdgeDraft[] {
  const s = snapshotOf(input);
  const out: EdgeDraft[] = [];
  for (const a of s?.adrs ?? []) {
    const self = { kind: "decision", id: `${a.repo}:${a.id}` };
    for (const id of a.supersedes) {
      const to = recordRef(s as ArkSnapshot, a.repo, id, "decision");
      if (to !== null) out.push({ from: self, to, rel: "supersedes" });
    }
    for (const id of a.supersededBy) {
      const from = recordRef(s as ArkSnapshot, a.repo, id, "decision");
      if (from !== null) out.push({ from, to: self, rel: "supersedes" });
    }
    for (const l of a.links) {
      const to = recordRef(s as ArkSnapshot, a.repo, l.to, "decision");
      if (to !== null) out.push({ from: self, to, rel: l.rel });
    }
  }
  return out;
}

export const DECISION_KIND: KindDecl = {
  id: "decision",
  label: "Decisions",
  source: "derived",
  derivation:
    "the decision's event files, folded as adr folds them (foldStatus): the default branch, and the branch of an open pull request that proposes it",
  states: ADR_STATES,
  targetType: "adr",
  items: (input) => snapshotOf(input)?.adrs.map(decision) ?? [],
  edges: decisionEdges,
  freshness: (input) => freshness(input, (p) => p.source === "records"),
};

/* ----------------------------------------------------------------------------------------------- */
/* Issues                                                                                           */
/* ----------------------------------------------------------------------------------------------- */

export const ISSUE_STATES: readonly StateDecl[] = [
  { id: "open", label: "Open", class: "active" },
  { id: "in-progress", label: "In progress", class: "active" },
  { id: "closed", label: "Closed", class: "terminal" },
];

function issue(i: IssueRecord): ItemDraft {
  return {
    id: `${i.repo}:${i.id}`,
    label: `${i.title ?? i.id} · ${short(i.repo)}`,
    // How it was closed is what the cell says about it, not a state of its own.
    note: i.resolution,
    open: { kind: "links", links: [{ label: "Issue", url: i.url }] },
    path: pathOf<ArkIssueEvent>(i.events, foldIssueStatus),
  };
}

/** The issue it is part of, and what it depends on, relates to or implements. */
function issueEdges(input: KindInput): EdgeDraft[] {
  const s = snapshotOf(input);
  const out: EdgeDraft[] = [];
  for (const i of s?.issues ?? []) {
    const self = { kind: "issue", id: `${i.repo}:${i.id}` };
    if (i.parent !== null) {
      const to = recordRef(s as ArkSnapshot, i.repo, i.parent, "issue");
      if (to !== null) out.push({ from: self, to, rel: "part-of" });
    }
    for (const l of i.links) {
      const to = recordRef(s as ArkSnapshot, i.repo, l.to, "issue");
      if (to !== null) out.push({ from: self, to, rel: l.rel });
    }
  }
  return out;
}

export const ISSUE_KIND: KindDecl = {
  id: "issue",
  label: "Issues",
  source: "derived",
  derivation:
    "the issue's event files, folded as issues folds them (foldIssueStatus); how it was closed is a note on the cell",
  states: ISSUE_STATES,
  targetType: "ark-issue",
  items: (input) => snapshotOf(input)?.issues.map(issue) ?? [],
  edges: issueEdges,
  freshness: (input) => freshness(input, (p) => p.source === "records"),
};

/* ----------------------------------------------------------------------------------------------- */
/* Deployments                                                                                      */
/* ----------------------------------------------------------------------------------------------- */

/**
 * GitHub's deployment statuses, and two states a failed run reaches without GitHub saying so.
 * @nikovirtala/deployment leaves a failure as `failure` for good, so whether it still needs a
 * person is read from the runs after it: a failed or errored run waits on the person only while it
 * is the newest deployment of its repository and environment.
 */
export const DEPLOYMENT_STATES: readonly StateDecl[] = [
  { id: "queued", label: "Queued", class: "active" },
  { id: "in_progress", label: "In progress", class: "active" },
  { id: "failure", label: "Failed", class: "waiting", waitsOn: "user" },
  { id: "error", label: "Error", class: "waiting", waitsOn: "user" },
  { id: "success", label: "Succeeded", class: "terminal" },
  { id: "inactive", label: "Inactive", class: "terminal" },
  { id: "recovered", label: "Failed, then succeeded", class: "terminal" },
  { id: "replaced", label: "Failed, then replaced", class: "terminal" },
];

const DEPLOYMENT_STATE_IDS = new Set(DEPLOYMENT_STATES.map((s) => s.id));

/** A status as a state: a deployment that is waiting, pending or unknown is queued. */
function deploymentState(state: string): string {
  return DEPLOYMENT_STATE_IDS.has(state) ? state : "queued";
}

const failed = (state: string | undefined): boolean => state === "failure" || state === "error";

/** Which deployment came later: by when it was created, then by id. */
const newer = (a: DeploymentRecord, b: DeploymentRecord): boolean => {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  return at !== bt ? at > bt : a.id > b.id;
};

/** The topology of a repository, as the snapshot read it; null when none says. */
const topologyOfRepo = (s: ArkSnapshot | null, repo: string): EnvironmentTopology | null =>
  s?.environments?.find((t) => t.repo === repo) ?? null;

/** One deployment that fixes a failed one: the edge `supersedes`, from the fixing run to the failure. */
export interface Supersession {
  fixing: DeploymentRecord;
  failed: DeploymentRecord;
  /** When the fixing run succeeded. */
  at: string;
}

/**
 * Which deployment fixes which: the one rule of supersession, read by both the settled state and
 * the `supersedes` edge. A failed or errored deployment is fixed by the first run after it that
 * succeeded, in the same repository and the same environment: a success in another environment
 * fixes nothing, whether the two are in sequence (staging, then production) or in parallel
 * (regions), because a deployment is matched to its own environment, spelled as the topology
 * spells it. Without a topology the environment is the name the run was recorded under.
 */
export function supersessions(
  deployments: readonly DeploymentRecord[],
  topology: EnvironmentTopology | null = null,
): Supersession[] {
  const inEnvironment = (a: DeploymentRecord, b: DeploymentRecord) =>
    a.repo === b.repo &&
    sameEnvironment(
      canonicalEnvironment(topology, a.environment),
      canonicalEnvironment(topology, b.environment),
    );
  const out: Supersession[] = [];
  for (const failed of deployments) {
    if (!failedLatest(failed)) continue;
    let fix: Supersession | null = null;
    for (const o of deployments) {
      if (o.id === failed.id || !newer(o, failed) || !inEnvironment(o, failed)) continue;
      for (const s of o.statuses) {
        if (s.state !== "success") continue;
        const at = time(s.at);
        if (fix === null || at < fix.at || (at === fix.at && newer(fix.fixing, o)))
          fix = { fixing: o, failed, at };
      }
    }
    if (fix !== null) out.push(fix);
  }
  return out;
}

/** Whether a deployment's latest status is a failure or an error. */
const failedLatest = (d: DeploymentRecord): boolean => failed(d.statuses.at(-1)?.state);

/**
 * What happened to a failed deployment after it: a `supersedes` edge into it settles it as
 * recovered, when the fixing run succeeded; else a later run of its environment replaces it
 * (the newer one is what waits, if it failed too); else it is the newest and still waits.
 */
function settlement(
  d: DeploymentRecord,
  all: readonly DeploymentRecord[],
  fixes: readonly Supersession[],
): PathEntry | null {
  const fix = fixes.find((f) => f.failed.id === d.id);
  if (fix !== undefined) return { state: "recovered", at: fix.at, seq };
  const next = all
    .filter((o) => newer(o, d))
    .reduce<DeploymentRecord | null>(
      (first, o) => (first === null || newer(first, o) ? o : first),
      null,
    );
  return next === null ? null : { state: "replaced", at: time(next.createdAt), seq };
}

function deployment(
  d: DeploymentRecord,
  all: readonly DeploymentRecord[],
  fixes: readonly Supersession[],
): ItemDraft {
  const path: PathEntry[] = [{ state: "queued", at: time(d.createdAt), seq }];
  for (const s of d.statuses) {
    const state = deploymentState(s.state);
    if (path.at(-1)?.state !== state) path.push({ state, at: time(s.at), seq });
  }
  if (failed(path.at(-1)?.state)) {
    const settled = settlement(d, all, fixes);
    if (settled !== null) path.push(settled);
  }
  const run = [...d.statuses].reverse().find((s) => s.logUrl !== null || s.environmentUrl !== null);
  const url = run?.logUrl ?? run?.environmentUrl ?? null;
  return {
    id: String(d.id),
    label: `${d.ref === d.sha ? d.sha.slice(0, 7) : d.ref} · ${d.sha.slice(0, 7)}`,
    open: {
      kind: "links",
      links: [
        { label: "Commit", url: d.commitUrl },
        ...(url === null ? [] : [{ label: "Run", url }]),
      ],
    },
    path,
  };
}

/** The deployments of one environment of a repository, as the topology spells it. */
function inEnvironment(
  s: ArkSnapshot | null,
  repo: string,
  environment: string,
): { all: DeploymentRecord[]; topology: EnvironmentTopology | null } {
  const topology = topologyOfRepo(s, repo);
  const all = (s?.deployments ?? []).filter(
    (d) =>
      d.repo === repo &&
      sameEnvironment(
        canonicalEnvironment(topology, d.environment),
        canonicalEnvironment(topology, environment),
      ),
  );
  return { all, topology };
}

/** The id of the row of one environment of one repository. */
export const deploymentKindId = (repo: string, environment: string): string =>
  `deployment:${repo}:${environment}`;

/**
 * The row of one environment of one repository. `order` is its place among the repository's
 * environments, so the graph draws them as the topology orders them.
 */
export function deploymentKind(repo: string, environment: string, order?: KindOrder): KindDecl {
  const id = deploymentKindId(repo, environment);
  return {
    id,
    label: `Deployments: ${short(repo)} · ${environment}`,
    ...(order === undefined ? {} : { order }),
    source: "derived",
    derivation:
      "the latest status of each GitHub Deployment of the repository and environment, which @nikovirtala/deployment records for every run; a failed or errored run waits on the person only while it is the newest of its environment (by created_at, then id): a later success in the same environment settles it as failed, then succeeded, through a supersedes edge from the run that fixed it, and a later run that did not succeed as failed, then replaced",
    states: DEPLOYMENT_STATES,
    items: (input) => {
      const { all, topology } = inEnvironment(snapshotOf(input), repo, environment);
      const fixes = supersessions(all, topology);
      return all.map((d) => deployment(d, all, fixes));
    },
    edges: (input) => {
      const { all, topology } = inEnvironment(snapshotOf(input), repo, environment);
      // A run that fixes a failed one of its environment supersedes it.
      const edges: EdgeDraft[] = supersessions(all, topology).map((f) => ({
        from: { kind: id, id: String(f.fixing.id) },
        to: { kind: id, id: String(f.failed.id) },
        rel: "supersedes",
        at: f.at,
      }));
      // A run deploys the pull request whose merge commit it deployed, when the log has that pull request.
      const pulls = input.kindOfTarget("pull-request");
      if (pulls === null) return edges;
      const merged = mergedPullRequests(input.events).filter((m) => m.repo === repo);
      for (const d of all) {
        const pr = merged.find((m) => m.sha === d.sha);
        if (pr !== undefined)
          edges.push({
            from: { kind: id, id: String(d.id) },
            to: { kind: pulls, id: pr.id },
            rel: "deploys",
            at: time(d.createdAt),
          });
      }
      return edges;
    },
    freshness: (input) => freshness(input, (p) => p.source === "deployments" && p.repo === repo),
  };
}

/* ----------------------------------------------------------------------------------------------- */
/* The source of a context                                                                          */
/* ----------------------------------------------------------------------------------------------- */

export interface ArkMapOptions extends ArkRecordsOptions {
  /** How long between refreshes while a map is on screen. */
  intervalMs?: number;
}

/**
 * The ark side of one context's map: its records, and the rows they bring. It registers the
 * decision and issue kinds, and one kind for each repository and environment that has a
 * deployment, in the registry it is given. The map is read while a map is on screen, as stubs are.
 */
export class ArkMap {
  readonly records: ArkRecords;
  private readonly rows = new Map<string, () => void>();
  private rowsSignature = "";
  private readonly viewers = new Set<string>();
  private inFlight: Promise<boolean> | null = null;
  /** Called when a read starts or ends, so a window can show that the map is being read. */
  onReading: () => void = () => {};

  constructor(
    private readonly registry: KindRegistry,
    private readonly o: ArkMapOptions,
  ) {
    this.records = new ArkRecords(o);
    registry.register(DECISION_KIND);
    registry.register(ISSUE_KIND);
  }

  /** Rises when what the kinds read has changed. */
  get version(): number {
    return this.records.version;
  }

  /** A read of GitHub is under way. */
  get reading(): boolean {
    return this.inFlight !== null;
  }

  /** What the kinds read: the records as of the last refresh. */
  sources(): Record<string, unknown> {
    return { [ARK_SOURCE]: this.records.snapshot() };
  }

  /** A viewer (a window) has a map on screen or no longer has. Nothing is read without one. */
  setVisible(viewer: string, on: boolean): void {
    if (!on) this.viewers.delete(viewer);
    else {
      if (this.viewers.size === 0 || !this.viewers.has(viewer)) this.records.wake();
      this.viewers.add(viewer);
    }
  }

  /** Reads what changed when a map is on screen and it is time. Returns whether the map changed. */
  tick(): Promise<boolean> {
    if (this.viewers.size === 0 || !this.records.due()) return Promise.resolve(false);
    return this.read();
  }

  /**
   * Reads the repositories now, map or no map: what a check needs to know about the decisions
   * that are proposed when a pull request merges. A read already under way is the one returned.
   */
  read(): Promise<boolean> {
    if (this.inFlight === null) {
      this.inFlight = this.records
        .refresh(this.o.intervalMs ?? 30_000)
        .then((changed) => {
          this.syncRows();
          return changed;
        })
        .finally(() => {
          this.inFlight = null;
          this.onReading();
        });
      this.onReading();
    }
    return this.inFlight;
  }

  /**
   * A row for each repository and environment that has a deployment, and no other, in the order
   * of the repository's topology: its environments one after another, each as the topology spells
   * it. When the order or the set changes, the rows are registered again in the new order.
   */
  private syncRows(): void {
    const snapshot = this.records.snapshot();
    const byRepo = new Map<string, string[]>();
    for (const d of [...snapshot.deployments].sort((a, b) => a.id - b.id)) {
      const topology = topologyOfRepo(snapshot, d.repo);
      byRepo.set(d.repo, [
        ...(byRepo.get(d.repo) ?? []),
        canonicalEnvironment(topology, d.environment),
      ]);
    }
    const wanted: { key: string; repo: string; environment: string; order: KindOrder }[] = [];
    for (const [repo, seen] of [...byRepo].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const topology = topologyOfRepo(snapshot, repo);
      const here = environmentOrder(topology, seen).filter((e) =>
        seen.some((s) => sameEnvironment(s, e)),
      );
      for (const [index, environment] of here.entries())
        wanted.push({
          key: `${repo}:${environment}`,
          repo,
          environment,
          order: { group: repo, index, of: here.length },
        });
    }
    const signature = JSON.stringify(wanted);
    if (signature === this.rowsSignature) return;
    this.rowsSignature = signature;
    for (const remove of this.rows.values()) remove();
    this.rows.clear();
    for (const w of wanted)
      this.rows.set(w.key, this.registry.register(deploymentKind(w.repo, w.environment, w.order)));
  }
}
