import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArkSnapshot, DeploymentRecord } from "../src/ark-records.ts";
import {
  canonicalEnvironment,
  type EnvironmentTopology,
  environmentOrder,
  parseDeployToml,
  parseGithubEnvironments,
  sameEnvironment,
  topologyOf,
} from "../src/environments.ts";
import { GithubClient } from "../src/github.ts";
import { foldMap, KindRegistry, type MapSnapshot } from "../src/map.ts";
import {
  ARK_SOURCE,
  ArkMap,
  deploymentKind,
  deploymentKindId,
  supersessions,
} from "../src/map-ark.ts";
import { projectGraph } from "../src/map-graph.ts";
import { mapRegistry } from "../src/map-kinds.ts";
import { layoutGraph } from "../src/map-layout.ts";
import { FakeGithub, GITHUB_ENVIRONMENTS_RESPONSE } from "../src/testing/index.ts";

const REPO = "nikovirtala/kiro-remote";
const T = (m: number) => new Date(Date.UTC(2026, 10, 22, 16, m)).toISOString();

/** A run of an environment, created at minute `at`, that ended in `end` two minutes later. */
function run(id: number, environment: string, at: number, end: string): DeploymentRecord {
  return {
    repo: REPO,
    id,
    environment,
    sha: String(id % 10).repeat(40),
    ref: "main",
    createdAt: T(at),
    commitUrl: `https://github.com/${REPO}/commit/${String(id % 10).repeat(40)}`,
    statuses: [
      { state: "queued", at: T(at), logUrl: null, environmentUrl: null },
      { state: "in_progress", at: T(at + 1), logUrl: null, environmentUrl: null },
      { state: end, at: T(at + 2), logUrl: null, environmentUrl: null },
    ],
  };
}

const alone = (name: string) => ({ name, after: [], source: "github" as const });

/** Staging, then production. */
const SEQUENCE: EnvironmentTopology = {
  repo: REPO,
  environments: [alone("staging"), { ...alone("production"), after: ["staging"] }],
};
/** Two regions, deployed at the same time. */
const PARALLEL: EnvironmentTopology = {
  repo: REPO,
  environments: [alone("production-eu"), alone("production-us")],
};

/** The map of a snapshot of records, with a row for each environment of the topology's order. */
function mapOf(
  deployments: DeploymentRecord[],
  environments: EnvironmentTopology[] = [],
): MapSnapshot {
  const registry = mapRegistry.fork();
  const seen = [...new Set(deployments.map((d) => d.environment))];
  const topology = environments.find((t) => t.repo === REPO) ?? null;
  const order = environmentOrder(topology, seen);
  for (const [index, e] of order.entries())
    registry.register(deploymentKind(REPO, e, { group: REPO, index, of: order.length }));
  const snapshot: ArkSnapshot = {
    version: 1,
    loading: false,
    repos: [REPO],
    readAt: null,
    adrs: [],
    issues: [],
    deployments,
    environments,
    problems: [],
  };
  return foldMap([], registry, { context: "local", sources: { [ARK_SOURCE]: snapshot } });
}

const kind = (environment: string) => deploymentKindId(REPO, environment);
const row = (m: MapSnapshot, environment: string) =>
  m.rows.find((r) => r.kind === kind(environment));
const counts = (m: MapSnapshot, environment: string) =>
  Object.fromEntries(
    (row(m, environment)?.cells ?? []).filter((c) => c.count > 0).map((c) => [c.column, c.count]),
  );
const waiting = (m: MapSnapshot, environment: string) =>
  Object.fromEntries(
    (row(m, environment)?.cells ?? [])
      .filter((c) => c.waitingOnPerson > 0)
      .map((c) => [c.column, c.waitingOnPerson]),
  );
const supersedes = (m: MapSnapshot) =>
  m.edges
    .filter((e) => e.rel === "supersedes")
    .map(
      (e) =>
        `${e.from.kind.split(":").pop()}#${e.from.id} -> ${e.to.kind.split(":").pop()}#${e.to.id}`,
    );

