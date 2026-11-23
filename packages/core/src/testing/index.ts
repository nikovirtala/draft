import { fileURLToPath } from "node:url";

export {
  type AcceptanceFixture,
  createAcceptanceFixture,
  type FixtureOptions,
} from "./acceptance-fixture.ts";
export {
  ADR_IDS,
  ARK_FIXTURE_START,
  ARK_PULL,
  ARK_PULL_HEAD,
  ARK_REPO,
  type ArkFixture,
  ISSUE_IDS,
  seedArk,
} from "./ark-fixture.ts";
export {
  type FakeCheck,
  type FakeDeployment,
  type FakeDeploymentStatus,
  FakeGithub,
  type FakeIssueEvent,
  type FakePull,
  type FakeReview,
  type RecordedRequest,
} from "./fake-github.ts";
export {
  FakeKiroRemote,
  type FakeKiroRemoteOptions,
  type FakePermission,
  type FakeSession,
  type FakeSessionSeed,
  KIRO_REMOTE_TOOLS,
  type ReceivedCall,
  type ToolListEntry,
} from "./fake-kiro-remote.ts";
export { GITHUB_ENVIRONMENTS_RESPONSE } from "./github-environments.ts";
export {
  appendMapFixture,
  at as mapFixtureTime,
  MAP_CONTEXT,
  MAP_FIXTURE_START,
  MAP_MAIN,
  MAP_PR_FAILING,
  MAP_PR_MERGED,
  MAP_PR_READY,
  MAP_SESSION,
  MAP_THREAD_CONCLUDING,
  MAP_THREAD_OPEN,
  MAP_THREAD_WITHDRAWN,
  pullRequestState,
} from "./map-fixture.ts";
export { appendRawLines, sealRawRecord } from "./raw.ts";

/** The fake `gh` program: start it with `node <path> api …`, GH_FAKE_URL naming a fake GitHub. */
export const FAKE_GH_PATH = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./fake-gh.ts" : "./fake-gh.js", import.meta.url),
);
