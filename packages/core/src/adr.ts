import {
  type AcceptanceKind,
  acceptanceCandidates,
  type EvidenceItem,
  registerAcceptanceKind,
  withdrawnBecause,
} from "./acceptance.ts";
import { ARK_ID, dataField, escapeRe, parseEventFiles } from "./ark-issue.ts";
import type { Target } from "./events.ts";
import type { GithubClient } from "./github.ts";
import type { InterruptCandidate } from "./interrupts.ts";
import {
  checksEvidence,
  type PullRequestCheck,
  type PullRequestResolver,
  type PullRequestState,
} from "./pull-request.ts";
import type { Resolver } from "./resolver.ts";

/**
 * ADRs as live stubs, and as the first kind that waits for acceptance. A decision's state is never
 * stored: it is folded from its event files, the way adr folds them. A reference names the
 * repository (`owner/repo:adrid`, or a configured source name, `draft:9p8jj6p5`) or links to one
 * of the decision's files; the target's id is `owner/repo:adrid`.
 *
 * A proposal usually lives on a pull request's branch before it reaches the default branch, so
 * the resolver looks there too: it finds the open pull request in the same repository that touches
 * the decision's files, reads the decision at that branch's head, and carries the pull request's
 * checks and the result of `adr verify` at that head. That is the evidence the ADR kind declares.
 */

export type AdrStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "deprecated"
  | "superseded";

export interface AdrEvent {
  type: string;
  at: string;
  file: string;
}

/** The pull request that proposes a decision: the branch the accept commit goes on, and its checks. */
export interface AdrProposal {
  /** The pull request target id, `owner/repo/pull/12`. */
  id: string;
  number: number;
  url: string;
  title: string;
  state: PullRequestState["state"];
  draft: boolean;
  headRef: string;
  headSha: string;
  headRepo: string | null;
  baseRef: string;
  checks: PullRequestCheck[];
  mergeableState: string;
}

export type AdrVerifyStatus = "clean" | "findings" | "failed";

/** What `adr verify` said at one commit. */
export interface AdrVerifyResult {
  sha: string;
  status: AdrVerifyStatus;
  /** How many findings; zero when clean. */
  findings: number;
  /** A line a person can read: the first findings, or why it could not run. */
  summary: string;
}

/** Runs `adr verify` on a repository at a commit. The desktop app does it in its own clone. */
export interface AdrVerifier {
  verify(repo: string, sha: string): Promise<AdrVerifyResult>;
}

export interface AdrState {
  repo: string;
  id: string;
  title: string | null;
  /** The status at `statusAt`: the pull request's head while one proposes it, else the default branch. */
  status: AdrStatus;
  statusAt: { where: "pull-request" | "default-branch"; sha: string | null };
  events: AdrEvent[];
  eventCount: number;
  url: string;
  proposedBy: AdrProposal | null;
  /** The result of `adr verify` at the proposing pull request's head; null until it ran. */
  verify: AdrVerifyResult | null;
  [key: string]: unknown;
}

export interface AdrOptions {
  /** Source name to `owner/repo`, as in adr's `[[sources]]`. */
  sources?: Readonly<Record<string, string>>;
  /** Where the decision log is in each repository. */
  root?: string;
  /** Runs `adr verify` at a pull request's head. Without it the verify evidence never turns green. */
  verifier?: AdrVerifier;
  /** How many open pull requests are searched for the one that proposes a decision. */
  maxPulls?: number;
}

export function adrId(repo: string, id: string): string {
  return `${repo}:${id}`;
}