describe("supersession is an edge", () => {
  it("with one environment: a later success supersedes the failure, and the state reads the edge", () => {
    const deployments = [run(1, "production", 39, "failure"), run(2, "production", 48, "success")];
    const fixes = supersessions(deployments);
    expect(fixes.map((f) => [f.fixing.id, f.failed.id, f.at])).toEqual([[2, 1, T(50)]]);
    const m = mapOf(deployments);
    expect(supersedes(m)).toEqual(["production#2 -> production#1"]);
    expect(m.edges.find((e) => e.rel === "supersedes")?.at).toBe(T(50));
    expect(counts(m, "production")).toEqual({ recovered: 1, success: 1 });
    expect(waiting(m, "production")).toEqual({});
  });

  it("with no later success there is no edge, and the failure that is newest waits", () => {
    const m = mapOf([run(1, "production", 30, "success"), run(2, "production", 39, "failure")]);
    expect(supersedes(m)).toEqual([]);
    expect(waiting(m, "production")).toEqual({ failure: 1 });
  });

  it("is declared by the failure's own run only when that run is the one that succeeded first", () => {
    // Two failures, then a success: the one success supersedes both. A second success later does not.
    const m = mapOf([
      run(1, "production", 30, "failure"),
      run(2, "production", 39, "error"),
      run(3, "production", 48, "success"),
      run(4, "production", 57, "success"),
    ]);
    expect(supersedes(m)).toEqual(["production#3 -> production#1", "production#3 -> production#2"]);
    expect(counts(m, "production")).toEqual({ recovered: 2, success: 2 });
  });

  it("in sequence: a failure in production is settled by production, not by staging", () => {
    const deployments = [
      run(1, "staging", 10, "success"),
      run(2, "production", 20, "failure"),
      run(3, "staging", 30, "success"),
      run(4, "production", 40, "success"),
    ];
    const m = mapOf(deployments, [SEQUENCE]);
    // Staging's later success (3) came before production's fix (4) and is not the fix.
    expect(supersedes(m)).toEqual(["production#4 -> production#2"]);
    expect(counts(m, "production")).toEqual({ recovered: 1, success: 1 });
    // The same runs, with production still failed: staging's success settles nothing.
    const open = mapOf(deployments.slice(0, 3), [SEQUENCE]);
    expect(supersedes(open)).toEqual([]);
    expect(waiting(open, "production")).toEqual({ failure: 1 });
    expect(counts(open, "staging")).toEqual({ success: 2 });
  });

  it("in sequence: a failure in staging is settled by staging, and production's success after it is no fix", () => {
    const m = mapOf(
      [run(1, "staging", 10, "failure"), run(2, "production", 20, "success")],
      [SEQUENCE],
    );
    expect(supersedes(m)).toEqual([]);
    expect(waiting(m, "staging")).toEqual({ failure: 1 });
    const fixed = mapOf(
      [
        run(1, "staging", 10, "failure"),
        run(2, "production", 20, "success"),
        run(3, "staging", 30, "success"),
      ],
      [SEQUENCE],
    );
    expect(supersedes(fixed)).toEqual(["staging#3 -> staging#1"]);
  });

  it("in parallel: each region's failure is settled only by a success in that region", () => {
    const deployments = [
      run(1, "production-eu", 10, "failure"),
      run(2, "production-us", 11, "failure"),
      run(3, "production-us", 20, "success"),
    ];
    const m = mapOf(deployments, [PARALLEL]);
    expect(supersedes(m)).toEqual(["production-us#3 -> production-us#2"]);
    expect(waiting(m, "production-eu")).toEqual({ failure: 1 });
    expect(waiting(m, "production-us")).toEqual({});
    expect(m.totals.waitingOnPerson).toBe(1);
    // Then the eu run is fixed too, by its own region's success, and nothing waits.
    const both = mapOf([...deployments, run(4, "production-eu", 30, "success")], [PARALLEL]);
    expect(supersedes(both)).toEqual([
      "production-eu#4 -> production-eu#1",
      "production-us#3 -> production-us#2",
    ]);
    expect(both.totals.waitingOnPerson).toBe(0);
  });

  it("a later run that did not succeed replaces a failure with no edge", () => {
    const m = mapOf([run(1, "production", 30, "failure"), run(2, "production", 39, "error")]);
    expect(supersedes(m)).toEqual([]);
    expect(counts(m, "production")).toEqual({ replaced: 1, error: 1 });
    expect(waiting(m, "production")).toEqual({ error: 1 });
  });

  it("matches an environment as GitHub does, whatever its case, and as the topology spells it", () => {
    expect(sameEnvironment("Production", "production ")).toBe(true);
    expect(canonicalEnvironment(SEQUENCE, "PRODUCTION")).toBe("production");
    expect(canonicalEnvironment(null, " Prod ")).toBe("Prod");
    const fixes = supersessions(
      [run(1, "Production", 10, "failure"), run(2, "production", 20, "success")],
      SEQUENCE,
    );
    expect(fixes.map((f) => [f.fixing.id, f.failed.id])).toEqual([[2, 1]]);
    // Never across repositories.
    const other = { ...run(2, "production", 20, "success"), repo: "nikovirtala/other" };
    expect(supersessions([run(1, "production", 10, "failure"), other])).toEqual([]);
  });

  it("is in the graph's projection like any other edge, and the cluster says where it comes in its order", () => {
    const m = mapOf(
      [
        run(1, "staging", 10, "success"),
        run(2, "production", 20, "failure"),
        run(3, "production", 30, "success"),
      ],
      [SEQUENCE],
    );
    const inKind = projectGraph(m, { level: "kind", kind: kind("production") });
    const edge = inKind.edges.find((e) => e.rels.some((r) => r.rel === "supersedes"));
    expect(edge).toMatchObject({
      from: `item:${kind("production")}:3`,
      to: `item:${kind("production")}:2`,
      count: 1,
      rels: [{ rel: "supersedes", count: 1 }],
    });
    // At the context the two runs moved, so they step out of their cluster, and the edge is drawn
    // between them, a cascade like any other between items that moved.
    const context = projectGraph(m);
    expect(context.edges.filter((e) => e.rels.some((r) => r.rel === "supersedes"))).toMatchObject([
      { from: `item:${kind("production")}:3`, to: `item:${kind("production")}:2`, cascade: true },
    ]);
    const production = context.nodes.find((n) => n.id === `cluster:${kind("production")}`);
    expect(production).toMatchObject({ type: "cluster", order: { index: 1, of: 2 } });
    // A supersession is a weak reference: it is no open loop for the one it fixed.
    expect(context.totals.openLoops).toBe(0);
  });
});

