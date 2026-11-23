import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { afterDeploySection, parseAfterDeploy } from "../src/after-deploy.ts";

/**
 * The parse of "After deploy" sections, on real pull request bodies of draft and kiro-remote
 * (scrubbed of anything personal) and on the shapes AGENTS.md asks for. The counts below are what
 * the pull request description reports.
 */

const dir = new URL("./fixtures/after-deploy/", import.meta.url);
const body = (name: string): string => readFileSync(new URL(`${name}.body.txt`, dir), "utf8");

/** Items each real body gives, by fixture. */
const COUNTS: Record<string, number> = {
  "draft-19-withheld-environment": 1,
  "draft-24-prose-only": 1,
  "draft-33-late-permission": 1,
  "draft-39-quieter-window": 1,
  "draft-41-palette-look": 1,
  "kiro-remote-14-idempotency-bullets": 7,
  "kiro-remote-15-needs-heading-suffix": 1,
  "kiro-remote-17-two-bullets": 2,
  "kiro-remote-18-nothing-with-reason": 0,
};

describe("the real pull request bodies", () => {
  it("has a fixture for each count", () => {
    expect(
      readdirSync(dir)
        .map((f) => f.replace(".body.txt", ""))
        .sort(),
    ).toEqual(Object.keys(COUNTS).sort());
  });

  for (const [name, count] of Object.entries(COUNTS))
    it(`${name} gives ${count} ${count === 1 ? "check" : "checks"}`, () => {
      expect(parseAfterDeploy(body(name))).toHaveLength(count);
    });

  it("reads a procedure with a reason before its numbered steps as one check", () => {
    const [item] = parseAfterDeploy(body("draft-39-quieter-window"));
    expect(item?.parsed).toBe(true);
    expect(item?.title).toBe("Only a look no test can show");
    expect(item?.reason).toContain("whether the window feels quieter");
    expect(item?.steps).toHaveLength(2);
    expect(item?.steps[0]?.commands).toEqual([
      'pkill -f draft-desktop; cd ~/src/github.com/example-owner/draft && git switch main && git pull --ff-only && pnpm install && pnpm --filter @example-owner/draft-desktop dev -- "$HOME/src/github.com/example-owner/kiro-remote"',
    ]);
    expect(item?.steps[0]?.see).toBe("You should see draft open on the kiro-remote context.");
    expect(item?.steps[1]?.see).toContain("You should see one short top bar");
  });

  it("keeps a command exactly as written, and the text after the steps", () => {
    const [item] = parseAfterDeploy(body("draft-33-late-permission"));
    expect(item?.steps).toHaveLength(6);
    expect(item?.steps[1]?.commands).toEqual([
      "Create a file called late.txt containing the word late, using your write_file tool.",
    ]);
    expect(item?.tail).toContain("What would show a problem, and what to tell me:");
    expect(item?.tail).toContain("adr accept 8rhwhgbw");
    expect(item?.raw).toContain("pkill -f draft-desktop");
  });

  it("reads a heading with a suffix, and each bullet of a list as a check", () => {
    expect(parseAfterDeploy(body("kiro-remote-15-needs-heading-suffix"))[0]?.steps).toHaveLength(7);
    const [a, b] = parseAfterDeploy(body("kiro-remote-17-two-bullets"));
    expect(a?.steps).toHaveLength(1);
    expect(a?.steps[0]?.commands).toEqual(["PIPELINE FROZEN: nothing was deployed"]);
    expect(b?.steps[0]?.commands).toEqual(["./scripts/pipeline.sh unfreeze"]);
  });

  it("shows prose that has no steps as one check with its Markdown as written", () => {
    const [item] = parseAfterDeploy(body("draft-24-prose-only"));
    expect(item?.parsed).toBe(false);
    expect(item?.steps).toEqual([]);
    expect(item?.raw).toContain("Once both hold, close ?47.");
  });

  it("reads Nothing followed by a reason as no check", () => {
    expect(afterDeploySection(body("kiro-remote-18-nothing-with-reason"))?.trim()).toMatch(
      /^Nothing\./,
    );
    expect(parseAfterDeploy(body("kiro-remote-18-nothing-with-reason"))).toEqual([]);
  });

  it("names the ADR a body mentions among its candidates", () => {
    const [item] = parseAfterDeploy(body("draft-33-late-permission"));
    expect(item?.adrCandidates).toContain("8rhwhgbw");
  });
});

