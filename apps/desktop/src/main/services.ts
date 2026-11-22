import { join } from "node:path";
import {
  type AcceptanceActions,
  AdrResolver,
  ArkIssueResolver,
  ArtifactPageResolver,
  GithubClient,
  githubNote,
  KiroOAuth,
  type KiroRemoteTools,
  KiroSessionResolver,
  kiroMcpUrl,
  McpKiroRemoteTools,
  PersonTools,
  PullRequestResolver,
  personActions,
  type Resolver,
  resolveGithubAuth,
} from "@nikovirtala/draft-core";
import { AcpRuntime } from "./acp/runtime.ts";
import type { Config } from "./config.ts";
import type { RuntimeDeps } from "./contexts/runtime.ts";
import { ensureIdentity, userActor } from "./identity.ts";
import { SafeStorageSecretStore } from "./secrets.ts";

/**
 * What the device shares between its contexts: its identity, the connection to Kiro Remote, and
 * the resolvers for what conversations mention. Built once; every context runs on them.
 */
export interface Services {
  user: ReturnType<typeof userActor>;
  actions: (KiroRemoteTools & { close?(): Promise<void> }) | null;
  resolvers: Resolver[];
  /** The read-only GitHub client: the map reads the repositories a context covers through it. */
  github: GithubClient;
  /** How an answer to an acceptance request is carried out: the person's own git, gh and adr. */
  acceptance: AcceptanceActions;
  /** How draft reaches GitHub, for the note the main conversation shows; null for nothing to say. */
  githubNote: string | null;
  makeAgent: RuntimeDeps["makeAgent"];
  close(): Promise<void>;
}

export async function createServices(o: {
  config: Config;
  env: NodeJS.ProcessEnv;
  appVersion: string;
  openBrowser: (url: string) => Promise<void>;
}): Promise<Services> {
  const { config, env } = o;
  const identity = ensureIdentity(config.dataDir);
  let tools: Services["actions"] = null;
  let oauth: KiroOAuth | null = null;
  const mcpUrl = config.kiroRemoteUrl === null ? null : kiroMcpUrl(config.kiroRemoteUrl);
  if (mcpUrl !== null) {
    if (config.kiroAuth === "oauth") {
      oauth = new KiroOAuth({
        serverUrl: mcpUrl,
        store: new SafeStorageSecretStore(join(config.dataDir, "secrets.bin")),
        openBrowser: o.openBrowser,
      });
    }
    const mcp = new McpKiroRemoteTools({
      url: mcpUrl,
      ...(oauth === null ? {} : { authProvider: oauth }),
    });
    const signIn = oauth;
    tools = {
      async call(tool, args, options) {
        // The first call signs in through the browser; later calls use or refresh the token.
        if (signIn !== null) await signIn.accessToken();
        return mcp.call(tool, args, options);
      },
      close: () => mcp.close(),
    };
  }

  // GitHub: a token from the environment, else from `gh`, else public access, and only ever reads.
  const githubAuth = await resolveGithubAuth(env);
  const github = new GithubClient({ token: githubAuth.token, baseUrl: config.githubApiUrl });
  let viewer: Promise<string | null> | null = null;
  // Who "you" are on GitHub, asked once: a review requested from you needs it.
  const viewerLogin = () =>
    (viewer ??= github.authenticated
      ? github.getJson<{ login?: string }>("/user").then(
          (u) => u?.login ?? null,
          () => null,
        )
      : Promise.resolve(null));
  // The person's own tools (git with their identity and signing key, gh, adr): how an answer to an
  // acceptance request is carried out, as them, in clones draft manages. Only that answer reaches
  // them; the read-only GitHub client above never writes (ADRs wkcnp3zr, k8af6zrg).
  const person = new PersonTools({
    dir: config.dataDir,
    ...(config.person.gh === null ? {} : { gh: config.person.gh }),
    ...(config.person.adr === null ? {} : { adr: config.person.adr }),
    remotes: config.person.gitRemotes,
  });
  const pulls = new PullRequestResolver(github, viewerLogin);
  const resolvers: Resolver[] = [
    ...(tools === null ? [] : [new KiroSessionResolver(tools)]),
    pulls,
    new AdrResolver(github, pulls, { sources: config.arkSources, verifier: person }),
    new ArkIssueResolver(github, { sources: config.arkSources }),
    new ArtifactPageResolver({
      baseUrl: config.artifactUrl,
      token: env.ARTIFACT_TOKEN ?? null,
    }),
  ];

  return {
    user: userActor(identity),
    actions: tools,
    resolvers,
    github,
    acceptance: personActions(person),
    githubNote: githubNote(githubAuth),
    // One ACP agent process per agent a conversation chose, in each context, started where that
    // context's agent works.
    makeAgent: (spec, place) =>
      new AcpRuntime({
        spec,
        cwd: place.cwd,
        placeNote: place.note,
        folder: place.folder,
        env,
        dataDir: config.dataDir,
        clientInfo: { name: "draft", version: o.appVersion },
        ...(env.DRAFT_ACP_TRANSCRIPT === undefined ? {} : { transcript: env.DRAFT_ACP_TRANSCRIPT }),
        kiro:
          mcpUrl === null || config.kiroRemoteUrl === null
            ? null
            : {
                url: mcpUrl,
                baseUrl: config.kiroRemoteUrl,
                token: async () => (oauth === null ? null : oauth.accessToken()),
              },
      }),
    close: async () => {
      await tools?.close?.();
    },
  };
}