describe("a project's environments are drawn in their order", () => {
  it("puts an environment after what it follows, and the rest by name", () => {
    expect(environmentOrder(SEQUENCE)).toEqual(["staging", "production"]);
    expect(environmentOrder(PARALLEL)).toEqual(["production-eu", "production-us"]);
    // Whatever order they are named in.
    expect(
      environmentOrder({ repo: REPO, environments: [...SEQUENCE.environments].reverse() }),
    ).toEqual(["staging", "production"]);
    // Where nothing says, each stands alone: by name, with the ones only deployments name after.
    expect(environmentOrder(null, ["staging", "production"])).toEqual(["production", "staging"]);
    expect(environmentOrder(SEQUENCE, ["canary"])).toEqual(["canary", "staging", "production"]);
    // A loop is ordered by name where it loops; a follow of nothing is not waited on.
    expect(
      environmentOrder({
        repo: REPO,
        environments: [
          { ...alone("a"), after: ["b"] },
          { ...alone("b"), after: ["a"] },
          { ...alone("c"), after: ["gone"] },
        ],
      }),
    ).toEqual(["c", "a", "b"]);
  });

  it("makes the rows follow the topology, and the clusters lie along a line in that order", () => {
    const m = mapOf(
      [run(1, "production", 20, "success"), run(2, "staging", 10, "success")],
      [SEQUENCE],
    );
    expect(m.rows.filter((r) => r.order !== null).map((r) => [r.kind, r.order])).toEqual([
      [kind("staging"), { group: REPO, index: 0, of: 2 }],
      [kind("production"), { group: REPO, index: 1, of: 2 }],
    ]);
    const graph = projectGraph(m);
    const at = layoutGraph(graph);
    const staging = at[`cluster:${kind("staging")}`];
    const production = at[`cluster:${kind("production")}`];
    expect(staging && production && staging.x < production.x).toBe(true);
    expect(staging?.y).toBeCloseTo(production?.y ?? 0, 0);
  });

  it("keeps the nodes where they were when an environment is added", () => {
    const before = mapOf([run(1, "production", 20, "success")], [SEQUENCE]);
    const first = layoutGraph(projectGraph(before));
    const after = mapOf(
      [run(1, "production", 20, "success"), run(2, "staging", 10, "success")],
      [SEQUENCE],
    );
    const next = layoutGraph(projectGraph(after), first);
    const id = `cluster:${kind("production")}`;
    expect(
      Math.hypot(
        (next[id]?.x ?? 0) - (first[id]?.x ?? 0),
        (next[id]?.y ?? 0) - (first[id]?.y ?? 0),
      ),
    ).toBeLessThanOrEqual(12);
  });
});