describe("the shape AGENTS.md asks for", () => {
  const section = (text: string) =>
    `## Summary\n\nx\n\n## After deploy\n\n${text}\n\n## Filed for later\n\nNone\n`;

  it("reads Nothing and None, in any case, with or without a full stop", () => {
    for (const t of ["Nothing", "None", "nothing.", "**None.**", "Nothing: CI shows it all"])
      expect(parseAfterDeploy(section(t))).toEqual([]);
  });

  it("reads an empty section, a missing section and the template's comment as no check", () => {
    expect(parseAfterDeploy(section(""))).toEqual([]);
    expect(parseAfterDeploy("## Summary\n\nOnly this.\n")).toEqual([]);
    expect(
      parseAfterDeploy(section("<!--\nOnly what no test can show.\n- an example\n-->")),
    ).toEqual([]);
  });

  it("makes one check of each top-level bullet, with its reason, steps and what to see", () => {
    const items = parseAfterDeploy(
      section(
        [
          "- **Look at the palette.** Why no test can show it: it is a look. It gates ADR 8rhwhgbw.",
          "  1. In a terminal, run `pnpm dev`. You should see a window on cream.",
          "  2. Run:",
          "",
          "     ```sh",
          "     echo one",
          "     echo two",
          "     ```",
          "",
          "     You should see two lines.",
          "- **Sign in once.** Why no test can show it: it needs your account.",
          "  1. Run `kiro-cli login`. You should see a browser tab open.",
        ].join("\n"),
      ),
    );
    expect(items.map((i) => [i.index, i.title, i.steps.length])).toEqual([
      [0, "Look at the palette", 2],
      [1, "Sign in once", 1],
    ]);
    const [first] = items;
    expect(first?.reason).toBe("Why no test can show it: it is a look. It gates ADR 8rhwhgbw.");
    expect(first?.adrCandidates).toEqual(["8rhwhgbw"]);
    expect(first?.steps[0]).toEqual({
      text: "In a terminal, run `pnpm dev`. You should see a window on cream.",
      do: "In a terminal, run `pnpm dev`.",
      see: "You should see a window on cream.",
      commands: ["pnpm dev"],
    });
    // A fenced block is one command, however many lines it has, and what it prints is not one.
    expect(first?.steps[1]?.commands).toEqual(["echo one\necho two"]);
    expect(first?.steps[1]?.see).toBe("You should see two lines.");
  });

  it("does not take a one-word code span for a command", () => {
    const [item] = parseAfterDeploy(
      section("1. Open `late.txt`, then run `ls -l late.txt`. You should see `late.txt` listed."),
    );
    expect(item?.steps[0]?.commands).toEqual(["ls -l late.txt"]);
  });

  it("reads a numbered list as the steps of one check, with the text before it as its reason", () => {
    const items = parseAfterDeploy(
      section(
        "Only a person can see this.\n\n1. Run `a b`.\n2. Run `c d`. You should see it work.",
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe("Only a person can see this.");
    expect(items[0]?.steps.map((s) => s.commands)).toEqual([["a b"], ["c d"]]);
  });

  it("keeps text that follows a list as the tail, never dropping it", () => {
    const items = parseAfterDeploy(section("- Run `a b`.\n- Run `c d`.\n\nIf it differs, say so."));
    expect(items).toHaveLength(2);
    expect(items[1]?.tail).toBe("If it differs, say so.");
    expect(items[1]?.raw).toContain("If it differs, say so.");
  });

  it("makes one check of anything it cannot read, showing its Markdown as written", () => {
    const text = "Check the **thing** by eye, then tell me.\n\n> a quote";
    const items = parseAfterDeploy(section(text));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ parsed: false, steps: [], raw: text, index: 0 });
    expect(items[0]?.title).toBe("Check the thing by eye, then tell me");
  });

  it("does not end the section at a comment line inside a fenced block", () => {
    const items = parseAfterDeploy(
      section("1. Run:\n\n   ```sh\n   # a shell comment\n   echo hi\n   ```"),
    );
    expect(items[0]?.steps[0]?.commands).toEqual(["# a shell comment\necho hi"]);
  });
});
