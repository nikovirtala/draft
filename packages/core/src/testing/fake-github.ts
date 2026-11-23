import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A fake GitHub REST API for tests and the end-to-end run: pull requests with check runs, commit
 * statuses and reviews, the authenticated user, and repository contents for ark issue event
 * files. It answers If-None-Match with 304 like the real one, can run out of rate limit, and
 * records every request, so tests can check that draft only reads.
 *
 * A repository can be backed by a real (bare) git repository: contents are then read from it at the
 * ref asked for, a pull request's head is its branch's tip, and the files of a pull request are
 * what its branch changes. With `writes` on it also takes what a person's `gh` sends: merging
 * (by rebase, which for a branch on top of its base is a fast-forward), closing and commenting.
 */

export interface FakeCheck {
  name: string;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
}

export interface FakeReview {
  id: number;
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
}

export interface FakePull {
  title: string;
  /** The description: what a merged pull request's checks are read from. */
  body?: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string;
  /** For a repository without git: the files it changes. */
  files?: string[];
  /**
   * The commit `checks` and `statuses` are for. Where the head moves (a git-backed branch), a head
   * that isn't this commit has no checks yet, as on GitHub until CI runs.
   */
  checksFor?: string;
  requestedReviewers: string[];
  checks: FakeCheck[];
  statuses: { context: string; state: string }[];
  reviews: FakeReview[];
  updatedAt: string;
}

export interface FakeIssueEvent {
  type: string;
  /** `20261120T202043Z`. */
  stamp: string;
  data?: Record<string, string>;
}

export interface FakeDeploymentStatus {
  state: string;
  /** ISO time. */
  at: string;
  logUrl?: string;
  environmentUrl?: string;
}

export interface FakeDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  createdAt: string;
  /** Oldest first. */
  statuses: FakeDeploymentStatus[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: string | null;
  /** Who the sender says it is acting for (the fake `gh`); null for anything else. */
  user: string | null;
}

type Send = (
  status: number,
  body: unknown,
  raw?: boolean,
  headers?: Record<string, string>,
) => boolean;

