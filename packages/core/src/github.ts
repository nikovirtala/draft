import { execFile } from "node:child_process";

/**
 * How draft reaches GitHub, for the pull request and ark issue resolvers. draft stores no
 * credential: it takes a token from the environment (GITHUB_TOKEN), else from `gh auth token`,
 * else reads public repositories without one. It only ever reads: the client below has no way to
 * send anything but GET, so what a token can do beyond reading is never used. A fine-grained
 * token with read access to pull requests, checks, commit statuses and contents is enough.
 */

export type GithubAuthSource = "env" | "gh" | "none";

export interface GithubAuth {
  token: string | null;
  source: GithubAuthSource;
}

export type Exec = (file: string, args: readonly string[]) => Promise<string>;

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 5000, windowsHide: true }, (err, stdout) =>
      err === null ? resolve(stdout) : reject(err),
    );
  });

/** GITHUB_TOKEN from the environment, then `gh auth token`, otherwise none. */
export async function resolveGithubAuth(
  env: NodeJS.ProcessEnv = process.env,
  exec: Exec = defaultExec,
): Promise<GithubAuth> {
  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, source: "env" };
  try {
    const out = (await exec("gh", ["auth", "token"])).trim();
    if (out !== "") return { token: out, source: "gh" };
  } catch {
    // No gh, not signed in, or too slow: read without a token.
  }
  return { token: null, source: "none" };
}

/**
 * What draft tells the person about how it reaches GitHub, when it can't use a token. Nothing
 * when it can: the token is never mentioned.
 */
export function githubNote(auth: GithubAuth): string | null {
  if (auth.token !== null) return null;
  return "draft has no GitHub token (GITHUB_TOKEN, or `gh auth token`), so it reads public repositories without one, at GitHub's limit of 60 requests an hour. Private repositories won't show, and a review requested from you can't be told. draft only reads from GitHub; a read-only token is enough.";
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** How long GitHub asks callers to wait, when it says. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface GithubClientOptions {
  token: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Cached {
  etag: string;
  body: unknown;
}

const MAX_CACHED = 500;

/**
 * A read-only client for the GitHub REST API. It sends If-None-Match with the ETag of what it
 * saw, so polling an unchanged resource answers 304, which doesn't count against the rate limit.
 */
export class GithubClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, Cached>();
  /** Requests made, and how many were answered from the ETag cache (for tests and telemetry). */
  requests = 0;
  notModified = 0;

  constructor(private readonly o: GithubClientOptions) {
    this.base = (o.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get authenticated(): boolean {
    return this.o.token !== null;
  }

  private async request(path: string, accept: string): Promise<{ status: number; body: unknown }> {
    const url = `${this.base}${path}`;
    const cached = this.cache.get(`${accept}\u0000${url}`);
    const headers: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "draft",
    };
    if (this.o.token !== null) headers.authorization = `Bearer ${this.o.token}`;
    if (cached !== undefined) headers["if-none-match"] = cached.etag;
    this.requests++;
    const res = await this.fetchFn(url, { method: "GET", headers });
    if (res.status === 304 && cached !== undefined) {
      this.notModified++;
      return { status: 200, body: cached.body };
    }
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) {
      const limited =
        res.status === 429 ||
        (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") ||
        res.headers.get("retry-after") !== null;
      throw new GithubError(
        limited ? "GitHub's rate limit is used up" : `GitHub answered ${res.status}`,
        res.status,
        limited ? this.retryAfter(res) : null,
      );
    }
    const body: unknown = accept.includes("raw") ? await res.text() : await res.json();
    const etag = res.headers.get("etag");
    if (etag !== null) {
      if (this.cache.size >= MAX_CACHED)
        this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(`${accept}\u0000${url}`, { etag, body });
    }
    return { status: res.status, body };
  }

  private retryAfter(res: Response): number | null {
    const after = res.headers.get("retry-after");
    if (after !== null && Number.isFinite(Number(after))) return Number(after) * 1000;
    const reset = res.headers.get("x-ratelimit-reset");
    if (reset !== null && Number.isFinite(Number(reset)))
      return Math.max(0, Number(reset) * 1000 - this.now());
    return null;
  }

  /** The JSON at `path`, or null when GitHub says it doesn't exist (or can't be seen). */
  async getJson<T>(path: string): Promise<T | null> {
    const r = await this.request(path, "application/vnd.github+json");
    return r.status === 404 ? null : (r.body as T);
  }

  /** A file's content as text, or null. */
  async getText(path: string): Promise<string | null> {
    const r = await this.request(path, "application/vnd.github.raw+json");
    return r.status === 404 ? null : (r.body as string);
  }
}
