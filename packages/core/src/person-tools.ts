import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptanceActions } from "./acceptance.ts";
import type { AdrVerifier, AdrVerifyResult } from "./adr.ts";

/**
 * The person's tools: how draft carries out a person's answer to an acceptance request, as that
 * person. It starts the person's own programs and gives them nothing:
 *
 * - `git`, with the identity, the signing key and the credential helper of the person's git
 *   config, in a clone that draft manages under its data directory, never in a working copy of
 *   the person's. draft never reads a key or a password.
 * - `gh api`, REST only, with gh's own sign-in.
 * - `adr`, which records the decision's events and commits them through that same git.
 *
 * Nothing here is reachable from the agent: the only caller is the conversation's settlement of an
 * acceptance request, which only a person can start (ADRs wkcnp3zr, k8af6zrg, ytmnx1br).
 * `ARK_AGENT` and `ARK_ON_BEHALF_OF` are removed from the environment so ark records the person,
 * not an agent. A commit is signed or it is not pushed.
 */

export class PersonToolError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code: number | string | null,
    readonly stderr: string,
    readonly stdout: string = "",
  ) {
    super(message);
    this.name = "PersonToolError";
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type Run = (
  argv: readonly string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) => Promise<RunResult>;

const defaultRun: Run = (argv, o) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv as [string, ...string[]];
    const child = execFile(
      file,
      args,
      {
        cwd: o.cwd,
        env: o.env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 10 * 60_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ stdout, stderr });
        const code = (err as { code?: number | string }).code ?? null;
        reject(
          new PersonToolError(
            `${argv.slice(0, 3).join(" ")} failed${typeof code === "number" ? ` (exit ${code})` : ""}: ${firstLines(stderr || stdout || err.message)}`,
            argv.join(" "),
            code,
            stderr,
            stdout,
          ),
        );
      },
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
  });

function firstLines(text: string, n = 4): string {
  return text.trim().split("\n").slice(0, n).join(" ").slice(0, 400);
}

export interface PersonToolsOptions {
  /** draft's data directory; the clones are under `<dir>/acceptance`. */
  dir: string;
  /** The person's programs. Defaults: git, gh, adr. */
  git?: string;
  gh?: readonly string[];
  adr?: readonly string[];
  /** A repository's remote, when it isn't `https://github.com/<repo>.git`. */
  remotes?: Readonly<Record<string, string>>;
  /** Where the decision log is in each repository. */
  adrRoot?: string;
  /** The environment to start them in; defaults to draft's own. */
  env?: NodeJS.ProcessEnv;
  run?: Run;
}

export interface Identity {
  name: string;
  email: string;
}

export interface AcceptCommit {
  /** The accept (or reject) commit pushed to the branch. */
  sha: string;
  /** Whether the commit carries a signature. Always true for what was pushed. */
  signed: true;
  signer: Identity;
  output: string;
}

export interface MergeResult {
  sha: string;
  message: string;
}

/** Variables that would make ark record an agent instead of the person. */
const AGENT_ENV = ["ARK_AGENT", "ARK_ON_BEHALF_OF"] as const;

export class PersonTools implements AdrVerifier {
  private readonly git: string;
  private readonly gh: readonly string[];
  private readonly adr: readonly string[];
  private readonly run: Run;
  private readonly base: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private cloned = new Set<string>();

  constructor(private readonly o: PersonToolsOptions) {
    this.git = o.git ?? "git";
    this.gh = o.gh ?? ["gh"];
    this.adr = o.adr ?? ["adr"];
    this.run = o.run ?? defaultRun;
    this.base = join(o.dir, "acceptance");
  }

