import { ARK_ID, type ArkIssueEvent, dataField, dataList, parseEventFiles } from "./ark-issue.ts";
import { canonicalJson } from "./canonical.ts";
import { type EnvironmentTopology, parseGithubEnvironments, topologyOf } from "./environments.ts";
import { type GithubClient, GithubError } from "./github.ts";
import type { ReadCache } from "./read-cache.ts";

/**
 * What the ark kinds of a context are made from: every decision, every issue and every deployment
 * of the repositories it covers, read through draft's read-only GitHub client, in the main
 * process, with the person's token and never the agent's.
 *
 * Reading everything has to stay cheap, so a refresh costs a few conditional requests when
 * nothing moved:
 *
 * - **One git tree per repository** lists every event file of every decision and issue, with each
 *   file's blob sha. The tree's own sha is kept: when it is the same as last time, nothing under
 *   it is read again. A file is fetched only when its blob sha is new (a title, a resolution), and
 *   never twice, since a blob's content can't change.
 * - **Open pull requests** are listed once; a pull request's tree is read once per head sha, to
 *   find decisions that are proposed on a branch and not on the default branch yet.
 * - **Deployments** are listed once; statuses are read only for a deployment that is new, still
 *   moving, or last seen as a success (a newer run may have made it inactive).
 * - **Environments** are the repository's topology, read as data from where it lives: GitHub's
 *   list of its environments, and the environment its `deploy.toml` names (a file found in the
 *   tree already read, fetched once by blob sha). See environments.ts.
 * - Requests carry the ETag of what was seen, so an unchanged answer is a 304, which GitHub doesn't
 *   count against the rate limit. When GitHub says the limit is used up, nothing is asked until it
 *   resets, and the map says its counts are from before.
 *
 * With a `ReadCache` (ADR t76jn29d) what was read outlives the process: a blob is fetched once per
 * device, a response keeps its ETag, and the last snapshot is shown at launch, as of when it was
 * read, until the first refresh replaces it. Without a cache each launch starts from nothing.
 */

/** How many files a refresh reads at once. */
export const BLOB_CONCURRENCY = 6;
/** How many files the first refresh of a context may fetch, to fill a map that has nothing yet. */
export const FIRST_REFRESH_BLOBS = 600;
/** How many files a later refresh may fetch. */
export const REFRESH_BLOBS = 100;

/** The shape of what is stored for a context; a stored snapshot of another shape is not shown. */
const STORED = 1;

export interface ArkRecordsOptions {
  github: GithubClient;
  /** The repositories this context covers, `owner/repo`, read at each refresh. */
  repos: () => readonly string[];
  /** Where the decision log and the issue log are in each repository. */
  adrRoot?: string;
  issuesRoot?: string;
  /** How many open pull requests are searched for proposals, and deployments are read. */
  maxPulls?: number;
  maxDeployments?: number;
  /** How many files one refresh may fetch; the rest wait for the next one. Default `REFRESH_BLOBS`. */
  maxBlobsPerRefresh?: number;
  /** How many files the first refresh may fetch. Default `FIRST_REFRESH_BLOBS`. */
  firstRefreshBlobs?: number;
  /** How many files are read at once. Default `BLOB_CONCURRENCY`. */
  blobConcurrency?: number;
  /** Keeps what was read across launches. Without it every launch starts from nothing. */
  cache?: ReadCache;
  /** Names this context's stored snapshot in the cache. */
  cacheKey?: string;
  now?: () => number;
}

/** A link one record makes to another, as the event says it: `to` as written, `rel` as written. */
export interface ArkLink {
  rel: string;
  to: string;
}

/** A decision, as the default branch and the open pull requests that propose changes to it say. */
export interface AdrRecord {
  repo: string;
  id: string;
  title: string | null;
  /** Oldest first, from the branch while a pull request proposes it. */
  events: ArkIssueEvent[];
  /** The open pull request whose branch the events were read from; null for the default branch. */
  proposal: { number: number; url: string; headRef: string; headSha: string } | null;
  /** The decisions it says it supersedes (its proposal) and the ones that say they replaced it. */
  supersedes: string[];
  supersededBy: string[];
  /** Its links to other records that are still in force (`linked`, less `unlinked`). */
  links: ArkLink[];
  url: string;
}

