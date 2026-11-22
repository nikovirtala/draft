import {
  type AcceptanceKind,
  acceptanceCandidates,
  type EvidenceItem,
  registerAcceptanceKind,
  withdrawnBecause,
} from "./acceptance.ts";
import type { Target } from "./events.ts";
import type { GithubClient } from "./github.ts";
import type { InterruptCandidate } from "./interrupts.ts";
import type { Resolver } from "./resolver.ts";

/**
 * Pull requests as live stubs. The snapshot carries what acceptance needs later: the check runs
 * with their conclusions, the review state, and whether the pull request can merge. It is a pure
 * function of what GitHub says, so an unchanged pull request produces an unchanged state and no
 * status event.
 *
 * A pull request's id is `owner/repo/pull/123`.
 */

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const URL_RE = new RegExp(
  `(?<![A-Za-z0-9._/-])(?:https?://)?github\\.com/(${OWNER})/(${REPO})/pull/(\\d{1,7})(?![0-9])`,
  "g",
);
const SHORT_RE = new RegExp(
  `(?<![A-Za-z0-9._/#-])(${OWNER})/(${REPO})#(\\d{1,7})(?![0-9A-Za-z])`,
  "g",
);

export function pullRequestId(owner: string, repo: string, n: number | string): string {
  return `${owner}/${repo}/pull/${n}`;
}