  /** The person's environment, without anything that would make ark record an agent. */
  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.o.env ?? process.env), ...extra };
    for (const k of AGENT_ENV) delete env[k];
    // Nothing waits for a password nobody can type: a credential helper answers, or the step fails.
    env.GIT_TERMINAL_PROMPT = "0";
    return env;
  }

  /** The same, with signing turned on for every commit git makes. */
  private signingEnv(): NodeJS.ProcessEnv {
    const env = this.env();
    const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = "commit.gpgsign";
    env[`GIT_CONFIG_VALUE_${n}`] = "true";
    return env;
  }

  private sh(argv: readonly string[], cwd: string, env = this.env(), input?: string) {
    return this.run(argv, { cwd, env, ...(input === undefined ? {} : { input }) });
  }

  private async serial<T>(key: string, f: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(f);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  /** The git identity of the person, or why there is none. */
  async identity(): Promise<Identity> {
    await mkdir(this.base, { recursive: true });
    const get = async (key: string): Promise<string> => {
      try {
        return (await this.sh([this.git, "config", "--get", key], this.base)).stdout.trim();
      } catch {
        return "";
      }
    };
    const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
    if (name === "" || email === "")
      throw new PersonToolError(
        "git has no user.name and user.email, so draft can't commit as you. Set them with git config --global.",
        "git config",
        null,
        "",
      );
    return { name, email };
  }

  private remote(repo: string): string {
    return this.o.remotes?.[repo] ?? `https://github.com/${repo}.git`;
  }

  /** The clone of a repository that draft manages, made on first use. */
  private async clone(repo: string): Promise<string> {
    const dir = join(this.base, repo.replace("/", "__"));
    if (!this.cloned.has(dir) && !existsSync(join(dir, ".git"))) {
      await mkdir(this.base, { recursive: true });
      await this.sh([this.git, "clone", "--no-checkout", this.remote(repo), dir], this.base);
    }
    this.cloned.add(dir);
    return dir;
  }

  private async hasCommit(dir: string, sha: string): Promise<boolean> {
    try {
      await this.sh([this.git, "cat-file", "-e", `${sha}^{commit}`], dir);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs `f` in a detached worktree of the clone at `sha`, and removes it afterwards. */
  private async atCommit<T>(
    repo: string,
    sha: string,
    fetch: string[],
    f: (wt: string, clone: string) => Promise<T>,
  ): Promise<T> {
    return this.serial(repo, async () => {
      const clone = await this.clone(repo);
      if (!(await this.hasCommit(clone, sha)))
        await this.sh([this.git, "fetch", "--prune", "origin", ...fetch], clone);
      if (!(await this.hasCommit(clone, sha)))
        throw new PersonToolError(
          `${sha.slice(0, 7)} is not in ${repo}: the branch moved while you looked, or it is from a fork.`,
          "git fetch",
          null,
          "",
        );
      const wt = join(
        this.base,
        "worktrees",
        `${repo.replace("/", "__")}-${sha.slice(0, 12)}-${Date.now().toString(36)}`,
      );
      await mkdir(join(this.base, "worktrees"), { recursive: true });
      await this.sh([this.git, "worktree", "add", "--detach", wt, sha], clone);
      try {
        return await f(wt, clone);
      } finally {
        await this.sh([this.git, "worktree", "remove", "--force", wt], clone).catch(() => {});
        await this.sh([this.git, "worktree", "prune"], clone).catch(() => {});
      }
    });
  }

  /** `adr verify` at a commit of the repository, in draft's clone. */
  async verify(repo: string, sha: string): Promise<AdrVerifyResult> {
    return this.atCommit(repo, sha, ["+refs/heads/*:refs/remotes/origin/*"], async (wt) => {
      const root = this.o.adrRoot === undefined ? [] : ["--root", this.o.adrRoot];
      try {
        return this.parseVerify(
          sha,
          (await this.sh([...this.adr, "verify", "--json", ...root], wt)).stdout,
        );
      } catch (err) {
        // verify exits non-zero when it has findings; its JSON is on stdout.
        if (err instanceof PersonToolError && err.stdout.trim() !== "")
          return this.parseVerify(sha, err.stdout);
        throw err;
      }
    });
  }

  private parseVerify(sha: string, out: string): AdrVerifyResult {
    try {
      const doc = JSON.parse(out) as {
        ok?: boolean;
        findings?: { rule?: string; message?: string }[];
      };
      const findings = doc.findings ?? [];
      if (doc.ok === true && findings.length === 0)
        return { sha, status: "clean", findings: 0, summary: "no findings" };
      return {
        sha,
        status: "findings",
        findings: findings.length,
        summary: findings
          .slice(0, 3)
          .map((f) => `${f.rule ?? "finding"}: ${f.message ?? ""}`)
          .join("; "),
      };
    } catch {
      return { sha, status: "failed", findings: 0, summary: "adr verify printed nothing readable" };
    }
  }

  /**
   * Records a decision's acceptance (or rejection) with adr as the person, signed, on the branch
   * of the pull request that proposes it, and pushes it. The commit is made on top of exactly the
   * commit the person looked at; if the branch moved, nothing is pushed.
   */
  private async adrCommit(
    command: "accept" | "reject",
    a: { repo: string; adr: string; headRef: string; headSha: string; reason?: string },
  ): Promise<AcceptCommit> {
    const signer = await this.identity();
    return this.atCommit(a.repo, a.headSha, [a.headRef], async (wt) => {
      // The branch as it is on the remote now must still be the commit that was judged.
      const tip = (
        await this.sh([this.git, "ls-remote", "origin", `refs/heads/${a.headRef}`], wt)
      ).stdout.split(/\s+/)[0];
      if (tip !== a.headSha)
        throw new PersonToolError(
          `${a.headRef} moved from ${a.headSha.slice(0, 7)} to ${(tip ?? "").slice(0, 7) || "nothing"} since you looked. Look again.`,
          "git ls-remote",
          null,
          "",
        );
      const root = this.o.adrRoot === undefined ? [] : ["--root", this.o.adrRoot];
      const args = [
        ...this.adr,
        command,
        a.adr,
        ...(command === "reject" ? ["--reason", a.reason ?? ""] : []),
        "--commit",
        "--json",
        ...root,
      ];
      const out = (await this.sh(args, wt, this.signingEnv())).stdout;
      let ok = true;
      try {
        ok = (JSON.parse(out) as { ok?: boolean }).ok !== false;
      } catch {
        // Not JSON: the exit code was zero, which is what counts.
      }
      if (!ok)
        throw new PersonToolError(
          `adr ${command} refused: ${firstLines(out)}`,
          args.join(" "),
          0,
          out,
        );
      const sha = (await this.sh([this.git, "rev-parse", "HEAD"], wt)).stdout.trim();
      const parent = (await this.sh([this.git, "rev-parse", "HEAD^"], wt)).stdout.trim();
      if (sha === a.headSha || parent !== a.headSha)
        throw new PersonToolError(
          `adr ${command} did not make one commit on ${a.headSha.slice(0, 7)}`,
          args.join(" "),
          0,
          out,
        );
      const raw = (await this.sh([this.git, "cat-file", "commit", sha], wt)).stdout;
      if (!/^gpgsig/m.test(raw))
        throw new PersonToolError(
          "the commit is not signed, so draft did not push it. Check your git signing setup.",
          "git cat-file",
          null,
          "",
        );
      await this.sh([this.git, "push", "origin", `HEAD:refs/heads/${a.headRef}`], wt);
      return { sha, signed: true as const, signer, output: firstLines(out, 2) };
    });
  }

  acceptAdr(a: {
    repo: string;
    adr: string;
    headRef: string;
    headSha: string;
  }): Promise<AcceptCommit> {
    return this.adrCommit("accept", a);
  }

  rejectAdr(a: {
    repo: string;
    adr: string;
    headRef: string;
    headSha: string;
    reason: string;
  }): Promise<AcceptCommit> {
    return this.adrCommit("reject", a);
  }

  private async api(
    method: string,
    path: string,
    fields: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    await mkdir(this.base, { recursive: true });
    const args = [
      ...this.gh,
      "api",
      "-X",
      method,
      path,
      ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`]),
    ];
    const { stdout } = await this.sh(args, this.base);
    try {
      return stdout.trim() === "" ? {} : (JSON.parse(stdout) as Record<string, unknown>);
    } catch {
      return {};
    }
  }

  /** Merges a pull request by rebase, as the person, at the head commit they saw. */
  async mergePullRequest(p: {
    repo: string;
    number: number;
    headSha: string;
  }): Promise<MergeResult> {
    const r = await this.api("PUT", `repos/${p.repo}/pulls/${p.number}/merge`, {
      merge_method: "rebase",
      sha: p.headSha,
    });
    if (r.merged !== true || typeof r.sha !== "string")
      throw new PersonToolError(
        `GitHub did not merge ${p.repo}#${p.number}: ${typeof r.message === "string" ? r.message : "no answer"}`,
        "gh api",
        null,
        "",
      );
    return { sha: r.sha, message: typeof r.message === "string" ? r.message : "" };
  }

  /** Closes a pull request with the person's reason as a comment. */
  async closePullRequest(p: { repo: string; number: number; reason: string }): Promise<void> {
    await this.api("POST", `repos/${p.repo}/issues/${p.number}/comments`, { body: p.reason });
    await this.api("PATCH", `repos/${p.repo}/pulls/${p.number}`, { state: "closed" });
  }
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`the request has no ${what}`);
  return v;
};

/**
 * What an acceptance request's answers do for the kinds that exist: the ADR accepts and rejects with
 * a signed commit on its pull request's branch, the pull request merges by rebase or is closed with
 * a comment.
 */
export function personActions(tools: PersonTools): AcceptanceActions {
  return {
    adr: {
      async accept(w) {
        const c = await tools.acceptAdr({
          repo: str(w.repo, "repo"),
          adr: str(w.adr, "decision"),
          headRef: str(w.headRef, "branch"),
          headSha: str(w.headSha, "commit"),
        });
        return {
          sha: c.sha,
          summary: `accepted ${w.adr} in a signed commit ${c.sha.slice(0, 7)} on ${w.headRef}, as ${c.signer.name} <${c.signer.email}>`,
        };
      },
      async reject(w, reason) {
        const c = await tools.rejectAdr({
          repo: str(w.repo, "repo"),
          adr: str(w.adr, "decision"),
          headRef: str(w.headRef, "branch"),
          headSha: str(w.headSha, "commit"),
          reason,
        });
        return {
          sha: c.sha,
          summary: `rejected ${w.adr} in a signed commit ${c.sha.slice(0, 7)} on ${w.headRef}, as ${c.signer.name} <${c.signer.email}>`,
        };
      },
    },
    "pull-request": {
      async accept(w) {
        const r = await tools.mergePullRequest({
          repo: str(w.repo, "repo"),
          number: Number(w.number),
          headSha: str(w.headSha, "commit"),
        });
        return {
          sha: r.sha,
          summary: `merged ${w.repo}#${w.number} by rebase, now ${r.sha.slice(0, 7)}`,
        };
      },
      async reject(w, reason) {
        await tools.closePullRequest({
          repo: str(w.repo, "repo"),
          number: Number(w.number),
          reason,
        });
        return { sha: null, summary: `closed ${w.repo}#${w.number} with your reason as a comment` };
      },
    },
  };
}
