import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentEnvironmentReport, AgentWithheldGroup } from "@nikovirtala/draft-core";
import type { AgentSpec } from "./agents.ts";

/**
 * The environment of an agent's process (ADR on keeping the person's credentials out of the
 * agent's process, issue xh46a2ks).
 *
 * The agent runs as the person's operating-system user, so it reaches whatever that user's tools
 * reach: gh's token, git's credential helper, SSH keys, AWS profiles, npm tokens. Acting as the
 * person goes through draft's own steps only (ADR wkcnp3zr), so the agent's process gets an
 * environment in which those tools find nothing. This stops casual use: a process that reads the
 * person's files directly, or calls the keychain itself, still can. The stronger boundary is a
 * sandbox (see the ADR). `HOME` is never changed: Kiro keeps its sign-in under it.
 *
 * `agentEnvironment` is pure: the person's environment, the agent's spec and the data folder in,
 * the agent's environment and a report of what it left out, by name, out. Later slices (reading the
 * person's Kiro rules, routing the agent's tools through draft) add rules here rather than fork it.
 * `ensureAgentEnvironmentFiles` writes the few files the overrides point at.
 */

/** What stands in for a GitHub token: gh finds it first, and GitHub refuses it. */
export const NO_GITHUB_TOKEN = "draft-withholds-the-persons-github-sign-in-from-the-agent";

/** The git identity of the agent: clearly not the person. */
export const AGENT_GIT_NAME = "draft agent";
export const AGENT_GIT_EMAIL = "agent@draft.invalid";

/**
 * ssh options for git over SSH, and for the `ssh` wrapper: no user or system config (-F), no agent,
 * no identity files and no public-key authentication at all, no prompts, no shared connections.
 * https://man.openbsd.org/ssh_config (IdentityFile, IdentityAgent, IdentitiesOnly) and
 * https://man.openbsd.org/ssh (-F: the system-wide configuration is ignored too)
 */
export const SSH_OPTIONS = [
  "-F",
  "/dev/null",
  "-o",
  "IdentityFile=none",
  "-o",
  "IdentityAgent=none",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "PKCS11Provider=none",
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
] as const;

/** Where draft keeps what the overrides point at: one set per data folder. */
export function agentEnvPaths(dataDir: string) {
  const root = join(dataDir, "agent-env");
  return {
    root,
    ghConfigDir: join(root, "gh"),
    gitConfig: join(root, "gitconfig"),
    awsConfig: join(root, "aws-config"),
    awsCredentials: join(root, "aws-credentials"),
    npmrc: join(root, "npmrc"),
    binDir: join(root, "bin"),
    ssh: join(root, "bin", "ssh"),
  };
}
export type AgentEnvPaths = ReturnType<typeof agentEnvPaths>;

/** The git config of the agent: no credential helper, and an identity that isn't the person's. */
export const AGENT_GITCONFIG = `# Written by draft. The agent's git has no credential helper and no identity of the person.
[user]
\tname = ${AGENT_GIT_NAME}
\temail = ${AGENT_GIT_EMAIL}
[credential]
\thelper =
`;

const NOTE = "# Written by draft: an empty file, so the agent's tools find no sign-in here.\n";

/**
 * A stand-in for `ssh` first on the agent's PATH, so `ssh` and `scp` find no key either. It runs the
 * next `ssh` on the PATH with SSH_OPTIONS in front (the first value of an option wins). The agent
 * can still run /usr/bin/ssh by its path; that is the sandbox's job, not the environment's.
 */
export function sshWrapper(): string {
  const options = SSH_OPTIONS.map((o) => `'${o}'`).join(" ");
  return `#!/bin/sh
# Written by draft: ssh without the person's keys, agent or configuration.
self=$(cd "$(dirname "$0")" && pwd -P)
set -f
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$self" ] && continue
  if [ -f "$dir/ssh" ] && [ -x "$dir/ssh" ]; then
    exec "$dir/ssh" ${options} "$@"
  fi
done
echo "ssh: command not found" >&2
exit 127
`;
}

