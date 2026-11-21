import { join } from "node:path";
import {
  ArkIssueResolver,
  ArtifactPageResolver,
  GithubClient,
  githubNote,
  KiroOAuth,
  type KiroRemoteTools,
  KiroSessionResolver,
  kiroMcpUrl,
  McpKiroRemoteTools,
  PullRequestResolver,
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
  const resolvers: Resolver[] = [
    ...(tools === null ? [] : [new KiroSessionResolver(tools)]),
    new PullRequestResolver(github, viewerLogin),
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
    githubNote: githubNote(githubAuth),
    // One ACP agent process per agent a conversation chose, in each context, started where that
    // context's agent works.
    makeAgent: (spec, place) =>
      new AcpRuntime({
        spec,
        cwd: place.cwd,
        placeNote: place.note,
        env,
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