export interface IssueRecord {
  repo: string;
  id: string;
  title: string | null;
  events: ArkIssueEvent[];
  /** How a closed issue was closed: done, wontfix, duplicate or obsolete. */
  resolution: string | null;
  /** The issue it is part of, as written in the event that opened it. */
  parent: string | null;
  /** Its links to other issues and decisions that are still in force. */
  links: ArkLink[];
  url: string;
}

export interface DeploymentStatusRecord {
  /** GitHub's word: queued, in_progress, success, failure, error, inactive, pending. */
  state: string;
  at: string;
  logUrl: string | null;
  environmentUrl: string | null;
}

export interface DeploymentRecord {
  repo: string;
  id: number;
  environment: string;
  sha: string;
  ref: string;
  createdAt: string;
  commitUrl: string;
  /** Oldest first. */
  statuses: DeploymentStatusRecord[];
}

/** What could not be read, and from which source: `records` (decisions and issues) or `deployments`. */
export interface ArkProblem {
  repo: string;
  source: "records" | "deployments";
  message: string;
}

export interface ArkSnapshot {
  /** Rises when anything a kind shows changed. */
  version: number;
  /** Nothing has been read yet. */
  loading: boolean;
  repos: string[];
  /** When the last refresh ended; null before the first. */
  readAt: string | null;
  /**
   * When what is shown was read, while it is the snapshot kept from an earlier launch and no
   * refresh has replaced it yet; null otherwise.
   */
  asOf?: string | null;
  adrs: AdrRecord[];
  issues: IssueRecord[];
  deployments: DeploymentRecord[];
  /** The environments of each repository that says which it has, by repository. */
  environments: EnvironmentTopology[];
  problems: ArkProblem[];
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}
interface Tree {
  sha: string;
  truncated?: boolean;
  tree: TreeEntry[];
}
interface EventFile extends ArkIssueEvent {
  blob: string;
}
interface Parsed {
  adrs: Map<string, EventFile[]>;
  issues: Map<string, EventFile[]>;
}
/** What a context's cache entry holds: where each repository was read to, and what it showed. */
interface StoredMarker {
  v: number;
  repos: {
    repo: string;
    treeSha: string | null;
    headKey: string;
    deployToml: string | null;
    deploymentIds: string;
    unread: boolean;
  }[];
}
interface StoredData {
  v: number;
  repos: {
    repo: string;
    adrs: AdrRecord[];
    issues: IssueRecord[];
    deployments: DeploymentRecord[];
    topology: EnvironmentTopology | null;
  }[];
}
interface PullHead {
  number: number;
  url: string;
  headRef: string;
  headSha: string;
}

/** The event files of every record under `root`, by record id, oldest first. */
function eventsUnder(tree: readonly TreeEntry[], root: string): Map<string, EventFile[]> {
  const prefix = `${root}/events/`;
  const files = new Map<string, TreeEntry[]>();
  for (const e of tree) {
    if (e.type !== "blob" || !e.path.startsWith(prefix)) continue;
    const [id, name, ...rest] = e.path.slice(prefix.length).split("/");
    if (id === undefined || name === undefined || rest.length > 0) continue;
    if (!new RegExp(`^${ARK_ID}$`).test(id)) continue;
    files.set(id, [...(files.get(id) ?? []), { ...e, path: name }]);
  }
  const out = new Map<string, EventFile[]>();
  for (const [id, entries] of files) {
    const blobs = new Map(entries.map((e) => [e.path, e.sha]));
    const events = parseEventFiles(entries.map((e) => ({ name: e.path, type: "file" })));
    if (events.length > 0)
      out.set(
        id,
        events.map((e) => ({ ...e, blob: blobs.get(e.file) as string })),
      );
  }
  return out;
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = o[k];
  return out;
}

/** The files of a record that its title, relations and resolution are read from, in order. */
function filesToRead(files: readonly EventFile[]): string[] {
  const closed = [...files].reverse().find((f) => f.type === "closed");
  return files
    .filter(
      (f) =>
        ["proposed", "opened", "superseded", "linked", "unlinked"].includes(f.type) ||
        (f === closed && files.at(-1)?.type === "closed"),
    )
    .map((f) => f.blob);
}