function isDraftName(n: string): boolean {
  return /^(DRAFT_|ELECTRON_|OTEL_)/.test(n) || n === "NODE_OPTIONS";
}

/** The ways an environment variable is withheld: by name, in groups the status can name. */
const RULES: { group: AgentWithheldGroup; test: (name: string) => boolean }[] = [
  // draft's own settings and the Electron runtime's never reach an agent.
  { group: "draft", test: isDraftName },
  {
    group: "github",
    test: (n) =>
      /^(GH|GITHUB)_(ENTERPRISE_)?(TOKEN|PAT)$/.test(n) ||
      /^GITHUB_(PERSONAL_ACCESS_TOKEN|OAUTH_TOKEN|AUTH_TOKEN|ACCESS_TOKEN)$/.test(n) ||
      n === "HOMEBREW_GITHUB_API_TOKEN" ||
      n === "GH_CONFIG_DIR",
  },
  {
    group: "git",
    test: (n) =>
      /^GIT_(CONFIG_.*|AUTHOR_.*|COMMITTER_.*|ASKPASS|SSH|SSH_COMMAND|TERMINAL_PROMPT)$/.test(n) ||
      /^(GITLAB|GLAB|BITBUCKET)_.*(TOKEN|PASSWORD)$/.test(n) ||
      n === "CI_JOB_TOKEN",
  },
  { group: "ssh", test: (n) => /^SSH_(AUTH_SOCK|AGENT_PID|ASKPASS|ASKPASS_REQUIRE)$/.test(n) },
  { group: "aws", test: (n) => /^AWS_/.test(n) && !AWS_KEPT.has(n) },
  {
    group: "npm",
    test: (n) =>
      /^(NPM_TOKEN|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN|YARN_NPM_AUTH_IDENT)$/.test(n) ||
      /^(CARGO_REGISTRY_TOKEN|TWINE_PASSWORD|UV_PUBLISH_TOKEN|PYPI_TOKEN)$/.test(n) ||
      /^CARGO_REGISTRIES_.*_TOKEN$/.test(n) ||
      /^npm_config_userconfig$/i.test(n) ||
      /^npm_config_.*(_authtoken|_auth|_password)$/i.test(n),
  },
];

/** AWS settings that carry no credential and no profile. */
const AWS_KEPT = new Set([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_DEFAULT_OUTPUT",
  "AWS_PAGER",
  "AWS_CA_BUNDLE",
  "AWS_MAX_ATTEMPTS",
  "AWS_RETRY_MODE",
  "AWS_SDK_UA_APP_ID",
]);

export interface AgentEnvironment {
  env: Record<string, string>;
  report: AgentEnvironmentReport;
}

/**
 * The environment for an agent's process: the person's, without their credentials and draft's own
 * settings, with overrides that make the tools find none, then the agent's own variables. The
 * report lists, by name and never by value, the person's variables that didn't reach the agent
 * (`withheld`, including those draft replaced) and the ones draft set (`overridden`).
 */
