import { describe, expect, it } from "vitest";
import { buildRevision, repositoryUrl } from "../build-info.ts";
import { deploymentEnvironment, provenance } from "../src/main/provenance.ts";

describe("draft's deploy provenance", () => {
  it("names the environment: e2e when asked, else release when packaged, else development", () => {
    expect(deploymentEnvironment({ DRAFT_ENVIRONMENT: "e2e" }, false)).toBe("e2e");
    expect(deploymentEnvironment({}, true)).toBe("release");
    expect(deploymentEnvironment({}, false)).toBe("development");
    expect(deploymentEnvironment({ DRAFT_ENVIRONMENT: "production" }, false)).toBe("development");
  });

  it("says unknown without the build-time values", () => {
    expect(provenance({}, false)).toMatchObject({
      revision: "unknown",
      repository: "unknown",
      environment: "development",
    });
  });

  it("takes the revision from CI, else git, else unknown", () => {
    expect(
      buildRevision({ DRAFT_BUILD_REVISION: "0123456789abcdef0123456789abcdef01234567" }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(buildRevision({})).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(buildRevision({}, "/")).toBe("unknown");
  });

  it("reads the repository URL from package.json, never with credentials", () => {
    expect(
      repositoryUrl({ repository: { url: "git+https://github.com/nikovirtala/draft.git" } }),
    ).toBe("https://github.com/nikovirtala/draft");
    expect(repositoryUrl({ repository: "https://user:token@github.com/x/y.git" })).toBe("unknown");
    expect(repositoryUrl({ repository: "git@github.com:x/y.git" })).toBe("unknown");
    expect(repositoryUrl({})).toBe("unknown");
  });
});