const sameFiles = (a: readonly EventFile[], b: readonly EventFile[]): boolean =>
  a.length === b.length && a.every((e, i) => e.blob === b[i]?.blob);

interface RepoData {
  treeSha: string | null;
  adrs: AdrRecord[];
  issues: IssueRecord[];
  deployments: DeploymentRecord[];
  topology: EnvironmentTopology | null;
  /** The blob sha of `deploy.toml` in the default branch's tree; null when it has none. */
  deployToml: string | null;
  /** What each pull request head's tree held, by head sha: a head's tree is read once. */
  heads: Map<string, Parsed>;
  deploymentIds: string;
  /** The pull request heads the decisions were last read with. */
  headKey: string;
  /** A title or resolution was left for a later refresh, because this one's budget ran out. */
  unread: boolean;
  problems: ArkProblem[];
}

const DEFAULT_RETRY_MS = 60_000;

export class ArkRecords {
  private readonly o: ArkRecordsOptions & { now: () => number };
  private readonly repos = new Map<string, RepoData>();
  /** A file's content by blob sha: it can't change, so it is read once. */
  private readonly blobs = new Map<string, string | null>();
  private count = 0;
  private shown = "";
  private readAt: string | null = null;
  private loaded = false;
  /** When the snapshot kept from an earlier launch was read, until a refresh replaces it. */
  private restoredAt: string | null = null;
  private refreshes = 0;
  /** What was last written to the cache, without the time, to write only what moved. */
  private stored = "";
  private nextAt = 0;
  private blocked = 0;
  private budget = 0;
  /** How many files a refresh could not read for lack of budget, so far. */
  private starved = 0;

  constructor(o: ArkRecordsOptions) {
    this.o = { ...o, now: o.now ?? Date.now };
    this.restore();
  }

  private get sourceKey(): string {
    return `ark-records:${this.o.cacheKey ?? "default"}`;
  }

  /** Takes the snapshot kept by an earlier launch, so the map has something to show at once. */
  private restore(): void {
    const mark = this.o.cache?.source(this.sourceKey);
    if (mark == null || mark.data === null) return;
    try {
      const m = JSON.parse(mark.marker) as StoredMarker;
      const d = JSON.parse(mark.data) as StoredData;
      if (m.v !== STORED || d.v !== STORED) return;
      const wanted = new Set(this.o.repos());
      for (const r of m.repos) {
        const shown = d.repos.find((x) => x.repo === r.repo);
        if (!wanted.has(r.repo) || shown === undefined) continue;
        this.repos.set(r.repo, {
          treeSha: r.treeSha,
          adrs: shown.adrs,
          issues: shown.issues,
          deployments: shown.deployments,
          topology: shown.topology,
          deployToml: r.deployToml,
          heads: new Map<string, Parsed>(),
          deploymentIds: r.deploymentIds,
          headKey: r.headKey,
          unread: r.unread,
          problems: [],
        });
      }
      if (this.repos.size === 0) return;
      this.restoredAt = mark.at;
      this.readAt = mark.at;
      this.stored = canonicalJson(m.repos);
    } catch {
      this.repos.clear();
    }
  }

  /** Writes what was read to the cache: the markers every time, what was derived when it moved. */
  private persist(moved: boolean): void {
    const cache = this.o.cache;
    if (cache === undefined || this.readAt === null) return;
    const repos: StoredMarker["repos"] = [...this.repos.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([repo, d]) => ({
        repo,
        treeSha: d.treeSha,
        headKey: d.headKey,
        deployToml: d.deployToml,
        deploymentIds: d.deploymentIds,
        unread: d.unread,
      }));
    const core = canonicalJson(repos);
    const marker = JSON.stringify({ v: STORED, repos } satisfies StoredMarker);
    if (!moved && core === this.stored) {
      cache.putSource(this.sourceKey, marker, this.readAt);
      return;
    }
    const data: StoredData = {
      v: STORED,
      repos: [...this.repos.entries()].map(([repo, d]) => ({
        repo,
        adrs: d.adrs,
        issues: d.issues,
        deployments: d.deployments,
        topology: d.topology,
      })),
    };
    cache.putSource(this.sourceKey, marker, this.readAt, JSON.stringify(data));
    this.stored = core;
  }

