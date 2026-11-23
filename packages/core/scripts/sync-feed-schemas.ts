/**
 * Refreshes the JSON Schemas of Kiro Remote's change feed that draft checks its reader against
 * (packages/core/schemas/kiro-remote-feed). Run by hand when Kiro Remote's contract changes:
 *
 *     node scripts/sync-feed-schemas.ts [commit]
 *
 * Without a commit it pins the tip of `main`. It reads the files with `gh api`, so it works on a
 * private repository with the person's own sign-in, and writes the commit it pinned to PINNED.json,
 * which the contract test (test/kiro-feed-contract.test.ts) reads. Then run `pnpm format`: the
 * files are Kiro Remote's, formatted again by draft's own formatter.
 *
 * Why vendored and not fetched by the test: the test must pass offline and in a fork's CI, and a
 * change to the contract must show up as a diff in a pull request that someone reads.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "nikovirtala/kiro-remote";
const DIR = "packages/core/schemas/feed";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "schemas", "kiro-remote-feed");

const gh = (path: string, raw = false): string =>
  execFileSync("gh", ["api", path, ...(raw ? ["-H", "Accept: application/vnd.github.raw"] : [])], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

const ref = process.argv[2] ?? "main";
const commit = (JSON.parse(gh(`repos/${REPO}/commits/${ref}`)) as { sha: string }).sha;
const listing = JSON.parse(gh(`repos/${REPO}/contents/${DIR}?ref=${commit}`)) as {
  name: string;
  type: string;
}[];
const files = listing
  .filter((f) => f.type === "file" && f.name.endsWith(".json"))
  .map((f) => f.name);

mkdirSync(out, { recursive: true });
for (const name of files)
  writeFileSync(join(out, name), gh(`repos/${REPO}/contents/${DIR}/${name}?ref=${commit}`, true));
writeFileSync(
  join(out, "PINNED.json"),
  `${JSON.stringify({ repo: REPO, path: DIR, commit, files: files.sort() }, null, 2)}\n`,
);
console.log(`pinned ${REPO}@${commit}: ${files.length} schemas`);
