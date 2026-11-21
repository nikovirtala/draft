import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What an acceptance needs on disk, for tests and the end-to-end run: a test identity with an SSH
 * signing key and a global git config that names them (the person's), a bare git repository that
 * stands for the remote, with `main` and a branch that proposes an ADR, and the environment to
 * run the person's tools in. No real key or account is involved.
 *
 * The person's config has signing OFF: draft has to turn it on for the commit it makes.
 */

export interface AcceptanceFixture {
  /** `owner/repo`, as GitHub names it. */
  repo: string;
  /** The bare repository: the remote. */
  bare: string;
  /** The test person: their git identity and key. */
  identity: { name: string; email: string };
  key: { private: string; public: string; allowedSigners: string };
  /** The environment the person's tools run in: their global git config, nothing else of ours. */
  env: NodeJS.ProcessEnv;
  /** The proposed ADR and the branch that carries it. */
  adr: { id: string; title: string; branch: string };
  /** The tip of a branch of the remote. */
  tip(branch: string): string;
  /** `git log --show-signature` on the remote, for evidence. */
  log(ref: string, n?: number): string;
  /** Adds a commit to a branch of the remote as someone else (the agent pushing a fix). */
  push(branch: string, file: string, text: string, message: string): string;
}

const run = (cwd: string, file: string, args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(file, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface FixtureOptions {
  /** Where to make it; a temporary directory by default. */
  dir?: string;
  repo?: string;
  /** The adr program: a command to run. */
  adr: string;
  title?: string;
  branch?: string;
}

export function createAcceptanceFixture(o: FixtureOptions): AcceptanceFixture {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "draft-accept-"));
  mkdirSync(dir, { recursive: true });
  const repo = o.repo ?? "nikovirtala/draft";
  const identity = { name: "Niko Test", email: "niko.test@example.com" };
  const key = {
    private: join(dir, "person_ed25519"),
    public: join(dir, "person_ed25519.pub"),
    allowedSigners: join(dir, "allowed_signers"),
  };
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  run(
    dir,
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", identity.email, "-f", key.private],
    base,
  );
  const pub = run(dir, "cat", [key.public], base).trim();
  writeFileSync(key.allowedSigners, `${identity.email} ${pub}\n`);
  const config = join(dir, "gitconfig");
  writeFileSync(
    config,
    [
      "[user]",
      `\tname = ${identity.name}`,
      `\temail = ${identity.email}`,
      `\tsigningkey = ${key.private}`,
      "[gpg]",
      "\tformat = ssh",
      '[gpg "ssh"]',
      `\tallowedSignersFile = ${key.allowedSigners}`,
      "[commit]",
      "\tgpgsign = false",
      "[init]",
      "\tdefaultBranch = main",
      '[protocol "file"]',
      "\tallow = always",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_GLOBAL: config };
  // Everyone else (the agent that proposed, the seed) commits with their own identity, unsigned.
  const other = (name: string, email: string): NodeJS.ProcessEnv => ({
    ...base,
    GIT_CONFIG_GLOBAL: join(dir, "empty-gitconfig"),
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  });
  writeFileSync(join(dir, "empty-gitconfig"), "[init]\n\tdefaultBranch = main\n");
  const agent: NodeJS.ProcessEnv = {
    ...other("Kiro Agent", "kiro-agent@example.com"),
    ARK_AGENT: "kiro",
    ARK_ON_BEHALF_OF: identity.email,
  };

  const bare = join(dir, "remote.git");
  const seed = join(dir, "seed");
  run(dir, "git", ["init", "-q", "--bare", "-b", "main", bare], base);
  mkdirSync(seed);
  const seedEnv = other("Seed Author", "seed@example.com");
  run(seed, "git", ["init", "-q", "-b", "main"], seedEnv);
  run(seed, "git", ["remote", "add", "origin", bare], seedEnv);
  run(seed, o.adr, ["init", "--json"], seedEnv);
  writeFileSync(join(seed, "README.md"), "# draft\n");
  run(seed, "git", ["add", "-A"], seedEnv);
  run(seed, "git", ["commit", "-q", "-m", "chore: start the repository"], seedEnv);
  run(seed, "git", ["push", "-q", "origin", "main"], seedEnv);

  const branch = o.branch ?? "adr/acceptance-as-yourself";
  const title = o.title ?? "Accept only as the person";
  run(seed, "git", ["checkout", "-q", "-b", branch], seedEnv);
  const made = JSON.parse(
    run(
      seed,
      o.adr,
      [
        "new",
        title,
        "--no-edit",
        "--commit",
        "--json",
        "--section",
        "context=Accepting is a person's act.",
        "--section",
        "decision=Only a person accepts, with their own identity and key.",
        "--section",
        "scope=packages/core/src/acceptance.ts",
        "--section",
        "consequences=An agent can only propose.",
      ],
      agent,
    ),
  ) as { decision: { id: string } };
  run(seed, "git", ["push", "-q", "origin", branch], seedEnv);

  return {
    repo,
    bare,
    identity,
    key,
    env,
    adr: { id: made.decision.id, title, branch },
    tip: (b) => run(bare, "git", ["rev-parse", `refs/heads/${b}`], base).trim(),
    log: (ref, n = 3) =>
      run(bare, "git", ["log", `-${n}`, "--show-signature", "--format=fuller", ref], env),
    push(b, file, text, message) {
      run(seed, "git", ["checkout", "-q", b], seedEnv);
      writeFileSync(join(seed, file), text);
      run(seed, "git", ["add", "-A"], seedEnv);
      run(seed, "git", ["commit", "-q", "-m", message], seedEnv);
      run(seed, "git", ["push", "-q", "origin", b], seedEnv);
      return run(seed, "git", ["rev-parse", "HEAD"], seedEnv).trim();
    },
  };
}
