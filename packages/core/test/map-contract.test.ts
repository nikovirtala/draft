import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubClient } from "../src/github.ts";
import { foldMap, type KindRegistry } from "../src/map.ts";
import { ADR_STATES, ArkMap, ISSUE_STATES } from "../src/map-ark.ts";
import { mapRegistry } from "../src/map-kinds.ts";
import { FakeGithub } from "../src/testing/index.ts";

/**
 * The map's decision and issue counts against what the tools that own those logs report. This
 * repository's own docs/adr and docs/issues are served by a fake GitHub, read by the same code the
 * app reads GitHub with, folded through the map's kinds, and the counts of each state are compared
 * with `adr list --json` and `issues list --json` run on this checkout.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = "nikovirtala/draft";

type Files = Record<string, string>;
type Counts = Record<string, number>;

/** Every event file of the decision log and the issue log, by path from the repository root. */
function eventFiles(): Files {
  const files: Files = {};
  for (const log of ["docs/adr", "docs/issues"]) {
    const events = join(root, log, "events");
    for (const id of readdirSync(events))
      for (const name of readdirSync(join(events, id)))
        files[`${log}/events/${id}/${name}`] = readFileSync(join(events, id, name), "utf8");
  }
  return files;
}

/** The counts the map shows in each state of a kind, from the files as the app would read them. */
async function mapCounts(
  github: FakeGithub,
  files: Files,
): Promise<{ decision: Counts; issue: Counts }> {
  github.addFiles(REPO, "main", files);
  const registry: KindRegistry = mapRegistry.fork();
  const ark = new ArkMap(registry, {
    github: new GithubClient({ token: "t", baseUrl: github.baseUrl }),
    repos: () => [REPO],
    intervalMs: 0,
    maxBlobsPerRefresh: 1_000_000,
  });
  ark.setVisible("window", true);
  await ark.tick();
  const map = foldMap([], registry, { sources: ark.sources() });
  const of = (kind: string, states: readonly { id: string }[]): Counts => {
    const cells = map.rows.find((r) => r.kind === kind)?.cells ?? [];
    return Object.fromEntries(
      states.map((s) => [s.id, cells.find((c) => c.column === s.id)?.count ?? 0]),
    );
  };
  return { decision: of("decision", ADR_STATES), issue: of("issue", ISSUE_STATES) };
}

/** The counts per state in a tool's JSON: every state the map has, zero when the tool lists none. */
function toolCounts(
  items: readonly Record<string, unknown>[],
  field: string,
  states: readonly { id: string }[],
): Counts {
  const counts: Counts = Object.fromEntries(states.map((s) => [s.id, 0]));
  for (const item of items) {
    const state = String(item[field]);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

function run(tool: "adr" | "issues", args: string[]): Record<string, unknown> {
  const out = execFileSync(join(root, "node_modules/.bin", tool), [...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Record<string, unknown>;
}

function tools(): { decision: Counts; issue: Counts } {
  const decisions = run("adr", ["list"]).decisions as Record<string, unknown>[];
  const issues = run("issues", ["list", "--all"]).issues as Record<string, unknown>[];
  return {
    decision: toolCounts(decisions, "status", ADR_STATES),
    issue: toolCounts(issues, "state", ISSUE_STATES),
  };
}

/** Throws, naming each state whose count differs, when the map's counts are not the tools'. */
function assertSameCounts(
  map: { decision: Counts; issue: Counts },
  tool: { decision: Counts; issue: Counts },
): void {
  const differences: string[] = [];
  for (const kind of ["decision", "issue"] as const)
    for (const state of new Set([...Object.keys(map[kind]), ...Object.keys(tool[kind])])) {
      const [a, b] = [map[kind][state] ?? 0, tool[kind][state] ?? 0];
      if (a !== b) differences.push(`${kind} ${state}: the map shows ${a}, the tool reports ${b}`);
    }
  if (differences.length > 0)
    throw new Error(`the map's counts differ from the tools':\n${differences.join("\n")}`);
}

let github: FakeGithub;
beforeEach(async () => {
  github = await new FakeGithub().start();
});
afterEach(async () => {
  await github.stop();
});

describe("the map's counts against adr and issues", () => {
  it("shows as many decisions and issues in each state as the tools list", async () => {
    const reported = tools();
    // A log with nothing in it would pass trivially.
    expect(Object.values(reported.decision).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Object.values(reported.issue).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    assertSameCounts(await mapCounts(github, eventFiles()), reported);
  });

  it("fails when a fold miscounts a state: a decision whose accepting event is missing", async () => {
    const reported = tools();
    const files = eventFiles();
    const accepted = Object.keys(files).find(
      (p) => p.startsWith("docs/adr/") && /-accepted\./.test(p),
    );
    expect(accepted).toBeDefined();
    delete files[accepted as string];
    await expect(async () =>
      assertSameCounts(await mapCounts(github, files), reported),
    ).rejects.toThrow(/decision accepted: the map shows \d+, the tool reports \d+/);
  });

  it("fails when an issue is counted in the wrong state", async () => {
    const reported = tools();
    const files = eventFiles();
    const closed = Object.keys(files).find(
      (p) => p.startsWith("docs/issues/") && /-closed\./.test(p),
    );
    expect(closed).toBeDefined();
    delete files[closed as string];
    await expect(async () =>
      assertSameCounts(await mapCounts(github, files), reported),
    ).rejects.toThrow(/issue (closed|open|in-progress): the map shows/);
  });
});
