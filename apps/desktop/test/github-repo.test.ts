import { describe, expect, it } from "vitest";
import { githubRepoOf } from "../src/main/contexts/folder.ts";

describe("the GitHub repository of a remote", () => {
  it.each([
    ["https://github.com/nikovirtala/draft.git", "nikovirtala/draft"],
    ["https://github.com/nikovirtala/draft", "nikovirtala/draft"],
    ["git@github.com:nikovirtala/draft.git", "nikovirtala/draft"],
    ["ssh://git@github.com/nikovirtala/draft.git", "nikovirtala/draft"],
    ["https://github.com/nikovirtala/kiro-remote/", "nikovirtala/kiro-remote"],
  ])("reads %s", (remote, repo) => expect(githubRepoOf(remote)).toBe(repo));

  it.each([
    "https://gitlab.com/o/r.git",
    "git@example.com:o/r.git",
    "https://github.com/onlyowner",
    "/some/local/path",
  ])("leaves %s alone", (remote) => expect(githubRepoOf(remote)).toBeNull());
});
