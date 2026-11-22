import type { FakeGithub } from "./fake-github.ts";

/**
 * A repository with ark records for the map's tests and the end-to-end run: seven decisions, one in
 * each state (one only on the branch of an open pull request), six issues (open, in progress, and
 * closed in three ways) and deployments to two environments (a success that a newer run made
 * inactive, a success, a failure). Times start at `start` and are minutes apart.
 */

export const ARK_REPO = "nikovirtala/draft";
export const ADR_IDS = {
  accepted: "a0000001",
  superseded: "a0000002",
  rejected: "a0000003",
  withdrawn: "a0000004",
  deprecated: "a0000005",
  proposed: "a0000006",
  onBranch: "a0000007",
} as const;
export const ISSUE_IDS = {
  open: "b0000001",
  inProgress: "b0000002",
  done: "b0000003",
  wontfix: "b0000004",
  obsolete: "b0000005",
  reopened: "b0000006",
} as const;
export const ARK_PULL = 11;
export const ARK_PULL_HEAD = "9".repeat(40);

export const ARK_FIXTURE_START = Date.UTC(2026, 10, 20, 9, 0, 0);

const stamp = (start: number, minute: number): string =>
  new Date(start + minute * 60_000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const iso = (start: number, minute: number): string =>
  new Date(start + minute * 60_000).toISOString();

function eventFile(
  root: string,
  id: string,
  minute: number,
  n: number,
  type: string,
  data: Record<string, string>,
  start: number,
): [string, string] {
  const name = `${stamp(start, minute)}-${String(n).padStart(4, "0")}-${type}.yaml`;
  const body = Object.entries(data)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  return [
    `${root}/events/${id}/${name}`,
    `envelope: ledger/v1\nsubject: ${id}\ntype: ${type}\ndata:\n${body === "" ? "  {}" : body}\n`,
  ];
}

export interface ArkFixture {
  /** The decisions on the default branch, then the one the pull request adds. */
  titles: Record<string, string>;
  start: number;
}

/** Puts the fixture's files, pull request and deployments into a fake GitHub. */
export function seedArk(
  github: FakeGithub,
  repo: string = ARK_REPO,
  start: number = ARK_FIXTURE_START,
): ArkFixture {
  const files: Record<string, string> = {};
  const add = ([path, text]: [string, string]) => {
    files[path] = text;
  };
  const adr = (id: string, minute: number, title: string, ...later: string[]) => {
    add(eventFile("docs/adr", id, minute, 1, "proposed", { title }, start));
    later.forEach((type, i) => {
      add(eventFile("docs/adr", id, minute + 1 + i, 2 + i, type, { reason: "because" }, start));
    });
  };
  adr(ADR_IDS.accepted, 1, "Keep the log append-only", "accepted");
  adr(ADR_IDS.superseded, 3, "Run one agent per context", "accepted", "superseded");
  adr(ADR_IDS.rejected, 6, "Write the log as SQLite", "rejected");
  adr(ADR_IDS.withdrawn, 8, "Poll every stub every second", "withdrawn");
  adr(ADR_IDS.deprecated, 10, "Show interrupts in the title bar only", "accepted", "deprecated");
  adr(ADR_IDS.proposed, 14, "Draw the map from one fold");
  const issue = (id: string, minute: number, title: string, ...later: [string, string?][]) => {
    add(eventFile("docs/issues", id, minute, 1, "opened", { title }, start));
    later.forEach(([type, resolution], i) => {
      add(
        eventFile(
          "docs/issues",
          id,
          minute + 1 + i,
          2 + i,
          type,
          resolution === undefined ? {} : { resolution },
          start,
        ),
      );
    });
  };
  issue(ISSUE_IDS.open, 2, "Name threads");
  issue(ISSUE_IDS.inProgress, 4, "Draw the map", ["started"]);
  issue(ISSUE_IDS.done, 5, "Add threads", ["started"], ["closed", "done"]);
  issue(ISSUE_IDS.wontfix, 7, "Support two logs", ["closed", "wontfix"]);
  issue(ISSUE_IDS.obsolete, 9, "Poll faster", ["closed", "obsolete"]);
  issue(ISSUE_IDS.reopened, 11, "Fix the flaky test", ["closed", "done"], ["reopened"]);
  github.addFiles(repo, "main", files);

  // A decision that is only on the branch of an open pull request.
  const onBranch: Record<string, string> = { ...files };
  const [path, text] = eventFile(
    "docs/adr",
    ADR_IDS.onBranch,
    16,
    1,
    "proposed",
    { title: "Show ark records on the map" },
    start,
  );
  onBranch[path] = text;
  github.addPull(repo, ARK_PULL, {
    title: "Propose: show ark records on the map",
    headSha: ARK_PULL_HEAD,
    headRef: "adr-ark-records",
  });
  github.addFiles(repo, ARK_PULL_HEAD, onBranch);

  const sha = (c: string) => c.repeat(40);
  github.addDeployment(repo, {
    id: 101,
    sha: sha("1"),
    ref: "main",
    environment: "production",
    createdAt: iso(start, 20),
    statuses: [
      { state: "queued", at: iso(start, 20) },
      { state: "in_progress", at: iso(start, 21) },
      { state: "success", at: iso(start, 23), environmentUrl: "https://example.com" },
      { state: "inactive", at: iso(start, 32) },
    ],
  });
  github.addDeployment(repo, {
    id: 102,
    sha: sha("2"),
    ref: "main",
    environment: "production",
    createdAt: iso(start, 30),
    statuses: [
      { state: "queued", at: iso(start, 30) },
      { state: "in_progress", at: iso(start, 31) },
      {
        state: "success",
        at: iso(start, 32),
        logUrl: "https://github.com/nikovirtala/draft/actions/runs/2",
      },
    ],
  });
  github.addDeployment(repo, {
    id: 103,
    sha: sha("3"),
    ref: "main",
    environment: "staging",
    createdAt: iso(start, 34),
    statuses: [
      { state: "in_progress", at: iso(start, 35) },
      {
        state: "failure",
        at: iso(start, 36),
        logUrl: "https://github.com/nikovirtala/draft/actions/runs/3",
      },
    ],
  });
  return {
    start,
    titles: {
      [ADR_IDS.proposed]: "Draw the map from one fold",
      [ADR_IDS.onBranch]: "Show ark records on the map",
    },
  };
}
