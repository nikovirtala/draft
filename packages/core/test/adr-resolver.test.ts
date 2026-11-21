import { describe, expect, it } from "vitest";
import { evidenceGreen } from "../src/acceptance.ts";
import { AdrResolver, adrAcceptance, parseAdrId } from "../src/adr.ts";
import { GithubClient } from "../src/github.ts";
import { PullRequestResolver } from "../src/pull-request.ts";

const resolver = () => {
  const client = new GithubClient({ token: null });
  return new AdrResolver(client, new PullRequestResolver(client), {
    sources: { draft: "nikovirtala/draft", ark: "nikovirtala/ark" },
  });
};

describe("the ADR resolver's references", () => {
  it("finds owner/repo:adrid, a configured source name, and links to a decision's files", () => {
    const r = resolver();
    expect(r.detect("see nikovirtala/draft:9p8jj6p5 and draft:f50z57dk and ark:q76pmwsw.")).toEqual(
      ["nikovirtala/draft:9p8jj6p5", "nikovirtala/draft:f50z57dk", "nikovirtala/ark:q76pmwsw"],
    );
    expect(
      r.detect(
        "https://github.com/nikovirtala/draft/blob/main/docs/adr/decisions/9p8jj6p5-read-github-with-a-token.md and https://github.com/nikovirtala/draft/tree/feat/x/docs/adr/events/f50z57dk",
      ),
    ).toEqual(["nikovirtala/draft:9p8jj6p5", "nikovirtala/draft:f50z57dk"]);
    // Once each, and not inside longer words or URLs.
    expect(r.detect("draft:9p8jj6p5 draft:9p8jj6p5 nikovirtala/draft:9p8jj6p5")).toEqual([
      "nikovirtala/draft:9p8jj6p5",
    ]);
    expect(r.detect("xdraft:9p8jj6p5 draft:9p8jj6p5x draft:short http://a/b:9p8jj6p5")).toEqual([]);
  });

  it("names a target as owner/repo:adrid, and parses it back", () => {
    expect(parseAdrId("nikovirtala/draft:9p8jj6p5")).toEqual({
      repo: "nikovirtala/draft",
      adr: "9p8jj6p5",
    });
    expect(parseAdrId("nikovirtala/draft/pull/3")).toBeNull();
    expect(parseAdrId("nikovirtala/draft:UPPER123")).toBeNull();
  });

  it("is raised by no request until the state says it is proposed on an open pull request", () => {
    const base = {
      repo: "o/r",
      id: "9p8jj6p5",
      title: "T",
      status: "proposed",
      url: "u",
      verify: { sha: "a", status: "clean", findings: 0, summary: "no findings" },
      proposedBy: {
        id: "o/r/pull/1",
        number: 1,
        url: "u",
        title: "p",
        state: "open",
        draft: false,
        headRef: "b",
        headSha: "a",
        headRepo: "o/r",
        baseRef: "main",
        mergeableState: "clean",
        checks: [
          {
            name: "ci",
            source: "check-run",
            status: "completed",
            conclusion: "success",
            url: null,
          },
        ],
      },
    };
    const target = { type: "adr", id: "o/r:9p8jj6p5" };
    const subject = (s: Record<string, unknown>) => adrAcceptance.subject(target, s);
    expect(evidenceGreen(subject(base)?.evidence ?? [])).toBe(true);
    // Not proposed, no pull request, a closed one, or one from a fork: nothing to accept.
    expect(subject({ ...base, status: "accepted" })).toBeNull();
    expect(subject({ ...base, proposedBy: null })).toBeNull();
    expect(subject({ ...base, proposedBy: { ...base.proposedBy, state: "merged" } })).toBeNull();
    expect(subject({ ...base, proposedBy: { ...base.proposedBy, headRepo: "fork/r" } })).toBeNull();
    // verify not run, run on another commit, or with findings: not green. Checks red or running: not green.
    for (const verify of [
      null,
      { sha: "other", status: "clean", findings: 0, summary: "" },
      { sha: "a", status: "findings", findings: 2, summary: "x" },
      { sha: "a", status: "failed", findings: 0, summary: "adr verify could not run" },
    ])
      expect(
        evidenceGreen(subject({ ...base, verify })?.evidence ?? []),
        JSON.stringify(verify),
      ).toBe(false);
    for (const conclusion of ["failure", null])
      expect(
        evidenceGreen(
          subject({
            ...base,
            proposedBy: {
              ...base.proposedBy,
              checks: [
                {
                  name: "ci",
                  source: "check-run",
                  status: conclusion === null ? "in_progress" : "completed",
                  conclusion,
                  url: null,
                },
              ],
            },
          })?.evidence ?? [],
        ),
      ).toBe(false);
  });
});
