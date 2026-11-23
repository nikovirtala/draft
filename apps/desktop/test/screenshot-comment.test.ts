import { describe, expect, it } from "vitest";
import { commentBody, MARKER } from "../scripts/screenshot-comment.ts";
import type { State } from "../scripts/screenshot-states.ts";

const states: State[] = [
  {
    state: "A graph",
    screenshot: "g.png",
    preview: "docs/design-system/components/Graph/preview.html",
    width: 720,
  },
  { state: "An empty map", screenshot: "e.png", preview: null, width: 720 },
  {
    state: "Never taken",
    screenshot: "n.png",
    preview: "docs/design-system/components/Switch/preview.html",
    width: 720,
  },
];
const input = {
  states,
  repository: "o/r",
  imagesCommit: "c".repeat(40),
  imagesDir: `7/${"a".repeat(40)}`,
  headSha: "a".repeat(40),
  screenshots: new Set(["g.png", "e.png"]),
  previews: new Set(["g.preview.png"]),
  runUrl: "https://github.com/o/r/actions/runs/1",
};

describe("the screenshot comment", () => {
  const body = commentBody(input);

  it("starts with the hidden marker the comment is found by", () => {
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
  });

  it("pins every image to the commit that holds it, never to a branch", () => {
    const urls = [...body.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(urls).toEqual([
      `https://github.com/o/r/raw/${"c".repeat(40)}/7/${"a".repeat(40)}/g.png`,
      `https://github.com/o/r/raw/${"c".repeat(40)}/7/${"a".repeat(40)}/g.preview.png`,
      `https://github.com/o/r/raw/${"c".repeat(40)}/7/${"a".repeat(40)}/e.png`,
    ]);
    expect(body).not.toContain("ci/screenshots");
  });

  it("has a row for every state: no design preview, not taken, not rendered", () => {
    expect(body).toContain("| An empty map |");
    expect(body).toContain("no design preview");
    expect(body).toMatch(
      /\| Never taken \| not taken in this run \| \[Switch\].*\(not rendered in this run\) \|/,
    );
    expect(
      body.split("\n").filter((l) => /^\| (A graph|An empty map|Never taken) \|/.test(l)),
    ).toHaveLength(3);
  });
});