export function parsePullRequestId(
  id: string,
): { owner: string; repo: string; number: number } | null {
  const m = /^([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(id);
  return m === null ? null : { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

/** Check conclusions that need someone: the check failed or is waiting on a person. */
const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
/** Whether a completed check's conclusion is one that needs someone. */
export const isFailedConclusion = (conclusion: string | null): boolean =>
  conclusion !== null && FAILED.has(conclusion);
const PASSED = new Set(["success", "neutral", "skipped"]);

export interface PullRequestCheck {
  name: string;
  /** A check run, or a commit status (the older API). */
  source: "check-run" | "status";
  status: "queued" | "in_progress" | "completed";
  /** The conclusion once completed: success, failure, timed_out, ... */
  conclusion: string | null;
  url: string | null;
}

export interface PullRequestState {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
  headSha: string;
  /** The commit a merge made on the base branch; null until it is merged. */
  mergeCommitSha: string | null;
  /** The branch it is from, and the repository that has it (a fork's, when it is from one). */
  headRef: string;
  headRepo: string | null;
  baseRef: string;
  /** Whether it can merge; null while GitHub is still working it out. */
  mergeable: boolean | null;
  /** GitHub's own word: clean, dirty (a conflict), blocked, behind, unstable, unknown, ... */
  mergeableState: string;
  checks: PullRequestCheck[];
  checksSummary: { total: number; passed: number; failed: number; pending: number };
  review: {
    decision: "approved" | "changes_requested" | "none";
    /** The latest verdict of each reviewer who gave one. */
    reviews: { user: string; state: string; id: number }[];
    requested: string[];
  };
  /** Whether a review is requested from the person draft acts for. */
  viewerReviewRequested: boolean;
  updatedAt: string;
  [key: string]: unknown;
}

interface ApiPull {
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  user?: { login: string } | null;
  head: { sha: string; ref?: string; repo?: { full_name: string } | null };
  base: { ref: string };
  mergeable: boolean | null;
  mergeable_state?: string;
  merge_commit_sha?: string | null;
  requested_reviewers?: { login: string }[];
  updated_at: string;
}

interface ApiCheckRuns {
  check_runs?: {
    name: string;
    status: PullRequestCheck["status"];
    conclusion: string | null;
    html_url?: string | null;
  }[];
}

interface ApiStatus {
  statuses?: { context: string; state: string; target_url?: string | null }[];
}

interface ApiReview {
  id: number;
  user?: { login: string } | null;
  state: string;
}

export class PullRequestResolver implements Resolver {
  readonly type = "pull-request";
  readonly version = "1";

  /** `viewer` is the login draft acts for, when it can tell; without it no review is "yours". */
  constructor(
    private readonly github: GithubClient,
    private readonly viewer: () => Promise<string | null> = async () => null,
  ) {}

  detect(text: string): string[] {
    const seen = new Set<string>();
    for (const re of [URL_RE, SHORT_RE])
      for (const m of text.matchAll(re))
        seen.add(pullRequestId(m[1] as string, m[2] as string, m[3] as string));
    return [...seen];
  }

  async fetch(id: string): Promise<Record<string, unknown> | null> {
    const p = parsePullRequestId(id);
    if (p === null) return null;
    const base = `/repos/${p.owner}/${p.repo}`;
    const pull = await this.github.getJson<ApiPull>(`${base}/pulls/${p.number}`);
    if (pull === null) return null;
    const sha = pull.head.sha;
    const [runs, combined, reviews, viewer] = await Promise.all([
      this.github.getJson<ApiCheckRuns>(`${base}/commits/${sha}/check-runs?per_page=100`),
      this.github.getJson<ApiStatus>(`${base}/commits/${sha}/status?per_page=100`),
      this.github.getJson<ApiReview[]>(`${base}/pulls/${p.number}/reviews?per_page=100`),
      this.viewer(),
    ]);
    return toState(p, pull, runs, combined, reviews ?? [], viewer);
  }

  interrupts(target: Target, state: Record<string, unknown>): InterruptCandidate[] {
    const s = state as PullRequestState;
    if (s.state !== "open") return [];
    const name = `${s.repo}#${s.number}`;
    const out: InterruptCandidate[] = [];
    for (const c of s.checks)
      if (c.status === "completed" && c.conclusion !== null && FAILED.has(c.conclusion))
        out.push({
          key: `pr-check:${target.id}:${s.headSha}:${c.name}`,
          kind: "failed-check",
          summary: `${name}: the check “${c.name}” ${c.conclusion === "action_required" ? "needs action" : "failed"}`,
          detail: {
            pr: target.id,
            check: c.name,
            conclusion: c.conclusion,
            url: c.url,
            sha: s.headSha,
          },
        });
    if (s.mergeableState === "dirty")
      out.push({
        key: `pr-conflict:${target.id}:${s.headSha}`,
        kind: "merge-conflict",
        summary: `${name} has a merge conflict with ${s.baseRef}`,
        detail: { pr: target.id, base: s.baseRef, sha: s.headSha },
      });
    if (s.review.decision === "changes_requested") {
      const latest = s.review.reviews.filter((r) => r.state === "CHANGES_REQUESTED");
      const newest = latest.reduce((a, b) => (b.id > a.id ? b : a));
      out.push({
        key: `pr-changes:${target.id}:${newest.id}`,
        kind: "changes-requested",
        summary: `${name}: ${latest.map((r) => r.user).join(", ")} requested changes`,
        detail: { pr: target.id, reviewers: latest.map((r) => r.user), review: newest.id },
      });
    }
    if (s.viewerReviewRequested)
      out.push({
        key: `pr-review:${target.id}:${s.headSha}`,
        kind: "review-requested",
        summary: `${name}: your review is requested`,
        detail: { pr: target.id, sha: s.headSha },
      });
    out.push(...acceptanceCandidates(pullRequestAcceptance, target, state));
    return out;
  }

  clearedBecause(
    open: { detail: Record<string, unknown> },
    target: Target,
    state: Record<string, unknown>,
  ) {
    return open.detail.acceptance === pullRequestAcceptance.name
      ? withdrawnBecause(pullRequestAcceptance, target, state)
      : null;
  }
}

/**
 * The evidence of the checks of a commit: green when every check reported has passed, red when one
 * failed, pending while one still runs. draft can't see which checks a repository requires without
 * admin rights, so it asks for all of them: it shows a request later than it must, never earlier.
 */
export function checksEvidence(checks: readonly PullRequestCheck[], url: string): EvidenceItem {
  const failed = checks.filter(
    (c) => c.status === "completed" && c.conclusion !== null && FAILED.has(c.conclusion),
  );
  const pending = checks.filter((c) => c.status !== "completed");
  const passed = checks.length - failed.length - pending.length;
  const base = { id: "checks", label: "Checks", url };
  if (failed.length > 0)
    return {
      ...base,
      status: "red",
      detail: `${failed.map((c) => c.name).join(", ")} failed (${passed} of ${checks.length} passed)`,
    };
  if (pending.length > 0)
    return {
      ...base,
      status: "pending",
      detail: `${pending.map((c) => c.name).join(", ")} still running (${passed} of ${checks.length} passed)`,
    };
  return {
    ...base,
    status: "green",
    detail: checks.length === 0 ? "no checks reported" : `${passed} of ${checks.length} passed`,
  };
}

/**
 * A pull request waiting to merge. Ready means: open, not a draft, every check passed, GitHub
 * says it can merge (its mergeable state is clean, which counts the repository's own rules: the
 * required checks and reviews), and no review asks for changes. Accepting merges it by rebase
 * as the person; rejecting closes it with the person's reason as a comment.
 */
export const pullRequestAcceptance: AcceptanceKind = {
  name: "pull-request",
  resolver: "pull-request",
  accept: {
    label: "Merge",
    effectKind: "pull-request.merge",
    effect: {
      steps: ["pull-request.merge"],
      inverse: { kind: "compensable", step: "pull-request.revert" },
    },
  },
  reject: {
    label: "Close",
    effectKind: "pull-request.close",
    effect: {
      steps: ["pull-request.comment", "pull-request.close"],
      inverse: { kind: "reversible", step: "pull-request.reopen" },
    },
  },
  subject(target, state) {
    const s = state as PullRequestState;
    if (s.state !== "open") return null;
    const state_: EvidenceItem =
      s.mergeable === null || s.mergeableState === "unknown"
        ? {
            id: "mergeable",
            label: "Mergeable",
            status: "pending",
            detail: "GitHub is still working it out",
            url: null,
          }
        : s.mergeable === true && (s.mergeableState === "clean" || s.mergeableState === "has_hooks")
          ? {
              id: "mergeable",
              label: "Mergeable",
              status: "green",
              detail: `GitHub says ${s.mergeableState}`,
              url: null,
            }
          : {
              id: "mergeable",
              label: "Mergeable",
              status: "red",
              detail:
                s.mergeable === false ? "it has a conflict" : `GitHub says ${s.mergeableState}`,
              url: null,
            };
    const evidence: EvidenceItem[] = [
      s.draft
        ? {
            id: "ready",
            label: "Ready for review",
            status: "red",
            detail: "it is a draft",
            url: null,
          }
        : { id: "ready", label: "Ready for review", status: "green", detail: null, url: null },
      checksEvidence(s.checks, s.url),
      state_,
      s.review.decision === "changes_requested"
        ? {
            id: "reviews",
            label: "Reviews",
            status: "red",
            detail: `${s.review.reviews
              .filter((r) => r.state === "CHANGES_REQUESTED")
              .map((r) => r.user)
              .join(", ")} requested changes`,
            url: s.url,
          }
        : {
            id: "reviews",
            label: "Reviews",
            status: "green",
            detail:
              s.review.decision === "approved"
                ? `approved by ${s.review.reviews
                    .filter((r) => r.state === "APPROVED")
                    .map((r) => r.user)
                    .join(", ")}`
                : "no review asks for changes",
            url: null,
          },
    ];
    const name = `${s.repo}#${s.number}`;
    return {
      key: `accept:pull-request:${target.id}:${s.headSha}`,
      title: s.title,
      summary: `${name}: ready to merge, “${s.title}”`,
      sha: s.headSha,
      url: s.url,
      evidence,
      accepts: `Merge ${name} into ${s.baseRef} by rebase, as you, at ${s.headSha.slice(0, 7)}.`,
      rejects: `Close ${name} with your reason as a comment.`,
      where: { repo: s.repo, number: s.number, base: s.baseRef, headSha: s.headSha },
    };
  },
};
registerAcceptanceKind(pullRequestAcceptance);

function toState(
  p: { owner: string; repo: string; number: number },
  pull: ApiPull,
  runs: ApiCheckRuns | null,
  combined: ApiStatus | null,
  reviews: ApiReview[],
  viewer: string | null,
): PullRequestState {
  const checks: PullRequestCheck[] = [
    ...(runs?.check_runs ?? []).map(
      (c): PullRequestCheck => ({
        name: c.name,
        source: "check-run",
        status: c.status,
        conclusion: c.conclusion,
        url: c.html_url ?? null,
      }),
    ),
    ...(combined?.statuses ?? []).map(
      (c): PullRequestCheck => ({
        name: c.context,
        source: "status",
        status: c.state === "pending" ? "in_progress" : "completed",
        conclusion: c.state === "pending" ? null : c.state === "success" ? "success" : "failure",
        url: c.target_url ?? null,
      }),
    ),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.source < b.source ? -1 : 1));

  const latest = new Map<string, { user: string; state: string; id: number }>();
  for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
    const user = r.user?.login;
    if (user === undefined) continue;
    // A comment doesn't change a verdict; a dismissal removes it.
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    if (r.state === "DISMISSED") latest.delete(user);
    else latest.set(user, { user, state: r.state, id: r.id });
  }
  const verdicts = [...latest.values()].sort((a, b) => (a.user < b.user ? -1 : 1));
  const decision = verdicts.some((v) => v.state === "CHANGES_REQUESTED")
    ? "changes_requested"
    : verdicts.some((v) => v.state === "APPROVED")
      ? "approved"
      : "none";
  const requested = (pull.requested_reviewers ?? []).map((u) => u.login).sort();
  const done = checks.filter((c) => c.status === "completed");
  return {
    repo: `${p.owner}/${p.repo}`,
    number: p.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.merged === true ? "merged" : pull.state,
    draft: pull.draft === true,
    author: pull.user?.login ?? null,
    headSha: pull.head.sha,
    mergeCommitSha: pull.merged === true ? (pull.merge_commit_sha ?? null) : null,
    headRef: pull.head.ref ?? "",
    headRepo: pull.head.repo?.full_name ?? null,
    baseRef: pull.base.ref,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state ?? "unknown",
    checks,
    checksSummary: {
      total: checks.length,
      passed: done.filter((c) => c.conclusion !== null && PASSED.has(c.conclusion)).length,
      failed: done.filter((c) => c.conclusion !== null && FAILED.has(c.conclusion)).length,
      pending: checks.length - done.length,
    },
    review: { decision, reviews: verdicts, requested },
    viewerReviewRequested: viewer !== null && requested.includes(viewer),
    updatedAt: pull.updated_at,
  };
}