export function agentEnvironment(
  spec: AgentSpec,
  person: NodeJS.ProcessEnv,
  dataDir: string,
): AgentEnvironment {
  const paths = agentEnvPaths(dataDir);
  const out: Record<string, string> = {};
  const withheld = new Map<string, AgentWithheldGroup>();
  for (const [name, value] of Object.entries(person)) {
    if (value === undefined) continue;
    const rule = RULES.find((r) => r.test(name));
    if (rule !== undefined) {
      withheld.set(name, rule.group);
      continue;
    }
    // A key meant for one agent isn't handed to the others.
    if (name === "ANTHROPIC_API_KEY" && !spec.requires.some((r) => r.name === name)) {
      withheld.set(name, "other-agent");
      continue;
    }
    out[name] = value;
  }

  const overrides: Record<string, string> = {
    // gh reads a token from these before any stored credential, the keychain included, so a value
    // GitHub refuses makes `gh auth status` fail whatever the keychain holds. An empty config
    // folder alone doesn't: gh falls back to the keychain's unkeyed entry for the host.
    // https://cli.github.com/manual/gh_help_environment
    GH_TOKEN: NO_GITHUB_TOKEN,
    GITHUB_TOKEN: NO_GITHUB_TOKEN,
    GH_ENTERPRISE_TOKEN: NO_GITHUB_TOKEN,
    GITHUB_ENTERPRISE_TOKEN: NO_GITHUB_TOKEN,
    GH_CONFIG_DIR: paths.ghConfigDir,
    GH_PROMPT_DISABLED: "1",
    // git: no system config (osxkeychain usually lives there), a global file draft writes, no
    // prompts, and an empty credential.helper above even a repository's own config.
    // https://git-scm.com/docs/git#Documentation/git.txt-GITCONFIGGLOBAL
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    // $GIT_SSH_COMMAND beats core.sshCommand and $GIT_SSH.
    GIT_SSH_COMMAND: ["ssh", ...SSH_OPTIONS].join(" "),
    // aws: empty config and credentials files, so no profile and no SSO session resolves, and no
    // instance metadata lookup. https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html
    AWS_CONFIG_FILE: paths.awsConfig,
    AWS_SHARED_CREDENTIALS_FILE: paths.awsCredentials,
    AWS_EC2_METADATA_DISABLED: "true",
    // npm: an empty user config, so the tokens in ~/.npmrc aren't read.
    // https://docs.npmjs.com/cli/using-npm/config#userconfig
    NPM_CONFIG_USERCONFIG: paths.npmrc,
  };
  if (process.platform !== "win32") {
    overrides.PATH = [paths.binDir, ...(person.PATH === undefined ? [] : [person.PATH])].join(
      delimiter,
    );
  }

  // The person's deliberate exceptions. draft's own settings are never passed.
  const passed: string[] = [];
  const refused: string[] = [];
  for (const name of new Set(spec.passEnv)) {
    if (isDraftName(name)) {
      refused.push(name);
      continue;
    }
    const effective = withheld.has(name) || name in overrides;
    withheld.delete(name);
    delete overrides[name];
    const value = person[name];
    if (value !== undefined) out[name] = value;
    if (effective) passed.push(name);
  }

  // What the agent's own `env` sets is the person's configuration, and wins over the rest.
  for (const name of Object.keys(spec.env)) {
    if ((withheld.has(name) || name in overrides) && !passed.includes(name)) passed.push(name);
    withheld.delete(name);
    delete overrides[name];
  }

  const env = { ...out, ...overrides, ...spec.env };
  return {
    env,
    report: {
      withheld: [...withheld].map(([name, group]) => ({ name, group })).sort(byName),
      overridden: Object.keys(overrides).sort(),
      passed: passed.sort(),
      refused: refused.sort(),
    },
  };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function writeAtomic(path: string, content: string, mode: number): void {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) {
        chmodSync(path, mode);
        return;
      }
    } catch {
      // Unreadable: written again below.
    }
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

/**
 * Writes the files the overrides point at, in draft's data folder. Each is written atomically and
 * written again when it is missing or has changed, so what the agent may have put in them doesn't
 * outlive its process. Called each time an agent's process starts.
 */
export function ensureAgentEnvironmentFiles(dataDir: string): AgentEnvPaths {
  const p = agentEnvPaths(dataDir);
  mkdirSync(p.ghConfigDir, { recursive: true, mode: 0o700 });
  mkdirSync(p.binDir, { recursive: true, mode: 0o700 });
  writeAtomic(p.gitConfig, AGENT_GITCONFIG, 0o600);
  writeAtomic(p.awsConfig, NOTE, 0o600);
  writeAtomic(p.awsCredentials, NOTE, 0o600);
  writeAtomic(p.npmrc, NOTE, 0o600);
  writeAtomic(p.ssh, sshWrapper(), 0o755);
  return p;
}