describe("the topology is read as data", () => {
  it("takes the environments' names from GitHub's response, each standing alone", () => {
    expect(parseGithubEnvironments(GITHUB_ENVIRONMENTS_RESPONSE)).toEqual([
      "staging",
      "production",
      "production-eu",
      "production-us",
    ]);
    const t = topologyOf(REPO, {
      github: parseGithubEnvironments(GITHUB_ENVIRONMENTS_RESPONSE),
      deployToml: null,
    });
    expect(t).toEqual({
      repo: REPO,
      environments: [
        { name: "production", after: [], source: "github" },
        { name: "production-eu", after: [], source: "github" },
        { name: "production-us", after: [], source: "github" },
        { name: "staging", after: [], source: "github" },
      ],
    });
    expect(parseGithubEnvironments(null)).toEqual([]);
    expect(
      parseGithubEnvironments({ environments: [{ id: 1 }, { name: " " }, { name: "x" }] }),
    ).toEqual(["x"]);
  });

  it("reads the environment deploy.toml names, production when it names none", () => {
    expect(
      parseDeployToml('[project]\nname = "kiro-remote"\nenvironment = "staging" # for now\n'),
    ).toBe("staging");
    expect(parseDeployToml("[project]\nenvironment = 'eu-prod'\n")).toBe("eu-prod");
    expect(parseDeployToml('[project]\nname = "x"\n')).toBe("production");
    // Another table's environment is not the project's.
    expect(parseDeployToml('[smoke]\nenvironment = "no"\n[project]\nregion = "eu-north-1"\n')).toBe(
      "production",
    );
    expect(parseDeployToml("")).toBe("production");
  });

  it("joins what GitHub and deploy.toml say, the package's spelling winning", () => {
    const t = topologyOf(REPO, {
      github: ["Production", "staging"],
      deployToml: '[project]\nenvironment = "production"\n',
    });
    expect(t?.environments).toEqual([
      { name: "production", after: [], source: "deploy.toml" },
      { name: "staging", after: [], source: "github" },
    ]);
    expect(topologyOf(REPO, { github: [], deployToml: null })).toBeNull();
  });
});

describe("the topology of a repository, read from GitHub", () => {
  let github: FakeGithub;
  beforeEach(async () => {
    github = await new FakeGithub().start();
  });
  afterEach(async () => {
    await github.stop();
  });

  function open() {
    const client = new GithubClient({ token: "t", baseUrl: github.baseUrl });
    const registry = new KindRegistry();
    const ark = new ArkMap(registry, { github: client, repos: () => [REPO], intervalMs: 0 });
    ark.setVisible("window", true);
    return { ark, registry };
  }

  it("reads GitHub's environments and the repository's deploy.toml into the snapshot, and draws the rows in their order", async () => {
    github.environments.set(REPO, GITHUB_ENVIRONMENTS_RESPONSE);
    github.addFiles(REPO, "main", {
      "deploy.toml": '[project]\nname = "kiro-remote"\nenvironment = "production"\n',
    });
    for (const [id, env, at] of [
      [1, "staging", 10],
      [2, "production-us", 20],
      [3, "production", 30],
    ] as const)
      github.addDeployment(REPO, {
        id,
        sha: String(id).repeat(40),
        ref: "main",
        environment: env,
        createdAt: T(at),
        statuses: [{ state: "success", at: T(at + 1) }],
      });
    const { ark, registry } = open();
    await ark.tick();
    const snapshot = ark.records.snapshot();
    expect(snapshot.environments).toEqual([
      {
        repo: REPO,
        environments: [
          { name: "production", after: [], source: "deploy.toml" },
          { name: "production-eu", after: [], source: "github" },
          { name: "production-us", after: [], source: "github" },
          { name: "staging", after: [], source: "github" },
        ],
      },
    ]);
    // Rows for the environments that have a deployment, in the topology's order.
    const m = foldMap([], registry, { sources: ark.sources() });
    expect(
      m.rows.filter((r) => r.order !== null).map((r) => [r.kind, r.order?.index, r.order?.of]),
    ).toEqual([
      [kind("production"), 0, 3],
      [kind("production-us"), 1, 3],
      [kind("staging"), 2, 3],
    ]);
  });

  it("has no topology when nobody names one, and the rows are the deployments' own environments", async () => {
    github.addFiles(REPO, "main", {});
    github.addDeployment(REPO, {
      id: 1,
      sha: "1".repeat(40),
      ref: "main",
      environment: "production",
      createdAt: T(1),
      statuses: [{ state: "success", at: T(2) }],
    });
    const { ark, registry } = open();
    await ark.tick();
    expect(ark.records.snapshot().environments).toEqual([]);
    expect(ark.records.snapshot().problems).toEqual([]);
    expect(registry.list().some((k) => k.id === kind("production"))).toBe(true);
  });
});
