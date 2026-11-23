// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "../../src/renderer/src/components/ConversationView.tsx";
import type { Block } from "../../src/shared/ipc.ts";
import {
  bridge,
  conversationState,
  inWorkspace,
  type Mounted,
  mount,
  workspace,
} from "./harness.tsx";

/**
 * A check as a person meets it: its reason and steps, a command that copies exactly, Passed and
 * Failed with their notes, and a decision's acceptance offered with a check that has passed.
 */

type CheckBlock = Extract<Block, { kind: "check" }>;

const ADR = { type: "adr", id: "nikovirtala/draft:8rhwhgbw" };
const COMMAND = 'pkill -f draft-desktop; cd ~/src && echo "a  b"\nsecond line';

function check(over: Partial<CheckBlock["check"]> = {}): CheckBlock {
  return {
    kind: "check",
    id: "check:k:0",
    at: "2026-11-23T10:00:00.000Z",
    check: {
      key: "check:k:0",
      state: "requested",
      title: "Look at the palette",
      reason: "Why no test can show it: it is a look.",
      steps: [
        {
          text: "Run it. You should see a window on cream.",
          do: "Run it.",
          see: "You should see a window on cream.",
          commands: [COMMAND],
        },
      ],
      tail: null,
      raw: "raw",
      parsed: true,
      source: {
        type: "merged-pull-request",
        target: { type: "pull-request", id: "nikovirtala/draft/pull/9" },
        ref: "nikovirtala/draft#9",
        sha: "a".repeat(40),
        title: "A change",
        url: "https://github.com/nikovirtala/draft/pull/9",
      },
      gates: [],
      requestedAt: "2026-11-23T10:00:00.000Z",
      raisedAt: "2026-11-23T10:00:00.000Z",
      reminders: 0,
      answer: null,
      ...over,
    },
  };
}