export class FakeGithub {
  readonly requests: RecordedRequest[] = [];
  readonly pulls = new Map<string, FakePull>();
  /** `owner/repo:id` to its event files, oldest first. */
  readonly issues = new Map<string, FakeIssueEvent[]>();
  /** `owner/repo` to a ref (a branch or a commit sha) to the files it holds, by path. */
  readonly files = new Map<string, Map<string, Map<string, string>>>();
  /** `owner/repo` to its deployments, oldest first. */
  readonly deployments = new Map<string, FakeDeployment[]>();
  /** `owner/repo` to what its environments endpoint answers; none set: no environments. */
  readonly environments = new Map<string, unknown>();
  /** `owner/repo` to the bare git repository behind it. */
  readonly gitRepos = new Map<string, string>();
  /** Take writes (merge, close, comment) from a person's tools. Off, anything but GET is refused. */
  writes = false;
  /** The merge methods the repository allows. */
  mergeMethods: string[] = ["rebase"];
  readonly merges: { repo: string; number: number; method: string; sha: string }[] = [];
  readonly comments: { repo: string; number: number; body: string }[] = [];
  /** The login a token belongs to; requests without a token get 401 from `/user`. */
  viewer = "niko";
  /** Answer the next n requests as rate limited. */
  rateLimited = 0;
  baseUrl = "";
  private server: Server | null = null;

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://fake");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8");
      this.requests.push({
        method: req.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.authorization ?? null,
        body,
        user: (req.headers["x-fake-gh-user"] as string | undefined) ?? null,
      });
      const send = (
        status: number,
        body: unknown,
        raw = false,
        headers: Record<string, string> = {},
      ) => {
        const text = raw ? String(body) : JSON.stringify(body);
        const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
        if (status === 200 && req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag });
          res.end();
          return true;
        }
        res.writeHead(status, {
          "content-type": raw ? "text/plain" : "application/json",
          ...(status === 200 ? { etag } : {}),
          ...headers,
        });
        res.end(text);
        return true;
      };
      if (req.method !== "GET")
        return this.writes
          ? this.write(req.method ?? "", url.pathname, body, send)
          : send(405, { message: "read only" });
      if (this.rateLimited > 0) {
        this.rateLimited--;
        return send(403, { message: "API rate limit exceeded" }, false, {
          "x-ratelimit-remaining": "0",
          "retry-after": "1",
        });
      }
      return this.route(url.pathname, url.searchParams, send);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const a = this.server.address();
    this.baseUrl = `http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
    return this;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s === null) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Adds a pull request that is open, clean and without checks, unless told otherwise. */
  addPull(repo: string, n: number, init: Partial<FakePull> = {}): FakePull {
    const pull: FakePull = {
      title: `Pull request ${n}`,
      state: "open",
      merged: false,
      draft: false,
      author: "niko",
      headSha: `a${String(n).padStart(39, "0")}`,
      headRef: `branch-${n}`,
      baseRef: "main",
      mergeable: true,
      mergeableState: "clean",
      requestedReviewers: [],
      checks: [],
      statuses: [],
      reviews: [],
      updatedAt: new Date().toISOString(),
      ...init,
    };
    this.pulls.set(`${repo}#${n}`, pull);
    return pull;
  }

  /** Changes a pull request as a push, a check run or a reviewer would. */
  updatePull(repo: string, n: number, patch: Partial<FakePull>): FakePull {
    const p = this.pulls.get(`${repo}#${n}`);
    if (p === undefined) throw new Error(`no fake pull request ${repo}#${n}`);
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    return p;
  }

  /** Sets the files a ref (a branch name, or the sha of a pull request's head) holds. */
  addFiles(repo: string, ref: string, files: Record<string, string>): void {
    const refs = this.files.get(repo) ?? new Map<string, Map<string, string>>();
    refs.set(ref, new Map(Object.entries(files)));
    this.files.set(repo, refs);
  }

  addDeployment(repo: string, d: FakeDeployment): void {
    this.deployments.set(repo, [...(this.deployments.get(repo) ?? []), d]);
  }

  addDeploymentStatus(repo: string, id: number, s: FakeDeploymentStatus): void {
    const d = this.deployments.get(repo)?.find((x) => x.id === id);
    if (d === undefined) throw new Error(`no fake deployment ${repo}#${id}`);
    d.statuses.push(s);
  }

  /** What git calls the blob of a text: its sha. */
  static blobSha(text: string): string {
    const body = Buffer.from(text, "utf8");
    return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
  }

  private treeOf(repo: string, ref: string): Map<string, string> | undefined {
    const refs = this.files.get(repo);
    return refs?.get(ref === "HEAD" ? "main" : ref);
  }

  addIssue(repo: string, id: string, events: FakeIssueEvent[]): void {
    this.issues.set(`${repo}:${id}`, events);
  }

  private fileName(e: FakeIssueEvent, i: number): string {
    return `${e.stamp}-${String(i).padStart(4, "0")}-${e.type}.yaml`;
  }

  /** Makes a git repository the source of a repository's contents and pull request heads. */
  addGitRepo(repo: string, bare: string): void {
    this.gitRepos.set(repo, bare);
  }

  private git(repo: string, args: string[]): string | null {
    const bare = this.gitRepos.get(repo);
    if (bare === undefined) return null;
    try {
      return execFileSync("git", ["-C", bare, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  }

  /** The commit a pull request's head is at: its branch's tip in git, else what it was given. */
  private head(repo: string, p: FakePull): string {
    return this.git(repo, ["rev-parse", `refs/heads/${p.headRef}`])?.trim() || p.headSha;
  }

  private checksOf<T>(repo: string, p: FakePull, sha: string, checks: T[]): T[] {
    if (!this.gitRepos.has(repo)) return checks;
    return (p.checksFor ?? p.headSha) === sha ? checks : [];
  }

  private pullOf(repo: string, n: number | string): FakePull | undefined {
    return this.pulls.get(`${repo}#${n}`);
  }

  /** What a person's own tools send: merge, close, comment. */
  private write(method: string, path: string, body: string | null, send: Send): boolean {
    const input = body === null ? {} : (JSON.parse(body) as Record<string, string>);
    const merge = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(path);
    if (merge !== null && method === "PUT") {
      const repo = merge[1] as string;
      const n = Number(merge[2]);
      const p = this.pullOf(repo, n);
      if (p === undefined) return send(404, { message: "Not Found" });
      const head = this.head(repo, p);
      const m = input.merge_method ?? "merge";
      if (!this.mergeMethods.includes(m))
        return send(405, { message: `${m} merges are not allowed on this repository.` });
      if (p.state !== "open" || p.merged) return send(405, { message: "Pull Request is not open" });
      if (input.sha !== undefined && input.sha !== head)
        return send(409, { message: "Head branch was modified. Review and try the merge again." });
      if (p.mergeableState !== "clean")
        return send(405, { message: "Pull Request is not mergeable" });
      // A rebase of a branch that sits on its base is a fast-forward of the base.
      if (this.gitRepos.has(repo)) {
        const ancestor = this.git(repo, [
          "merge-base",
          "--is-ancestor",
          `refs/heads/${p.baseRef}`,
          head,
        ]);
        if (ancestor === null) return send(405, { message: "Pull Request is not mergeable" });
        this.git(repo, ["update-ref", `refs/heads/${p.baseRef}`, head]);
      }
      p.merged = true;
      p.state = "closed";
      this.merges.push({ repo, number: n, method: m, sha: head });
      return send(200, { sha: head, merged: true, message: "Pull Request successfully merged" });
    }
    const comment = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (comment !== null && method === "POST") {
      this.comments.push({
        repo: comment[1] as string,
        number: Number(comment[2]),
        body: input.body ?? "",
      });
      return send(201, { id: this.comments.length, body: input.body ?? "" });
    }
    const patch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    if (patch !== null && method === "PATCH") {
      const p = this.pullOf(patch[1] as string, patch[2] as string);
      if (p === undefined) return send(404, { message: "Not Found" });
      if (input.state === "closed") p.state = "closed";
      return send(200, { state: p.state });
    }
    return send(404, { message: "Not Found" });
  }

  private route(path: string, query: URLSearchParams, send: Send): boolean {
    if (path === "/user") {
      const last = this.requests.at(-1);
      return last?.authorization == null
        ? send(401, { message: "Requires authentication" })
        : send(200, { login: this.viewer });
    }
    const pr = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/reviews)?$/.exec(path);
    if (pr !== null) {
      const p = this.pulls.get(`${pr[1]}#${pr[2]}`);
      if (p === undefined) return send(404, { message: "Not Found" });
      if (pr[3] !== undefined)
        return send(
          200,
          p.reviews.map((r) => ({ id: r.id, user: { login: r.user }, state: r.state })),
        );
      return send(200, {
        title: p.title,
        body: p.body ?? null,
        html_url: `https://github.com/${pr[1]}/pull/${pr[2]}`,
        state: p.state,
        merged: p.merged,
        draft: p.draft,
        user: { login: p.author },
        head: { sha: this.head(pr[1] as string, p), ref: p.headRef, repo: { full_name: pr[1] } },
        base: { ref: p.baseRef },
        mergeable: p.mergeable,
        // A new head that CI has not run on is blocked, as GitHub says until the checks report.
        mergeable_state:
          this.gitRepos.has(pr[1] as string) &&
          this.head(pr[1] as string, p) !== (p.checksFor ?? p.headSha)
            ? "blocked"
            : p.mergeableState,
        requested_reviewers: p.requestedReviewers.map((login) => ({ login })),
        updated_at: p.updatedAt,
      });
    }
    const tree = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^/]+)$/.exec(path);
    if (tree !== null) {
      const files = this.treeOf(tree[1] as string, decodeURIComponent(tree[2] as string));
      if (files === undefined) return send(404, { message: "Not Found" });
      const entries = [...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([p, text]) => ({ path: p, type: "blob", sha: FakeGithub.blobSha(text) }));
      const sha = createHash("sha1")
        .update(entries.map((e) => `${e.path}:${e.sha}`).join("\n"))
        .digest("hex");
      return send(200, { sha, truncated: false, tree: entries });
    }
    const blob = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs\/([0-9a-f]+)$/.exec(path);
    if (blob !== null) {
      for (const text of [...(this.files.get(blob[1] as string)?.values() ?? [])].flatMap((f) => [
        ...f.values(),
      ]))
        if (FakeGithub.blobSha(text) === blob[2]) return send(200, text, true);
      return send(404, { message: "Not Found" });
    }
    const environments = /^\/repos\/([^/]+\/[^/]+)\/environments$/.exec(path);
    if (environments !== null)
      return send(
        200,
        this.environments.get(environments[1] as string) ?? { total_count: 0, environments: [] },
      );
    const deployments = /^\/repos\/([^/]+\/[^/]+)\/deployments$/.exec(path);
    if (deployments !== null)
      return send(
        200,
        [...(this.deployments.get(deployments[1] as string) ?? [])].reverse().map((d) => ({
          id: d.id,
          sha: d.sha,
          ref: d.ref,
          environment: d.environment,
          created_at: d.createdAt,
        })),
      );
    const statuses = /^\/repos\/([^/]+\/[^/]+)\/deployments\/(\d+)\/statuses$/.exec(path);
    if (statuses !== null) {
      const d = this.deployments
        .get(statuses[1] as string)
        ?.find((x) => x.id === Number(statuses[2]));
      if (d === undefined) return send(404, { message: "Not Found" });
      return send(
        200,
        [...d.statuses].reverse().map((st) => ({
          state: st.state,
          created_at: st.at,
          log_url: st.logUrl ?? null,
          environment_url: st.environmentUrl ?? null,
        })),
      );
    }
    const list = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(path);
    if (list !== null) {
      const open = [...this.pulls.entries()]
        .filter(([k, v]) => k.startsWith(`${list[1]}#`) && v.state === "open")
        .map(([k, v]) => ({
          number: Number(k.split("#")[1]),
          state: v.state,
          updated_at: v.updatedAt,
          html_url: `https://github.com/${list[1]}/pull/${k.split("#")[1]}`,
          head: {
            sha: this.head(list[1] as string, v),
            ref: v.headRef,
            repo: { full_name: list[1] },
          },
        }));
      return send(200, query.get("state") === "open" || query.get("state") === null ? open : []);
    }
    const files = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/.exec(path);
    if (files !== null) {
      const p = this.pullOf(files[1] as string, files[2] as string);
      if (p === undefined) return send(404, { message: "Not Found" });
      const changed =
        this.git(files[1] as string, [
          "diff",
          "--name-only",
          `refs/heads/${p.baseRef}...${this.head(files[1] as string, p)}`,
        ])
          ?.split("\n")
          .filter((f) => f !== "") ??
        p.files ??
        [];
      return send(
        200,
        changed.map((filename) => ({ filename })),
      );
    }
    const commit = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(
      path,
    );
    if (commit !== null) {
      const repo = commit[1] as string;
      const found = [...this.pulls.entries()].find(
        ([k, v]) => k.startsWith(`${repo}#`) && this.head(repo, v) === commit[2],
      )?.[1];
      if (found === undefined) return send(404, { message: "Not Found" });
      const checks = this.checksOf(repo, found, commit[2] as string, found.checks);
      const statuses = this.checksOf(repo, found, commit[2] as string, found.statuses);
      if (commit[3] === "check-runs")
        return send(200, {
          total_count: checks.length,
          check_runs: checks.map((c) => ({
            name: c.name,
            status: c.status ?? (c.conclusion === undefined ? "in_progress" : "completed"),
            conclusion: c.conclusion ?? null,
            html_url: `https://github.com/${repo}/runs/${encodeURIComponent(c.name)}`,
          })),
        });
      return send(200, {
        state: "success",
        statuses: statuses.map((s) => ({ context: s.context, state: s.state })),
      });
    }
    const repoContents = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(path);
    if (repoContents !== null && this.gitRepos.has(repoContents[1] as string)) {
      const repo = repoContents[1] as string;
      const ref = query.get("ref") ?? "HEAD";
      const at = decodeURIComponent(repoContents[2] as string);
      const type = this.git(repo, ["cat-file", "-t", `${ref}:${at}`])?.trim();
      if (type === "tree") {
        const names = this.git(repo, ["ls-tree", "--name-only", `${ref}:${at}`]) ?? "";
        return send(
          200,
          names
            .split("\n")
            .filter((n) => n !== "")
            .map((name) => ({
              name,
              type:
                this.git(repo, ["cat-file", "-t", `${ref}:${at}/${name}`])?.trim() === "tree"
                  ? "dir"
                  : "file",
            })),
        );
      }
      if (type === "blob") return send(200, this.git(repo, ["show", `${ref}:${at}`]) ?? "", true);
      return send(404, { message: "Not Found" });
    }
    const dir = /^\/repos\/([^/]+\/[^/]+)\/contents\/docs\/issues\/events\/([^/]+)$/.exec(path);
    if (dir !== null) {
      const events = this.issues.get(`${dir[1]}:${dir[2]}`);
      if (events === undefined) return send(404, { message: "Not Found" });
      return send(
        200,
        events.map((e, i) => ({ name: this.fileName(e, i), type: "file" })),
      );
    }
    const file = /^\/repos\/([^/]+\/[^/]+)\/contents\/docs\/issues\/events\/([^/]+)\/([^/]+)$/.exec(
      path,
    );
    if (file !== null) {
      const events = this.issues.get(`${file[1]}:${file[2]}`);
      const i = events?.findIndex((e, k) => this.fileName(e, k) === file[3]) ?? -1;
      const e = events?.[i];
      if (e === undefined) return send(404, { message: "Not Found" });
      const data = Object.entries(e.data ?? {})
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      return send(
        200,
        `envelope: ledger/v1\nkind: issue\nsubject: ${file[2]}\ntype: ${e.type}\ndata:\n${data}\n`,
        true,
      );
    }
    return send(404, { message: "Not Found" });
  }
}
