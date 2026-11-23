/**
 * Publishes a pull request's screenshots: the files of the named states go to the `ci/screenshots`
 * branch, which only CI writes, under `<pull request>/<head sha>/`, and one comment on the pull
 * request (found by its hidden marker, updated on each push) shows them beside the design. The
 * images in the comment are read at the commit CI made, not at the branch, so an old comment keeps
 * its images however many commits follow.
 *
 * Reads: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA and RUN_URL from the environment.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commentBody, MARKER } from "./screenshot-comment.ts";
import { loadStates, previewFile } from "./screenshot-states.ts";

const BRANCH = "ci/screenshots";
const artifacts = fileURLToPath(new URL("../e2e/artifacts/", import.meta.url));

const need = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};
const token = need("GH_TOKEN");
const repository = need("GITHUB_REPOSITORY");
const pull = need("PR_NUMBER");
const headSha = need("HEAD_SHA");
const runUrl = need("RUN_URL");

const states = loadStates();
const listing = (dir: string) => new Set(existsSync(dir) ? readdirSync(dir) : []);
const screenshots = listing(artifacts);
const previews = listing(join(artifacts, "previews"));

/** The files to publish: those of a named state that exist. */
const files: { from: string; name: string }[] = [];
for (const s of states) {
  if (screenshots.has(s.screenshot))
    files.push({ from: join(artifacts, s.screenshot), name: s.screenshot });
  if (s.preview !== null && previews.has(previewFile(s)))
    files.push({ from: join(artifacts, "previews", previewFile(s)), name: previewFile(s) });
}

const imagesDir = `${pull}/${headSha}`;

function git(cwd: string, ...args: string[]): string {
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  return execFileSync(
    "git",
    ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
}

/** Commits the files to ci/screenshots and returns the commit, retrying when another push won. */
function push(): string {
  for (let attempt = 1; ; attempt++) {
    // A fresh clone each time: another pull request's job may have pushed since the last.
    const work = mkdtempSync(join(tmpdir(), "ci-screenshots-"));
    git(work, "init", "--quiet", "--initial-branch", BRANCH);
    git(work, "remote", "add", "origin", `https://github.com/${repository}.git`);
    const exists = git(work, "ls-remote", "--heads", "origin", BRANCH) !== "";
    if (exists) {
      git(work, "fetch", "--quiet", "--depth", "1", "origin", BRANCH);
      git(work, "reset", "--quiet", "--hard", "FETCH_HEAD");
    }
    mkdirSync(join(work, imagesDir), { recursive: true });
    for (const f of files) copyFileSync(f.from, join(work, imagesDir, f.name));
    git(work, "add", "--all", imagesDir);
    git(
      work,
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      `ci: screenshots of ${repository}#${pull} at ${headSha.slice(0, 7)}`,
    );
    try {
      git(work, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
      return git(work, "rev-parse", "HEAD");
    } catch (error) {
      if (attempt >= 5) throw error;
      // Another pull request's job pushed first: start again from its tip.
    }
  }
}

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    env: { ...process.env, GH_TOKEN: token },
    stdio: ["pipe", "pipe", "inherit"],
  });
}

const imagesCommit = push();
console.log(`${files.length} files pushed to ${BRANCH} at ${imagesCommit}`);

const body = commentBody({
  states,
  repository,
  imagesCommit,
  imagesDir,
  headSha,
  screenshots,
  previews,
  runUrl,
});

const comments = JSON.parse(
  gh(["api", "--paginate", "--slurp", `repos/${repository}/issues/${pull}/comments?per_page=100`]),
) as { id: number; body: string }[][];
const existing = comments.flat().find((c) => c.body.startsWith(MARKER));
const payload = JSON.stringify({ body });
if (existing === undefined) {
  gh(["api", "-X", "POST", `repos/${repository}/issues/${pull}/comments`, "--input", "-"], payload);
  console.log("comment posted");
} else {
  gh(
    ["api", "-X", "PATCH", `repos/${repository}/issues/comments/${existing.id}`, "--input", "-"],
    payload,
  );
  console.log(`comment ${existing.id} updated`);
}