  private get adrRoot(): string {
    return (this.o.adrRoot ?? "docs/adr").replace(/^\/+|\/+$/g, "");
  }
  private get issuesRoot(): string {
    return (this.o.issuesRoot ?? "docs/issues").replace(/^\/+|\/+$/g, "");
  }

  /** Rises when anything the kinds show has changed. */
  get version(): number {
    return this.count;
  }

  /** Something was left for a later refresh: a file the budget of the last one didn't reach. */
  get unfinished(): boolean {
    return [...this.repos.values()].some((d) => d.unread);
  }

  /** What the kinds show, as of the last refresh. */
  snapshot(): ArkSnapshot {
    const data = [...this.repos.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    return {
      version: this.count,
      loading: !this.loaded && this.restoredAt === null,
      repos: [...this.o.repos()],
      readAt: this.readAt,
      asOf: this.restoredAt,
      adrs: data.flatMap(([, d]) => d.adrs),
      issues: data.flatMap(([, d]) => d.issues),
      deployments: data.flatMap(([, d]) => d.deployments),
      environments: data.flatMap(([, d]) => (d.topology === null ? [] : [d.topology])),
      problems: data.flatMap(([, d]) => d.problems),
    };
  }

  /** Whether a refresh is worth making now: not before `intervalMs` has passed, nor while rate limited. */
  due(): boolean {
    return this.o.now() >= Math.max(this.nextAt, this.blocked);
  }

  /** Makes the next refresh due at once, as when a map comes on screen. */
  wake(): void {
    this.nextAt = 0;
  }

  /**
   * Reads what changed in every repository this context covers. Returns whether anything the
   * kinds show changed. Never throws: what could not be read is in the snapshot's problems.
   */
  async refresh(intervalMs: number): Promise<boolean> {
    this.nextAt = this.o.now() + intervalMs;
    this.budget =
      this.refreshes++ === 0
        ? (this.o.firstRefreshBlobs ?? FIRST_REFRESH_BLOBS)
        : (this.o.maxBlobsPerRefresh ?? REFRESH_BLOBS);
    this.starved = 0;
    const wanted = new Set(this.o.repos());
    for (const r of this.repos.keys()) if (!wanted.has(r)) this.repos.delete(r);
    for (const repo of wanted) {
      if (this.o.now() < this.blocked) break;
      const data = this.repos.get(repo) ?? {
        treeSha: null,
        adrs: [],
        issues: [],
        deployments: [],
        topology: null,
        deployToml: null,
        heads: new Map<string, Parsed>(),
        deploymentIds: "",
        headKey: "",
        unread: false,
        problems: [],
      };
      this.repos.set(repo, data);
      data.problems = [];
      await this.guard(repo, data, "records", () => this.records(repo, data));
      await this.guard(repo, data, "deployments", async () => {
        await this.deployments(repo, data);
        await this.environments(repo, data);
      });
    }
    this.loaded = true;
    // What an earlier launch kept is replaced once a refresh has read everything it asked for.
    const complete = [...this.repos.values()].every((d) => d.problems.length === 0);
    if (complete) this.restoredAt = null;
    if (this.restoredAt === null) this.readAt = new Date(this.o.now()).toISOString();
    const { version: _v, readAt: _r, ...shown } = this.snapshot();
    const key = canonicalJson(shown);
    const changed = key !== this.shown;
    this.persist(changed);
    if (!changed) return false;
    this.shown = key;
    this.count++;
    return true;
  }

  /** Runs one source of one repository; a failure becomes a problem and the old data stays. */
  private async guard(
    repo: string,
    data: RepoData,
    source: ArkProblem["source"],
    run: () => Promise<void>,
  ): Promise<void> {
    if (this.o.now() < this.blocked) {
      data.problems.push({ repo, source, message: this.limitMessage() });
      return;
    }
    try {
      await run();
    } catch (err) {
      if (err instanceof GithubError && err.message.includes("rate limit")) {
        this.blocked = this.o.now() + Math.max(err.retryAfterMs ?? DEFAULT_RETRY_MS, 1000);
        data.problems.push({ repo, source, message: this.limitMessage() });
      } else {
        data.problems.push({
          repo,
          source,
          message: `${repo} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private limitMessage(): string {
    const seconds = Math.max(1, Math.ceil((this.blocked - this.o.now()) / 1000));
    return `GitHub's rate limit is used up: these counts are from before, and it asks again in ${seconds} s${this.needsToken()}`;
  }

  /** What to say when the first load can't finish for lack of a token (60 requests an hour). */
  private needsToken(): string {
    return this.o.github.authenticated
      ? ""
      : ". draft has no GitHub token, and without one GitHub allows 60 requests an hour: a token is needed for the first load to finish (set GITHUB_TOKEN, or sign in with `gh auth login`)";
  }

  /** A file's content by blob sha, once; null when the refresh's budget for files is spent. */
  private async blob(repo: string, sha: string): Promise<string | null> {
    if (this.known(sha)) return this.blobs.get(sha) ?? null;
    if (this.budget <= 0) {
      this.starved++;
      return null;
    }
    this.budget--;
    await this.fetchBlob(repo, sha);
    return this.blobs.get(sha) ?? null;
  }

  /** Whether a file is at hand, in memory or kept from an earlier launch. */
  private known(sha: string): boolean {
    if (this.blobs.has(sha)) return true;
    const kept = this.o.cache?.blob(sha);
    if (kept == null) return false;
    this.blobs.set(sha, kept);
    return true;
  }

  private async fetchBlob(repo: string, sha: string): Promise<void> {
    // A blob can't change, so it is asked for without an ETag and kept by its sha.
    const text = await this.o.github.getText(`/repos/${repo}/git/blobs/${sha}`, {
      immutable: true,
    });
    this.blobs.set(sha, text);
    if (text !== null) this.o.cache?.putBlob(sha, text);
  }

  /**
   * Reads the files a refresh will need, several at once, within the refresh's budget. What the
   * budget leaves out is asked for later by `blob`, which counts it as starved. A failure stops
   * the rest and is thrown once what was under way has ended.
   */
  private async prefetch(repo: string, shas: readonly string[]): Promise<void> {
    const todo = [...new Set(shas)].filter((sha) => !this.known(sha)).slice(0, this.budget);
    this.budget -= todo.length;
    let next = 0;
    let failure: unknown = null;
    const worker = async () => {
      while (failure === null && next < todo.length) {
        try {
          await this.fetchBlob(repo, todo[next++] as string);
        } catch (err) {
          failure ??= err;
        }
      }
    };
    const width = Math.max(1, Math.min(this.o.blobConcurrency ?? BLOB_CONCURRENCY, todo.length));
    await Promise.all(Array.from({ length: width }, worker));
    if (failure !== null) throw failure;
  }

  private async titleOf(repo: string, files: readonly EventFile[], type: string) {
    const first = files.find((f) => f.type === type);
    if (first === undefined) return null;
    return dataField((await this.blob(repo, first.blob)) ?? "", "title");
  }

  /**
   * What a record's events say about its relations: the supersessions of a decision's proposal and
   * of its `superseded`, the parent an issue was opened with, and the links, less those removed.
   * Reads only the files of those events; one it can't read yet is left for the next refresh.
   */
  private async relations(repo: string, files: readonly EventFile[]) {
    const out = {
      supersedes: [] as string[],
      supersededBy: [] as string[],
      parent: null as string | null,
      links: [] as ArkLink[],
    };
    for (const f of files) {
      if (!["proposed", "opened", "superseded", "linked", "unlinked"].includes(f.type)) continue;
      const text = await this.blob(repo, f.blob);
      if (text === null) continue;
      if (f.type === "proposed") out.supersedes.push(...dataList(text, "supersedes"));
      else if (f.type === "opened") out.parent = dataField(text, "parent");
      else if (f.type === "superseded") {
        const by = dataField(text, "by");
        if (by !== null) out.supersededBy.push(by);
      } else {
        const to = dataField(text, "to");
        const rel = dataField(text, "rel");
        if (to === null) continue;
        if (f.type === "linked") out.links.push({ rel: rel ?? "relates-to", to });
        else out.links = out.links.filter((l) => l.to !== to || (rel !== null && l.rel !== rel));
      }
    }
    return out;
  }

  private async records(repo: string, data: RepoData): Promise<void> {
    const github = this.o.github;
    const tree = await github.getJson<Tree>(`/repos/${repo}/git/trees/HEAD?recursive=1`);
    if (tree === null) {
      data.adrs = [];
      data.issues = [];
      data.treeSha = null;
      data.deployToml = null;
      data.problems.push({
        repo,
        source: "records",
        message: `${repo} is not there, or not visible to draft's GitHub token`,
      });
      return;
    }
    if (tree.truncated === true)
      data.problems.push({
        repo,
        source: "records",
        message: `${repo} is too large for one tree: some decisions and issues are missing`,
      });
    data.deployToml =
      tree.tree.find((e) => e.type === "blob" && e.path === "deploy.toml")?.sha ?? null;
    const heads = await this.pullHeads(repo);
    const headKey = heads.map((h) => `${h.number}@${h.headSha}`).join(",");
    // The same default-branch tree and the same pull request heads: nothing to read again.
    if (tree.sha === data.treeSha && headKey === data.headKey && !data.unread) return;
    const base: Parsed = {
      adrs: eventsUnder(tree.tree, this.adrRoot),
      issues: eventsUnder(tree.tree, this.issuesRoot),
    };
    const proposed = new Map<string, { files: EventFile[]; head: PullHead }>();
    for (const head of heads) {
      let parsed = data.heads.get(head.headSha);
      if (parsed === undefined) {
        const t = await github.getJson<Tree>(
          `/repos/${repo}/git/trees/${head.headSha}?recursive=1`,
        );
        parsed = { adrs: eventsUnder(t?.tree ?? [], this.adrRoot), issues: new Map() };
        data.heads.set(head.headSha, parsed);
      }
      for (const [id, files] of parsed.adrs)
        if (!proposed.has(id) && !sameFiles(files, base.adrs.get(id) ?? []))
          proposed.set(id, { files, head });
    }
    for (const sha of [...data.heads.keys()])
      if (!heads.some((h) => h.headSha === sha)) data.heads.delete(sha);

    const adrIds = [...new Set([...base.adrs.keys(), ...proposed.keys()])].sort();
    const issueIds = [...base.issues].sort(([a], [b]) => (a < b ? -1 : 1));
    // Every file the records below need is read now, several at once, then the records are made.
    await this.prefetch(repo, [
      ...adrIds.flatMap((id) =>
        filesToRead(proposed.get(id)?.files ?? (base.adrs.get(id) as EventFile[])),
      ),
      ...issueIds.flatMap(([, files]) => filesToRead(files)),
    ]);
    const starvedBefore = this.starved;
    const adrs: AdrRecord[] = [];
    for (const id of adrIds) {
      const onBranch = proposed.get(id);
      const files = onBranch?.files ?? (base.adrs.get(id) as EventFile[]);
      adrs.push({
        repo,
        id,
        title: await this.titleOf(repo, files, "proposed"),
        events: files.map(({ blob: _b, ...e }) => e),
        proposal: onBranch === undefined ? null : onBranch.head,
        ...pick(await this.relations(repo, files), ["supersedes", "supersededBy", "links"]),
        url:
          onBranch === undefined
            ? `https://github.com/${repo}/tree/HEAD/${this.adrRoot}/events/${id}`
            : `https://github.com/${repo}/tree/${onBranch.head.headRef}/${this.adrRoot}/events/${id}`,
      });
    }
    const issues: IssueRecord[] = [];
    for (const [id, files] of issueIds) {
      const closed = [...files].reverse().find((f) => f.type === "closed");
      issues.push({
        repo,
        id,
        title: await this.titleOf(repo, files, "opened"),
        events: files.map(({ blob: _b, ...e }) => e),
        resolution:
          closed === undefined || files.at(-1)?.type !== "closed"
            ? null
            : dataField((await this.blob(repo, closed.blob)) ?? "", "resolution"),
        ...pick(await this.relations(repo, files), ["parent", "links"]),
        url: `https://github.com/${repo}/tree/HEAD/${this.issuesRoot}/events/${id}`,
      });
    }
    data.adrs = adrs;
    data.issues = issues;
    data.treeSha = tree.sha;
    data.headKey = headKey;
    // A title the budget left out is read by the next refresh, which must not skip it.
    data.unread =
      this.starved > starvedBefore ||
      adrs.some((a) => a.title === null && a.events.some((e) => e.type === "proposed")) ||
      issues.some((i) => i.title === null && i.events.some((e) => e.type === "opened"));
    if (data.unread && !github.authenticated)
      data.problems.push({
        repo,
        source: "records",
        message: `${repo}: some titles are not read yet${this.needsToken()}`,
      });
  }

  private async pullHeads(repo: string): Promise<PullHead[]> {
    const list = await this.o.github.getJson<
      {
        number: number;
        html_url?: string;
        updated_at?: string;
        head?: { sha: string; ref: string; repo?: { full_name: string } | null };
      }[]
    >(`/repos/${repo}/pulls?state=open&per_page=${this.o.maxPulls ?? 30}`);
    return [...(list ?? [])]
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .flatMap((p) =>
        // A branch of a fork can't take the accept commit: only this repository's own are read.
        p.head === undefined || (p.head.repo != null && p.head.repo.full_name !== repo)
          ? []
          : [
              {
                number: p.number,
                url: p.html_url ?? `https://github.com/${repo}/pull/${p.number}`,
                headRef: p.head.ref,
                headSha: p.head.sha,
              },
            ],
      );
  }

  /**
   * The repository's environments: the names GitHub lists, and the one `deploy.toml` names. An
   * answer GitHub won't give (no access to environments) leaves what the deployments say.
   */
  private async environments(repo: string, data: RepoData): Promise<void> {
    let github: string[] = [];
    try {
      github = parseGithubEnvironments(
        await this.o.github.getJson<unknown>(`/repos/${repo}/environments?per_page=100`),
      );
    } catch (err) {
      // Forbidden is not a failure of the map: the environments are as the deployments name them.
      // A rate limit, or anything else, is the refresh's to report.
      if (!(err instanceof GithubError) || err.status !== 403 || err.message.includes("rate limit"))
        throw err;
    }
    const deployToml = data.deployToml === null ? null : await this.blob(repo, data.deployToml);
    data.topology = topologyOf(repo, { github, deployToml });
  }

  private async deployments(repo: string, data: RepoData): Promise<void> {
    const github = this.o.github;
    const list = await github.getJson<
      { id: number; sha: string; ref: string; environment: string; created_at: string }[]
    >(`/repos/${repo}/deployments?per_page=${this.o.maxDeployments ?? 30}`);
    const found = list ?? [];
    const ids = found.map((d) => d.id).join(",");
    const changed = ids !== data.deploymentIds;
    const known = new Map(data.deployments.map((d) => [d.id, d]));
    const out: DeploymentRecord[] = [];
    for (const d of found) {
      const before = known.get(d.id);
      const last = before?.statuses.at(-1)?.state;
      // Moving, or a success a newer run may have made inactive: ask again. Else it is as it was.
      const settled = last === "failure" || last === "error" || last === "inactive";
      const ask = before === undefined || (!settled && (changed || last !== "success"));
      let statuses = before?.statuses ?? [];
      if (ask) {
        const rows = await github.getJson<
          {
            state: string;
            created_at: string;
            log_url?: string | null;
            target_url?: string | null;
            environment_url?: string | null;
          }[]
        >(`/repos/${repo}/deployments/${d.id}/statuses?per_page=30`);
        statuses = [...(rows ?? [])]
          .map(
            (s): DeploymentStatusRecord => ({
              state: s.state,
              at: s.created_at,
              logUrl: s.log_url ?? s.target_url ?? null,
              environmentUrl: s.environment_url ?? null,
            }),
          )
          .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      }
      out.push({
        repo,
        id: d.id,
        environment: d.environment,
        sha: d.sha,
        ref: d.ref,
        createdAt: d.created_at,
        commitUrl: `https://github.com/${repo}/commit/${d.sha}`,
        statuses,
      });
    }
    data.deployments = out;
    data.deploymentIds = ids;
  }
}
