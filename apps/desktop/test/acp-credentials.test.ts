import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DraftEvent, knownEvents } from "@nikovirtala/draft-core";
import { describe, expect, it } from "vitest";
import { NO_GITHUB_TOKEN } from "../src/main/acp/environment.ts";
import { type Opened, openAcp, recorded } from "./acp-helpers.ts";

/**
 * The agent's process, as the person's sign-ins look from inside it. The person's environment
 * carries seeded credentials for gh, git, SSH, AWS and npm. A fake agent runs the commands an
 * agent's shell would (`probe` in its script) and reports what they print; the same commands run
 * here, in the person's environment, show what draft's own process still sees. The seeds are
 * fake: nothing here reaches a real service.
 */

const SEED = {
  gh: "ghp_seededGithubTokenForTheTest0000000000",
  awsKey: "AKIASEEDEDFORTHETEST",
  awsSecret: "seeded/secret/for/the/test/0000000000000000",
  npm: "npm_seededNpmTokenForTheTest00000000000000",
  nodeAuth: "node-auth-seeded-for-the-test",
  sock: "/tmp/draft-test-seeded-ssh-agent.sock",
  helper: "person-credential-helper",
  email: "the.person@example.com",
};

const has = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const TOOLS = { git: has("git"), gh: has("gh"), aws: has("aws"), npm: has("npm"), ssh: has("ssh") };

