import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FakeScript } from "../src/agent.ts";
import { type DraftEvent, knownEvents } from "../src/events.ts";
import { Projection } from "../src/projection.ts";
import { fakeKiro, openService } from "./fixtures.ts";

const LAUNCH = { prompt: "Fix the flaky test", repos: ["nikovirtala/draft"], title: "Fix it" };
const script: FakeScript = {
  turns: [{ match: "go", steps: [{ tool: "kiro_launch_session", input: LAUNCH }] }],
  fallback: "",
};

describe("a local permission prompt has an age in the log", () => {
  it("writes when the agent asked, and the prompt's age is that time", async () => {
    const opened = await openService(mkdtempSync(join(tmpdir(), "draft-age-")), fakeKiro(), script);
    const turn = opened.service.submit("go");
    await vi.waitFor(() => expect(opened.service.state().prompts).toHaveLength(1));

    const asked = knownEvents(opened.log.events()).filter(
      (e) => e.type === "agent.permission_asked",
    ) as DraftEvent<"agent.permission_asked">[];
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      actor: { kind: "agent" },
      data: { name: "mcp__kiro-remote__kiro_launch_session", input: LAUNCH },
    });
    // Its place in the attention list is by the time the log has, not by a clock in memory.
    expect(opened.service.attention()).toEqual([
      expect.objectContaining({ cause: "permission", at: asked[0]?.at }),
    ]);
    // The prompt came before any step of the call.
    const types = knownEvents(opened.log.events()).map((e) => e.type);
    expect(types.indexOf("agent.permission_asked")).toBeLessThan(
      types.indexOf("step.started") === -1
        ? Number.POSITIVE_INFINITY
        : types.indexOf("step.started"),
    );

    opened.service.answerPrompt(opened.service.state().prompts[0]?.id as string, false);
    await turn;
    // A declined prompt leaves the request in the log and no step.
    expect(knownEvents(opened.log.events()).some((e) => e.type === "step.started")).toBe(false);
    expect(opened.service.attention()).toEqual([]);
    opened.close();
  });

  it("is kept by a projection that has no table for it, and is rebuilt the same", async () => {
    const opened = await openService(
      mkdtempSync(join(tmpdir(), "draft-age2-")),
      fakeKiro(),
      script,
    );
    const turn = opened.service.submit("go");
    await vi.waitFor(() => expect(opened.service.state().prompts).toHaveLength(1));
    opened.service.answerPrompt(opened.service.state().prompts[0]?.id as string, false);
    await turn;
    const fresh = Projection.open(":memory:");
    fresh.rebuild(opened.log.events());
    expect(fresh.dump()).toEqual(opened.projection.dump());
    fresh.close();
    opened.close();
  });
});
