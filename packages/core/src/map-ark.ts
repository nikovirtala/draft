import { foldStatus } from "./adr.ts";
import { type ArkIssueEvent, foldIssueStatus } from "./ark-issue.ts";
import {
  type AdrRecord,
  type ArkProblem,
  ArkRecords,
  type ArkRecordsOptions,
  type ArkSnapshot,
  type DeploymentRecord,
  type IssueRecord,
} from "./ark-records.ts";
import type { ItemDraft, KindDecl, KindInput, KindRegistry } from "./map.ts";
import type { PathEntry, StateDecl } from "./map-types.ts";

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
  return messages.length === 0 ? null : messages.join("; ");
}

const short = (repo: string) => repo.split("/").pop() ?? repo;

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

export const DECISION_KIND: KindDecl = {
  id: "decision",
  label: "Decisions",
  source: "derived",
  derivation:
    "the decision's event files, folded as adr folds them (foldStatus): the default branch, and the branch of an open pull request that proposes it",
  states: ADR_STATES,
  items: (input) => snapshotOf(input)?.adrs.map(decision) ?? [],
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

export const ISSUE_KIND: KindDecl = {
  id: "issue",
  label: "Issues",
  source: "derived",
  derivation:
    "the issue's event files, folded as issues folds them (foldIssueStatus); how it was closed is a note on the cell",
  states: ISSUE_STATES,
  items: (input) => snapshotOf(input)?.issues.map(issue) ?? [],
  freshness: (input) => freshness(input, (p) => p.source === "records"),
};

/* ----------------------------------------------------------------------------------------------- */
/* Deployments                                                                                      */
/* ----------------------------------------------------------------------------------------------- */

/** GitHub's deployment statuses; a failed run freezes the pipeline until a person acts. */
export const DEPLOYMENT_STATES: readonly StateDecl[] = [
  { id: "queued", label: "Queued", class: "active" },
  { id: "in_progress", label: "In progress", class: "active" },
  { id: "failure", label: "Failed", class: "waiting", waitsOn: "user" },
  { id: "error", label: "Error", class: "waiting", waitsOn: "user" },
  { id: "success", label: "Succeeded", class: "terminal" },
  { id: "inactive", label: "Inactive", class: "terminal" },
];

const DEPLOYMENT_STATE_IDS = new Set(DEPLOYMENT_STATES.map((s) => s.id));

/** A status as a state: a deployment that is waiting, pending or unknown is queued. */
function deploymentState(state: string): string {
  return DEPLOYMENT_STATE_IDS.has(state) ? state : "queued";
}

function deployment(d: DeploymentRecord): ItemDraft {
  const path: PathEntry[] = [{ state: "queued", at: time(d.createdAt), seq }];
  for (const s of d.statuses) {
    const state = deploymentState(s.state);
    if (path.at(-1)?.state !== state) path.push({ state, at: time(s.at), seq });
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

/** The row of one environment of one repository. */
export function deploymentKind(repo: string, environment: string): KindDecl {
  return {
    id: `deployment:${repo}:${environment}`,
    label: `Deployments: ${short(repo)} · ${environment}`,
    source: "derived",
    derivation:
      "the latest status of each GitHub Deployment of the repository and environment, which @nikovirtala/deployment records for every run",
    states: DEPLOYMENT_STATES,
    items: (input) =>
      snapshotOf(input)
        ?.deployments.filter((d) => d.repo === repo && d.environment === environment)
        .map(deployment) ?? [],
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
  private readonly viewers = new Set<string>();
  private inFlight: Promise<boolean> | null = null;

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
    this.inFlight ??= this.records
      .refresh(this.o.intervalMs ?? 30_000)
      .then((changed) => {
        this.syncRows();
        return changed;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** A row for each repository and environment that has a deployment, and no other. */
  private syncRows(): void {
    const wanted = new Map<string, [string, string]>();
    for (const d of this.records.snapshot().deployments)
      wanted.set(`${d.repo}:${d.environment}`, [d.repo, d.environment]);
    for (const [key, remove] of this.rows)
      if (!wanted.has(key)) {
        remove();
        this.rows.delete(key);
      }
    for (const [key, [repo, environment]] of [...wanted].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!this.rows.has(key))
        this.rows.set(key, this.registry.register(deploymentKind(repo, environment)));
  }
}
