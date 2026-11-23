/**
 * A project's environments (docs/model.md, "Facts, kinds and standing"). Which environments a
 * project deploys to, and in what order, holds until a decision changes it: that is standing.
 * draft has no standing store yet, so the topology is read as data from where it lives and kept in
 * the one shape below, which a standing item can take over without the map changing:
 *
 * - **GitHub's environments** of the repository (`GET /repos/{repo}/environments`) name the
 *   environments. GitHub says nothing about their order, so each stands alone.
 * - **The deployment package's configuration** (`deploy.toml` at the repository root, where there
 *   is one) names the environment its pipeline deploys, `[project] environment`, which is
 *   `production` when the file leaves it out.
 * - **Order** is `after`: the environments one has to follow. Staging then production is
 *   production `after` staging; regions that deploy at the same time have no `after`. Where nothing
 *   says, an environment stands alone: nothing is inferred from the names, or from the order
 *   deployments happened to run in.
 */

export type EnvironmentSource = "github" | "deploy.toml";

export interface EnvironmentDecl {
  name: string;
  /** The environments this one follows: it is deployed to after they have been. */
  after: readonly string[];
  /** Where it was read from; a standing item would say which decision. */
  source: EnvironmentSource;
}

export interface EnvironmentTopology {
  repo: string;
  environments: readonly EnvironmentDecl[];
}

/** GitHub treats environment names as case-insensitive, so `Production` is `production`. */
export const environmentKey = (name: string): string => name.trim().toLowerCase();

export const sameEnvironment = (a: string, b: string): boolean =>
  environmentKey(a) === environmentKey(b);

/** The names in GitHub's answer to the environments of a repository; none when it isn't that. */
export function parseGithubEnvironments(body: unknown): string[] {
  const list = (body as { environments?: unknown } | null)?.environments;
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const e of list) {
    const name = (e as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.trim() !== "") names.push(name.trim());
  }
  return names;
}

/** What `deploy.toml` says about its environment: `[project] environment`, `production` if absent. */
export function parseDeployToml(text: string): string {
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      table = (header[1] as string).trim();
      continue;
    }
    if (table !== "project") continue;
    const m = /^environment\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    const value = (m?.[1] ?? m?.[2])?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return "production";
}

/**
 * The topology of a repository from what was read: GitHub's environment names and the text of its
 * `deploy.toml` (null when it has none). Each stands alone until a source says what it follows.
 * Null when neither names an environment.
 */
export function topologyOf(
  repo: string,
  read: { github: readonly string[]; deployToml: string | null },
): EnvironmentTopology | null {
  const seen = new Map<string, EnvironmentDecl>();
  for (const name of read.github)
    if (!seen.has(environmentKey(name)))
      seen.set(environmentKey(name), { name, after: [], source: "github" });
  if (read.deployToml !== null) {
    const name = parseDeployToml(read.deployToml);
    // The package's own name for it wins, as it is the one a deployment is recorded under.
    seen.set(environmentKey(name), { name, after: [], source: "deploy.toml" });
  }
  if (seen.size === 0) return null;
  return {
    repo,
    environments: [...seen.values()].sort((a, b) =>
      compare(environmentKey(a.name), environmentKey(b.name)),
    ),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The environments of a repository in the order they are deployed to, the ones in `seen` that the
 * topology doesn't name included: an environment comes after what it follows, and the rest keep
 * the order of their names. Spelled as the topology spells them, else as first seen. A topology
 * that loops (a follows b follows a) is ordered by name where it does.
 */
export function environmentOrder(
  topology: EnvironmentTopology | null,
  seen: readonly string[] = [],
): string[] {
  const names = new Map<string, string>();
  const after = new Map<string, Set<string>>();
  for (const e of topology?.environments ?? []) {
    names.set(environmentKey(e.name), e.name);
    after.set(environmentKey(e.name), new Set(e.after.map(environmentKey)));
  }
  for (const n of seen)
    if (!names.has(environmentKey(n))) {
      names.set(environmentKey(n), n.trim());
      after.set(environmentKey(n), new Set());
    }
  // What follows an environment the repository doesn't have is not waiting for it.
  for (const deps of after.values()) for (const d of [...deps]) if (!names.has(d)) deps.delete(d);
  const out: string[] = [];
  const done = new Set<string>();
  const left = [...names.keys()].sort(compare);
  while (left.length > 0) {
    const ready = left.find((k) => [...(after.get(k) as Set<string>)].every((d) => done.has(d)));
    const next = ready ?? (left[0] as string);
    left.splice(left.indexOf(next), 1);
    done.add(next);
    out.push(names.get(next) as string);
  }
  return out;
}

/** The spelling of an environment that a repository's deployments are kept under. */
export function canonicalEnvironment(topology: EnvironmentTopology | null, name: string): string {
  const named = topology?.environments.find((e) => sameEnvironment(e.name, name));
  return named?.name ?? name.trim();
}