const acceptance = (): Block => ({
  kind: "interrupt",
  cause: "acceptance",
  id: "accept:adr:k",
  state: "open",
  tool: "",
  input: null,
  idempotencyKey: null,
  at: "2026-11-23T10:05:00.000Z",
  summary: "draft:8rhwhgbw is ready to accept",
  detail: { title: "Accept only as the person", evidence: [] },
  target: ADR,
  outcomes: ["accepted", "changes-requested", "rejected"],
  settled: null,
  cleared: null,
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

async function show(timeline: Block[]): Promise<HTMLElement> {
  const states = { "local/main": conversationState({ timeline }) };
  mounted = await mount(
    inWorkspace(workspace({ states }), <ConversationView conversation="local/main" />),
  );
  return mounted.host;
}

const byId = (host: HTMLElement, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const click = (el: HTMLElement | undefined) =>
  act(async () => {
    el?.click();
  });
const type = (el: HTMLTextAreaElement, text: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("a check that waits on the person", () => {
  it("opens to its reason, then its steps with what they should see", async () => {
    bridge({});
    const host = await show([check()]);
    const section = byId(host, "check")[0];
    expect(section?.dataset.state).toBe("requested");
    expect(byId(host, "check-state")[0]?.textContent).toBe("Waiting for you");
    expect(byId(host, "check-title")[0]?.textContent).toBe("Look at the palette");
    expect(byId(host, "check-details")[0]?.hasAttribute("open")).toBe(true);
    expect(byId(host, "check-reason")[0]?.textContent).toContain("it is a look");
    expect(byId(host, "check-step")).toHaveLength(1);
    expect(byId(host, "check-see")[0]?.textContent).toContain("You should see a window on cream.");
  });

  it("copies a command exactly as written, with one action", async () => {
    const copyText = vi.fn(async () => {});
    bridge({ copyText });
    const host = await show([check()]);
    expect(byId(host, "check-command-text")[0]?.textContent).toBe(COMMAND);
    await click(byId(host, "check-copy")[0]);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(COMMAND);
    expect(byId(host, "check-copy")[0]?.textContent).toBe("Copied");
  });

  it("passes with no note, or with one", async () => {
    const answerCheck = vi.fn(async () => {});
    bridge({ answerCheck });
    const host = await show([check()]);
    await click(byId(host, "check-pass")[0]);
    expect(answerCheck).toHaveBeenLastCalledWith("local/main", "check:k:0", "passed", undefined);
    await type(byId(host, "check-note")[0] as HTMLTextAreaElement, "looked right");
    await click(byId(host, "check-pass")[0]);
    expect(answerCheck).toHaveBeenLastCalledWith(
      "local/main",
      "check:k:0",
      "passed",
      "looked right",
    );
  });

  it("asks for a note before it fails, and sends it", async () => {
    const answerCheck = vi.fn(async () => {});
    bridge({ answerCheck });
    const host = await show([check()]);
    await click(byId(host, "check-fail")[0]);
    expect(answerCheck).not.toHaveBeenCalled();
    expect(byId(host, "check-error")[0]?.textContent).toBe(
      "Say what you saw, so whoever fixes it knows.",
    );
    await type(byId(host, "check-note")[0] as HTMLTextAreaElement, "it was blank");
    await click(byId(host, "check-fail")[0]);
    expect(answerCheck).toHaveBeenCalledExactlyOnceWith(
      "local/main",
      "check:k:0",
      "failed",
      "it was blank",
    );
  });

  it("shows what cannot be read as steps as it was written", async () => {
    bridge({});
    const host = await show([
      check({ parsed: false, steps: [], reason: "", raw: "Look at **this** by eye." }),
    ]);
    expect(byId(host, "check-raw")[0]?.textContent).toContain("Look at this by eye.");
    expect(byId(host, "check-steps")).toHaveLength(0);
  });
});

describe("a check that is answered", () => {
  it("says passed with the word and failed in the waiting colours with its word", async () => {
    bridge({});
    const passed = check({
      state: "passed",
      answer: { outcome: "passed", at: "2026-11-23T11:00:00.000Z", by: "Niko", note: "fine" },
    });
    const failed = {
      ...check({
        key: "check:k:1",
        state: "failed",
        answer: { outcome: "failed", at: "2026-11-23T11:00:00.000Z", by: "Niko", note: "blank" },
      }),
      id: "check:k:1",
    };
    const host = await show([passed, failed]);
    const chips = byId(host, "check-state");
    expect(chips.map((c) => [c.textContent, c.className])).toEqual([
      ["Passed", "pending good"],
      ["Failed", "pending bad"],
    ]);
    expect(byId(host, "check-pass")).toHaveLength(0);
    expect(byId(host, "check-answer")[1]?.textContent).toContain("Failed by Niko");
    expect(byId(host, "check-answer")[1]?.textContent).toContain("blank");
    expect(byId(host, "check-details")[0]?.hasAttribute("open")).toBe(false);
  });
});

describe("a check that names a decision", () => {
  const gated = (state: "requested" | "passed" | "failed") =>
    check({ state, gates: [{ target: ADR, title: "Accept only as the person" }] });

  it("offers the acceptance once it has passed, in the check, and not twice", async () => {
    bridge({});
    const host = await show([gated("passed"), acceptance()]);
    const gate = byId(host, "check-gate")[0];
    expect(gate?.dataset.stubTarget).toBe(`adr:${ADR.id}`);
    expect(
      gate?.querySelector('[data-testid="interrupt"][data-cause="acceptance"]'),
    ).not.toBeNull();
    expect(byId(host, "settle-accepted")).toHaveLength(1);
    expect(byId(host, "interrupt")).toHaveLength(1);
  });

  it("offers nothing while it waits, and nothing once it has failed", async () => {
    bridge({});
    for (const state of ["requested", "failed"] as const) {
      const host = await show([gated(state)]);
      expect(byId(host, "settle-accepted")).toHaveLength(0);
      expect(byId(host, "check-gate")[0]?.textContent).toContain(
        state === "failed" ? "not offered" : "offered when this passes",
      );
      expect(byId(host, "check-gate")[0]?.hasAttribute("data-stub-target")).toBe(false);
      await mounted?.unmount();
      mounted = null;
    }
  });
});
