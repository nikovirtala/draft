import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentSpec, AgentSpecSchema, resolveAgent } from "../src/main/acp/agents.ts";
import {
  AGENT_GIT_EMAIL,
  AGENT_GITCONFIG,
  agentEnvironment,
  agentEnvPaths,
  ensureAgentEnvironmentFiles,
  NO_GITHUB_TOKEN,
} from "../src/main/acp/environment.ts";

const DATA = "/data/draft";
const SECRET = "s3cr3t-value-that-must-never-be-reported";

const spec = (o: Partial<AgentSpec> = {}): AgentSpec => ({
  ...resolveAgent({ agent: "kiro", agents: {} }),
  ...o,
});

/** Run the function on an environment where every variable's value is the secret. */
const run = (names: string[], s: AgentSpec = spec()) => {
  const person: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const n of names) person[n] = SECRET;
  return agentEnvironment(s, person, DATA);
};

const withheldNames = (r: ReturnType<typeof run>) => r.report.withheld.map((w) => w.name);

describe("agentEnvironment: what is withheld", () => {
  it.each([
    ["github", ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]],
    [
      "github",
      ["GITHUB_PERSONAL_ACCESS_TOKEN", "HOMEBREW_GITHUB_API_TOKEN", "GH_CONFIG_DIR", "GITHUB_PAT"],
    ],
    ["git", ["GITLAB_TOKEN", "GLAB_TOKEN", "BITBUCKET_APP_PASSWORD", "CI_JOB_TOKEN"]],
    [
      "git",
      ["GIT_ASKPASS", "GIT_SSH", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_CONFIG_KEY_3"],
    ],
    ["ssh", ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"]],
    [
      "aws",
      [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_SECURITY_TOKEN",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_VAULT",
      ],
    ],
    [
      "npm",
      [
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "npm_config__authToken",
        "npm_config_//registry.npmjs.org/:_authToken",
        "YARN_NPM_AUTH_TOKEN",
        "CARGO_REGISTRY_TOKEN",
        "CARGO_REGISTRIES_PRIVATE_TOKEN",
        "TWINE_PASSWORD",
      ],
    ],
    [
      "draft",
      [
        "DRAFT_AGENT",
        "DRAFT_ACP_TRANSCRIPT",
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      ],
    ],
  ])("withholds the %s variables by name", (group, names) => {
    const r = run(names);
    for (const n of names) {
      expect(Object.values(r.env)).not.toContain(SECRET);
      expect(r.report.withheld.find((x) => x.name === n)?.group, n).toBe(group);
      expect(r.env[n]).not.toBe(SECRET);
    }
  });

  it("keeps what the agent needs", () => {
    const keep = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/someone",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMPDIR: "/var/folders/xx/T/",
      USER: "someone",
      SHELL: "/bin/zsh",
      XDG_DATA_HOME: "/Users/someone/.local/share",
      KIRO_API_KEY: "kiro-own-key",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "eu-west-1",
      GH_HOST: "github.com",
    };
    const r = agentEnvironment(spec(), keep, DATA);
    for (const [k, v] of Object.entries(keep)) {
      if (k === "PATH") continue;
      expect(r.env[k], k).toBe(v);
    }
    expect(r.report.withheld).toEqual([]);
    // KIRO_HOME is draft's own for Kiro (kiro-agent.ts), so the person's isn't kept.
    expect(
      agentEnvironment(spec(), { ...keep, KIRO_HOME: "/Users/someone/.kiro" }, DATA).env.KIRO_HOME,
    ).toBe("/data/draft/kiro-home");
  });

  it("never changes HOME", () => {
    expect(agentEnvironment(spec(), { HOME: "/Users/someone" }, DATA).env.HOME).toBe(
      "/Users/someone",
    );
  });

  it("keeps draft's own variables from every agent, and ANTHROPIC_API_KEY from all but Claude's", () => {
    const person = { DRAFT_KIRO_AUTH: "none", ANTHROPIC_API_KEY: SECRET, PATH: "/bin" };
    const kiro = agentEnvironment(spec(), person, DATA);
    expect(kiro.env.DRAFT_KIRO_AUTH).toBeUndefined();
    expect(kiro.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(kiro.report.withheld).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      group: "other-agent",
    });
    const claude = agentEnvironment(resolveAgent({ agent: "claude", agents: {} }), person, DATA);
    expect(claude.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(claude.env.DRAFT_KIRO_AUTH).toBeUndefined();
    expect(claude.report.withheld.map((w) => w.name)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("leaves the person's environment object alone", () => {
    const person = { GH_TOKEN: SECRET, PATH: "/bin" };
    agentEnvironment(spec(), person, DATA);
    expect(person).toEqual({ GH_TOKEN: SECRET, PATH: "/bin" });
  });
});

describe("agentEnvironment: the overrides", () => {
  const p = agentEnvPaths(DATA);
  const r = agentEnvironment(spec(), { PATH: "/usr/bin:/bin", HOME: "/Users/x" }, DATA);

  it("gives gh a token GitHub refuses, and an empty config folder", () => {
    for (const n of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
      expect(r.env[n]).toBe(NO_GITHUB_TOKEN);
    expect(r.env.GH_CONFIG_DIR).toBe(p.ghConfigDir);
    expect(r.env.GH_PROMPT_DISABLED).toBe("1");
  });

  it("gives git no system config, its own global file, no prompt and no credential helper", () => {
    expect(r.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(r.env.GIT_CONFIG_GLOBAL).toBe(p.gitConfig);
    expect(r.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(r.env.GIT_CONFIG_COUNT).toBe("1");
    expect(r.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(r.env.GIT_CONFIG_VALUE_0).toBe("");
  });

  it("gives git over SSH no config, agent or key", () => {
    const cmd = r.env.GIT_SSH_COMMAND ?? "";
    expect(cmd.startsWith("ssh ")).toBe(true);
    for (const o of [
      "-F /dev/null",
      "IdentityFile=none",
      "IdentityAgent=none",
      "IdentitiesOnly=yes",
      "PubkeyAuthentication=no",
      "BatchMode=yes",
      "ControlPath=none",
    ])
      expect(cmd, o).toContain(o);
    expect(r.env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("puts an ssh wrapper first on the PATH", () => {
    expect(r.env.PATH).toBe(`${p.binDir}:/usr/bin:/bin`);
    expect(r.report.overridden).toContain("PATH");
  });

  it("points aws and npm at empty files", () => {
    expect(r.env.AWS_CONFIG_FILE).toBe(p.awsConfig);
    expect(r.env.AWS_SHARED_CREDENTIALS_FILE).toBe(p.awsCredentials);
    expect(r.env.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(r.env.AWS_PROFILE).toBeUndefined();
    expect(r.env.NPM_CONFIG_USERCONFIG).toBe(p.npmrc);
  });

  it("replaces the person's own values for the same names", () => {
    const x = agentEnvironment(
      spec(),
      { AWS_CONFIG_FILE: "/Users/x/.aws/config", NPM_CONFIG_USERCONFIG: "/Users/x/.npmrc" },
      DATA,
    );
    expect(x.env.AWS_CONFIG_FILE).toBe(p.awsConfig);
    expect(x.env.NPM_CONFIG_USERCONFIG).toBe(p.npmrc);
    // Their value didn't reach the agent, and draft set another.
    expect(x.report.withheld.map((w) => w.name)).toContain("AWS_CONFIG_FILE");
    expect(x.report.overridden).toContain("AWS_CONFIG_FILE");
  });

  it("is the same for the same input", () => {
    const a = agentEnvironment(spec(), { A: "1", GH_TOKEN: "x" }, DATA);
    const b = agentEnvironment(spec(), { GH_TOKEN: "x", A: "1" }, DATA);
    expect(a).toEqual(b);
  });
});

describe("agentEnvironment: passEnv and the agent's own env", () => {
  it("passes a named variable of the person's through and says so", () => {
    const r = agentEnvironment(
      spec({ passEnv: ["AWS_PROFILE", "GH_TOKEN"] }),
      { AWS_PROFILE: "work", GH_TOKEN: SECRET, AWS_ACCESS_KEY_ID: SECRET },
      DATA,
    );
    expect(r.env.AWS_PROFILE).toBe("work");
    expect(r.env.GH_TOKEN).toBe(SECRET);
    expect(r.report.passed).toEqual(["AWS_PROFILE", "GH_TOKEN"]);
    // What wasn't named stays withheld, and a passed name isn't also reported as withheld.
    expect(withheldNames(r)).toEqual(["AWS_ACCESS_KEY_ID"]);
    expect(r.report.overridden).not.toContain("GH_TOKEN");
    expect(r.env.GITHUB_TOKEN).toBe(NO_GITHUB_TOKEN);
  });

  it("lets passEnv drop an override, so the agent finds the tool's own default", () => {
    const r = agentEnvironment(spec({ passEnv: ["NPM_CONFIG_USERCONFIG"] }), {}, DATA);
    expect(r.env.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(r.report.passed).toEqual(["NPM_CONFIG_USERCONFIG"]);
  });

  it("says nothing about a passEnv name that changes nothing", () => {
    const r = agentEnvironment(spec({ passEnv: ["LANG"] }), { LANG: "C" }, DATA);
    expect(r.report.passed).toEqual([]);
    expect(r.env.LANG).toBe("C");
  });

  it("never passes draft's own variables", () => {
    const r = agentEnvironment(
      spec({ passEnv: ["DRAFT_AGENT_COMMAND", "NODE_OPTIONS"] }),
      { DRAFT_AGENT_COMMAND: SECRET, NODE_OPTIONS: "--inspect" },
      DATA,
    );
    expect(r.env.DRAFT_AGENT_COMMAND).toBeUndefined();
    expect(r.env.NODE_OPTIONS).toBeUndefined();
    expect(r.report.refused).toEqual(["DRAFT_AGENT_COMMAND", "NODE_OPTIONS"]);
    expect(r.report.passed).toEqual([]);
  });

  it("can hand a key to an agent that doesn't require it", () => {
    const r = agentEnvironment(
      spec({ passEnv: ["ANTHROPIC_API_KEY"] }),
      { ANTHROPIC_API_KEY: SECRET },
      DATA,
    );
    expect(r.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(r.report.passed).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("applies the agent's own env last, and reports one that replaces something", () => {
    const r = agentEnvironment(spec({ env: { GH_TOKEN: "from-config", MY_VAR: "1" } }), {}, DATA);
    expect(r.env.GH_TOKEN).toBe("from-config");
    expect(r.env.MY_VAR).toBe("1");
    expect(r.report.passed).toEqual(["GH_TOKEN"]);
    expect(r.report.overridden).not.toContain("GH_TOKEN");
  });

  it("reads passEnv from config.json for a built-in and a custom agent", () => {
    const a = AgentSpecSchema.parse({ command: "kiro-cli", passEnv: ["AWS_PROFILE"] });
    expect(resolveAgent({ agent: "kiro", agents: { kiro: a } }).passEnv).toEqual(["AWS_PROFILE"]);
    const c = AgentSpecSchema.parse({ command: "my-agent" });
    expect(c.passEnv).toEqual([]);
    expect(resolveAgent({ agent: "mine", agents: { mine: c } }).passEnv).toEqual([]);
    expect(() => AgentSpecSchema.parse({ command: "x", passEnv: [""] })).toThrow();
  });
});

describe("the report never carries a value", () => {
  it("lists names and groups only", () => {
    const names = [
      "GH_TOKEN",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_PROFILE",
      "NPM_TOKEN",
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
      "ANTHROPIC_API_KEY",
      "DRAFT_ANYTHING",
    ];
    const r = run(names, spec({ passEnv: ["AWS_PROFILE", "DRAFT_X"] }));
    expect(JSON.stringify(r.report)).not.toContain(SECRET);
    expect(r.report.withheld.length).toBeGreaterThan(5);
    for (const w of r.report.withheld) expect(Object.keys(w).sort()).toEqual(["group", "name"]);
  });

  it("is a plain object that survives a round trip through JSON", () => {
    const r = run(["GH_TOKEN"]);
    expect(JSON.parse(JSON.stringify(r.report))).toEqual(r.report);
  });
});

describe("ensureAgentEnvironmentFiles", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "draft-agent-env-"));

  it("writes the git config, the empty files and the ssh wrapper", () => {
    const dir = fresh();
    const p = ensureAgentEnvironmentFiles(dir);
    const git = readFileSync(p.gitConfig, "utf8");
    expect(git).toBe(AGENT_GITCONFIG);
    expect(git).toContain(AGENT_GIT_EMAIL);
    expect(git).not.toMatch(/helper\s*=\s*\S/);
    for (const f of [p.awsConfig, p.awsCredentials, p.npmrc])
      expect(
        readFileSync(f, "utf8")
          .replace(/^#.*\n/gm, "")
          .trim(),
      ).toBe("");
    expect(statSync(p.ghConfigDir).isDirectory()).toBe(true);
    expect(statSync(p.ssh).mode & 0o111).not.toBe(0);
    expect(readFileSync(p.ssh, "utf8")).toContain("PubkeyAuthentication=no");
  });

  it("writes them again when they are missing or were changed", () => {
    const dir = fresh();
    const p = ensureAgentEnvironmentFiles(dir);
    rmSync(p.gitConfig);
    writeFileSync(p.awsCredentials, "[default]\naws_access_key_id = AKIA\n");
    writeFileSync(p.npmrc, "//registry.npmjs.org/:_authToken=abc\n");
    chmodSync(p.ssh, 0o644);
    rmSync(p.ghConfigDir, { recursive: true });
    ensureAgentEnvironmentFiles(dir);
    expect(readFileSync(p.gitConfig, "utf8")).toBe(AGENT_GITCONFIG);
    expect(readFileSync(p.awsCredentials, "utf8")).not.toContain("AKIA");
    expect(readFileSync(p.npmrc, "utf8")).not.toContain("abc");
    expect(statSync(p.ssh).mode & 0o111).not.toBe(0);
    expect(statSync(p.ghConfigDir).isDirectory()).toBe(true);
  });

  it("keeps one set per data folder: a second call leaves the files as they are", () => {
    const dir = fresh();
    const p = ensureAgentEnvironmentFiles(dir);
    const before = statSync(p.gitConfig).mtimeMs;
    ensureAgentEnvironmentFiles(dir);
    expect(statSync(p.gitConfig).mtimeMs).toBe(before);
  });
});
