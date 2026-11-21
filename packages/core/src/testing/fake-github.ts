import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A fake GitHub REST API for tests and the end-to-end run: pull requests with check runs, commit
 * statuses and reviews, the authenticated user, and repository contents for ark issue event
 * files. It answers If-None-Match with 304 like the real one, can run out of rate limit, and
 * records every request, so tests can check that draft only reads.
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
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  author: string;
  headSha: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string;
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

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
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
  /** The login a token belongs to; requests without a token get 401 from `/user`. */
  viewer = "niko";
  /** Answer the next n requests as rate limited. */
  rateLimited = 0;
  baseUrl = "";
  private server: Server | null = null;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fake");
      this.requests.push({
        method: req.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.authorization ?? null,
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
      if (req.method !== "GET") return send(405, { message: "read only" });
      if (this.rateLimited > 0) {
        this.rateLimited--;
        return send(403, { message: "API rate limit exceeded" }, false, {
          "x-ratelimit-remaining": "0",
          "retry-after": "1",
        });
      }
      return this.route(url.pathname, send);
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

  addIssue(repo: string, id: string, events: FakeIssueEvent[]): void {
    this.issues.set(`${repo}:${id}`, events);
  }

  private fileName(e: FakeIssueEvent, i: number): string {
    return `${e.stamp}-${String(i).padStart(4, "0")}-${e.type}.yaml`;
  }

  private route(path: string, send: Send): boolean {
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
        html_url: `https://github.com/${pr[1]}/pull/${pr[2]}`,
        state: p.state,
        merged: p.merged,
        draft: p.draft,
        user: { login: p.author },
        head: { sha: p.headSha },
        base: { ref: p.baseRef },
        mergeable: p.mergeable,
        mergeable_state: p.mergeableState,
        requested_reviewers: p.requestedReviewers.map((login) => ({ login })),
        updated_at: p.updatedAt,
      });
    }
    const commit = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(
      path,
    );
    if (commit !== null) {
      const p = [...this.pulls.entries()].find(
        ([k, v]) => k.startsWith(`${commit[1]}#`) && v.headSha === commit[2],
      )?.[1];
      if (p === undefined) return send(404, { message: "Not Found" });
      if (commit[3] === "check-runs")
        return send(200, {
          total_count: p.checks.length,
          check_runs: p.checks.map((c) => ({
            name: c.name,
            status: c.status ?? (c.conclusion === undefined ? "in_progress" : "completed"),
            conclusion: c.conclusion ?? null,
            html_url: `https://github.com/${commit[1]}/runs/${encodeURIComponent(c.name)}`,
          })),
        });
      return send(200, {
        state: "success",
        statuses: p.statuses.map((s) => ({ context: s.context, state: s.state })),
      });
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