export function parseAdrId(id: string): { repo: string; adr: string } | null {
  const m = new RegExp(`^([^/:]+/[^/:]+):(${ARK_ID})$`).exec(id);
  return m === null ? null : { repo: m[1] as string, adr: m[2] as string };
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";

/** A decision's status from its events, oldest first: the last that settles it, else proposed. */
export function foldStatus(events: readonly AdrEvent[]): AdrStatus {
  let status: AdrStatus = "proposed";
  for (const e of events) {
    if (
      e.type === "accepted" ||
      e.type === "rejected" ||
      e.type === "withdrawn" ||
      e.type === "deprecated" ||
      e.type === "superseded"
    )
      status = e.type;
  }
  return status;
}

export class AdrResolver implements Resolver {
  readonly type = "adr";
  readonly version = "1";
  private readonly root: string;
  private readonly sources: Readonly<Record<string, string>>;
  private readonly maxPulls: number;
  /** Event files never change, so what was read from one is kept. */
  private readonly texts = new Map<string, string | null>();
  private readonly verified = new Map<string, AdrVerifyResult>();

  constructor(
    private readonly github: GithubClient,
    private readonly pulls: PullRequestResolver,
    private readonly o: AdrOptions = {},
  ) {
    this.root = (o.root ?? "docs/adr").replace(/^\/+|\/+$/g, "");
    this.sources = o.sources ?? {};
    this.maxPulls = o.maxPulls ?? 30;
  }

  detect(text: string): string[] {
    const seen = new Set<string>();
    const literal = new RegExp(
      `(?<![A-Za-z0-9._:/-])(${OWNER}/${REPO}):(${ARK_ID})(?![0-9A-Za-z])`,
      "g",
    );
    for (const m of text.matchAll(literal)) seen.add(adrId(m[1] as string, m[2] as string));
    const names = Object.keys(this.sources);
    if (names.length > 0) {
      const re = new RegExp(
        `(?<![A-Za-z0-9._:/-])(${names.map(escapeRe).join("|")}):(${ARK_ID})(?![0-9A-Za-z])`,
        "g",
      );
      for (const m of text.matchAll(re)) {
        const repo = this.sources[m[1] as string];
        if (repo !== undefined) seen.add(adrId(repo, m[2] as string));
      }
    }
    const link = new RegExp(
      `github\\.com/(${OWNER}/${REPO})/(?:blob|tree)/[^\\s]+?/${escapeRe(this.root)}/(?:decisions/(${ARK_ID})-[^\\s/]*\\.md|events/(${ARK_ID})(?:/[^\\s/]*)?)(?![0-9A-Za-z])`,
      "g",
    );
    for (const m of text.matchAll(link)) seen.add(adrId(m[1] as string, (m[2] ?? m[3]) as string));
    return [...seen];
  }

  private async text(repo: string, path: string, ref: string | null): Promise<string | null> {
    const key = `${repo}/${ref ?? "-"}/${path}`;
    if (this.texts.has(key)) return this.texts.get(key) ?? null;
    const q = ref === null ? "" : `?ref=${encodeURIComponent(ref)}`;
    const t = await this.github.getText(`/repos/${repo}/contents/${path}${q}`);
    this.texts.set(key, t);
    return t;
  }

  /** The decision's events at a ref (the default branch when null), oldest first. */
  private async events(repo: string, adr: string, ref: string | null): Promise<AdrEvent[]> {
    const q = ref === null ? "" : `?ref=${encodeURIComponent(ref)}`;
    const listing = await this.github.getJson<{ name: string; type: string }[]>(
      `/repos/${repo}/contents/${this.root}/events/${adr}${q}`,
    );
    return listing === null || !Array.isArray(listing) ? [] : parseEventFiles(listing);
  }

  /** The open pull request in this repository that touches the decision's files, newest first. */
  private async proposingPull(repo: string, adr: string): Promise<string | null> {
    const open = await this.github.getJson<{ number: number; updated_at?: string }[]>(
      `/repos/${repo}/pulls?state=open&per_page=${this.maxPulls}`,
    );
    if (open === null) return null;
    const prefixes = [`${this.root}/events/${adr}/`, `${this.root}/decisions/${adr}-`];
    const candidates = [...open]
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, this.maxPulls);
    const files = await Promise.all(
      candidates.map((p) =>
        this.github.getJson<{ filename: string }[]>(
          `/repos/${repo}/pulls/${p.number}/files?per_page=100`,
        ),
      ),
    );
    const at = files.findIndex((fs) =>
      (fs ?? []).some((f) => prefixes.some((p) => f.filename.startsWith(p))),
    );
    return at === -1 ? null : `${repo}/pull/${(candidates[at] as { number: number }).number}`;
  }

  async fetch(id: string): Promise<Record<string, unknown> | null> {
    const p = parseAdrId(id);
    if (p === null) return null;
    const onDefault = await this.events(p.repo, p.adr, null);
    const settled = onDefault.length > 0 && foldStatus(onDefault) !== "proposed";
    let proposal: AdrProposal | null = null;
    if (!settled) {
      const prId = await this.proposingPull(p.repo, p.adr);
      const pr = prId === null ? null : await this.pulls.fetch(prId);
      if (pr !== null) proposal = proposalOf(prId as string, pr as unknown as PullRequestState);
    }
    // The decision is read where its pull request left it, while one proposes it.
    const useBranch = proposal !== null && proposal.state === "open";
    const events = useBranch
      ? await this.events(p.repo, p.adr, (proposal as AdrProposal).headSha)
      : onDefault;
    if (events.length === 0) return null;
    const opened = events.find((e) => e.type === "proposed");
    const ref = useBranch ? (proposal as AdrProposal).headSha : null;
    const title =
      opened === undefined
        ? null
        : dataField(
            (await this.text(p.repo, `${this.root}/events/${p.adr}/${opened.file}`, ref)) ?? "",
            "title",
          );
    const status = foldStatus(events);
    const verify =
      useBranch && status === "proposed" && this.o.verifier !== undefined
        ? await this.verify(p.repo, (proposal as AdrProposal).headSha)
        : null;
    const state: AdrState = {
      repo: p.repo,
      id: p.adr,
      title,
      status,
      statusAt: {
        where: useBranch ? "pull-request" : "default-branch",
        sha: useBranch ? (proposal as AdrProposal).headSha : null,
      },
      events,
      eventCount: events.length,
      url: `https://github.com/${p.repo}/tree/${useBranch ? (proposal as AdrProposal).headRef : "HEAD"}/${this.root}/events/${p.adr}`,
      proposedBy: proposal,
      verify,
    };
    return state;
  }

  private async verify(repo: string, sha: string): Promise<AdrVerifyResult> {
    const key = `${repo}@${sha}`;
    const known = this.verified.get(key);
    if (known !== undefined) return known;
    let result: AdrVerifyResult;
    try {
      result = await (this.o.verifier as AdrVerifier).verify(repo, sha);
    } catch (err) {
      // Not cached: it may work next time. The evidence says why it is not green.
      return {
        sha,
        status: "failed",
        findings: 0,
        summary:
          `adr verify could not run: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            300,
          ),
      };
    }
    this.verified.set(key, result);
    return result;
  }

  interrupts(target: Target, state: Record<string, unknown>): InterruptCandidate[] {
    return acceptanceCandidates(adrAcceptance, target, state);
  }

  clearedBecause(
    open: { detail: Record<string, unknown> },
    target: Target,
    state: Record<string, unknown>,
  ): string | null {
    return open.detail.acceptance === adrAcceptance.name
      ? withdrawnBecause(adrAcceptance, target, state)
      : null;
  }
}

function proposalOf(id: string, s: PullRequestState): AdrProposal {
  return {
    id,
    number: s.number,
    url: s.url,
    title: s.title,
    state: s.state,
    draft: s.draft,
    headRef: s.headRef,
    headSha: s.headSha,
    headRepo: s.headRepo,
    baseRef: s.baseRef,
    checks: s.checks,
    mergeableState: s.mergeableState,
  };
}

function verifyEvidence(s: AdrState): EvidenceItem {
  const base = { id: "verify", label: "adr verify", url: null };
  const head = s.proposedBy?.headSha;
  if (s.verify === null || s.verify.sha !== head)
    return { ...base, status: "pending", detail: "not run on this commit yet" };
  if (s.verify.status === "clean") return { ...base, status: "green", detail: "no findings" };
  return { ...base, status: "red", detail: s.verify.summary };
}

/**
 * A decision waiting to be accepted. Ready means: it is proposed at the head of an open pull
 * request in its own repository (so the accept commit has a branch to go on), `adr verify` is
 * clean there and every check of that pull request has passed. Accepting makes the accept commit
 * as the person, signed, on that branch; merging the pull request is a second acceptance. Rejecting
 * records the rejection with adr, with the person's reason.
 */
export const adrAcceptance: AcceptanceKind = {
  name: "adr",
  resolver: "adr",
  accept: {
    label: "Accept",
    effectKind: "adr.accept",
    effect: {
      steps: ["git.worktree", "adr.accept", "git.push"],
      inverse: { kind: "compensable", step: "adr.supersede" },
    },
  },
  reject: {
    label: "Reject",
    effectKind: "adr.reject",
    effect: {
      steps: ["git.worktree", "adr.reject", "git.push"],
      inverse: { kind: "compensable", step: "adr.propose-again" },
    },
  },
  subject(target, state) {
    const s = state as AdrState;
    const pr = s.proposedBy;
    if (s.status !== "proposed" || pr === null || pr.state !== "open") return null;
    // The accept commit goes on the pull request's branch, which has to be this repository's.
    if (pr.headRepo !== s.repo) return null;
    const name = `${s.repo}:${s.id}`;
    const title = s.title ?? s.id;
    return {
      key: `accept:adr:${target.id}:${pr.headSha}`,
      title,
      summary: `${name}: “${title}” is ready to accept`,
      sha: pr.headSha,
      url: s.url,
      evidence: [verifyEvidence(s), checksEvidence(pr.checks, pr.url)],
      accepts: `Commit the acceptance of ${name} as you, signed, on ${pr.headRef} of #${pr.number}, and push it. Merging #${pr.number} is a separate acceptance.`,
      rejects: `Record the rejection of ${name} with your reason, signed, on ${pr.headRef} of #${pr.number}.`,
      where: {
        repo: s.repo,
        adr: s.id,
        pullRequest: pr.id,
        number: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
      },
    };
  },
};
registerAcceptanceKind(adrAcceptance);