function personEnvironment(dir: string): NodeJS.ProcessEnv {
  // The real HOME: a shim of the test machine's own tools may need it. Nothing below reads
  // credentials from it: each tool is pointed at a seeded file or a variable.
  const home = process.env.HOME ?? dir;
  const gitconfig = join(dir, "person-gitconfig");
  writeFileSync(
    gitconfig,
    `[user]\n\temail = ${SEED.email}\n[credential]\n\thelper = ${SEED.helper}\n`,
  );
  const npmrc = join(dir, "person-npmrc");
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${SEED.npm}\n`);
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    LANG: "en_US.UTF-8",
    TERM: "xterm",
    TMPDIR: tmpdir(),
    // The person's sign-ins, seeded.
    GH_TOKEN: SEED.gh,
    GITHUB_TOKEN: SEED.gh,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    SSH_AUTH_SOCK: SEED.sock,
    AWS_ACCESS_KEY_ID: SEED.awsKey,
    AWS_SECRET_ACCESS_KEY: SEED.awsSecret,
    AWS_REGION: "eu-west-1",
    AWS_EC2_METADATA_DISABLED: "true",
    NPM_CONFIG_USERCONFIG: npmrc,
    NODE_AUTH_TOKEN: SEED.nodeAuth,
    // draft's own settings.
    DRAFT_ACP_TRANSCRIPT: "/tmp/never-for-an-agent",
  };
}

/** What each probe runs: the same list for the agent and for the person's own process. */
const PROBES: { name: string; command: string[]; tool: keyof typeof TOOLS; input?: string }[] = [
  {
    // What git does for an HTTPS remote: asks its helpers, the repository's own included.
    name: "gitCredentialFill",
    command: ["git", "credential", "fill"],
    input: "protocol=https\nhost=example.com\n\n",
    tool: "git",
  },
  { name: "gitHelper", command: ["git", "config", "--get-all", "credential.helper"], tool: "git" },
  { name: "gitEmail", command: ["git", "config", "--get", "user.email"], tool: "git" },
  { name: "ghToken", command: ["gh", "auth", "token", "--hostname", "github.com"], tool: "gh" },
  { name: "ghStatus", command: ["gh", "auth", "status", "--hostname", "github.com"], tool: "gh" },
  { name: "awsList", command: ["aws", "configure", "list"], tool: "aws" },
  { name: "npmUserConfig", command: ["npm", "config", "get", "userconfig"], tool: "npm" },
  { name: "sshConfig", command: ["ssh", "-G", "github.com"], tool: "ssh" },
];
const probes = PROBES.filter((p) => TOOLS[p.tool]);

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The probes in the person's own process, as draft's main process would run them. */
function asPerson(env: NodeJS.ProcessEnv, cwd: string): Record<string, Result> {
  const out: Record<string, Result> = {};
  for (const p of probes) {
    const [cmd = "", ...args] = p.command;
    const r = spawnSync(cmd, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
      ...(p.input === undefined ? {} : { input: p.input }),
    });
    out[p.name] = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  return out;
}

async function inAgent(person: NodeJS.ProcessEnv, dir: string) {
  const o: Opened = await openAcp(
    {
      probe: probes.map(({ name, command, input }) => ({
        name,
        command,
        ...(input === undefined ? {} : { input }),
      })),
      turns: [],
    },
    { dir, env: person },
  );
  try {
    await o.service.submit("hello");
    const log = recorded(o.logPath);
    const results: Record<string, Result> = {};
    for (const e of log.filter((l) => l.event === "probe"))
      results[e.name] = { status: e.status, stdout: e.stdout, stderr: e.stderr };
    const env = log.find((l) => l.event === "environment")?.env as Record<string, string>;
    const started = knownEvents(o.log.events()).find(
      (e) => e.type === "agent.session_started",
    ) as DraftEvent<"agent.session_started">;
    const state = o.service.state();
    const rawLog = readFileSync(join(dir, "log.jsonl"), "utf8");
    return { results, env, started, state, rawLog, files: o.dir };
  } finally {
    await o.close();
  }
}

describe("an agent draft starts can't act as the person through its own shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-creds-"));
  const person = personEnvironment(dir);
  const cwd = join(dir, "agent-workspace");
  mkdirSync(cwd, { recursive: true });
  // A project folder whose own git config names a credential helper, as a repository can.
  const helper = join(dir, "repo-helper.sh");
  const called = join(dir, "repo-helper-called");
  writeFileSync(
    helper,
    `#!/bin/sh\necho called >> '${called}'\necho username=u\necho password=p\n`,
    {
      mode: 0o755,
    },
  );
  if (TOOLS.git) {
    spawnSync("git", ["init", "-q", cwd], { env: person });
    spawnSync("git", ["config", "credential.helper", helper], { cwd, env: person });
  }
  const outer = asPerson(person, cwd);
  const outerAskedRepoHelper = existsSync(called);
  rmSync(called, { force: true });
  const run = inAgent(person, dir);
  run.catch(() => {});

  it("sees the seeded sign-ins in the person's own process (so the checks below can fail)", () => {
    if (TOOLS.git) {
      expect(outer.gitCredentialFill?.stdout).toContain("password=p");
      expect(outerAskedRepoHelper).toBe(true);
      expect(outer.gitHelper?.stdout.trim()).toContain(SEED.helper);
      expect(outer.gitEmail?.stdout.trim()).toBe(SEED.email);
    }
    if (TOOLS.gh) expect(outer.ghToken?.stdout.trim()).toBe(SEED.gh);
    if (TOOLS.aws) {
      expect(outer.awsList?.status).toBe(0);
      expect(outer.awsList?.stdout).toContain("access_key");
      expect(outer.awsList?.stdout).toMatch(/access_key\s*:\s*\*+\w+\s*:\s*env/);
    }
    if (TOOLS.npm) expect(outer.npmUserConfig?.stdout.trim()).toBe(join(dir, "person-npmrc"));
    if (TOOLS.ssh) expect(outer.sshConfig?.stdout).toMatch(/^pubkeyauthentication true$/m);
  });

  it.skipIf(!TOOLS.git)(
    "git finds no credential helper and not the person's identity",
    async () => {
      const { results } = await run;
      // `credential.helper=` reset by draft: an empty value, never the person's helper.
      expect(results.gitHelper?.stdout).not.toContain(SEED.helper);
      // Not even the repository's own helper is asked: git has nothing to answer a prompt with.
      expect(results.gitCredentialFill?.status).not.toBe(0);
      expect(results.gitCredentialFill?.stdout).not.toContain("password=");
      expect(existsSync(called)).toBe(false);
      expect(results.gitEmail?.stdout.trim()).toBe("agent@draft.invalid");
    },
  );

  it.skipIf(!TOOLS.gh)("gh is not logged in as the person", async () => {
    const { results } = await run;
    expect(results.ghToken?.stdout.trim()).toBe(NO_GITHUB_TOKEN);
    expect(results.ghToken?.stdout).not.toContain(SEED.gh);
    expect(results.ghStatus?.status).not.toBe(0);
    const status = `${results.ghStatus?.stdout ?? ""}${results.ghStatus?.stderr ?? ""}`;
    expect(status).not.toContain("Logged in to");
    expect(status).toContain("GH_TOKEN is invalid");
  });

  it.skipIf(!TOOLS.aws)("aws finds no credentials and no profile", async () => {
    const { results } = await run;
    expect(results.awsList?.stdout).not.toContain(SEED.awsKey.slice(-4));
    expect(results.awsList?.stdout).toMatch(/access_key\s*:\s*<not set>/);
    expect(results.awsList?.stdout).toMatch(/secret_key\s*:\s*<not set>/);
    expect(results.awsList?.stdout).toMatch(/profile\s*:\s*<not set>/);
  });

  it.skipIf(!TOOLS.npm)("npm doesn't read the person's token", async () => {
    const { results } = await run;
    // The user config npm reads is draft's empty file, not the person's with the token in it.
    const used = results.npmUserConfig?.stdout.trim() ?? "";
    expect(used).toBe(join(dir, "agent-env", "npmrc"));
    expect(readFileSync(used, "utf8")).not.toContain("_authToken");
  });

  it.skipIf(!TOOLS.ssh)("ssh offers no key, agent or configuration", async () => {
    const { results } = await run;
    expect(results.sshConfig?.stdout).toMatch(/^pubkeyauthentication false$/m);
    expect(results.sshConfig?.stdout).toMatch(/^identitiesonly yes$/m);
    expect(results.sshConfig?.stdout).toMatch(/^identityagent none$/m);
  });

  it("the agent's environment carries no seeded value, no draft variable, and what it needs", async () => {
    const { env } = await run;
    const text = JSON.stringify(env);
    for (const v of Object.values(SEED)) {
      if (v === SEED.email || v === SEED.helper) continue;
      expect(text, v).not.toContain(v);
    }
    expect(env.DRAFT_ACP_TRANSCRIPT).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe(person.HOME);
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm");
    expect(env.AWS_REGION).toBe("eu-west-1");
    expect(env.PATH).toContain(person.PATH);
  });

  it("the session's start event and the status say what was withheld, by name only", async () => {
    const { started, state, rawLog } = await run;
    const names = started.data.environment?.withheld.map((w) => w.name) ?? [];
    for (const n of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "NODE_AUTH_TOKEN",
      "DRAFT_ACP_TRANSCRIPT",
    ])
      expect(names, n).toContain(n);
    expect(state.agent.environment).toEqual(started.data.environment);
    for (const v of [SEED.gh, SEED.awsKey, SEED.awsSecret, SEED.npm, SEED.nodeAuth, SEED.sock])
      expect(rawLog, v).not.toContain(v);
    expect(JSON.stringify(state)).not.toContain(SEED.gh);
  });
});
