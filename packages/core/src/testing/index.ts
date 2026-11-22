import { fileURLToPath } from "node:url";

export {
  type AcceptanceFixture,
  createAcceptanceFixture,
  type FixtureOptions,
} from "./acceptance-fixture.ts";
export {
  type FakeCheck,
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
