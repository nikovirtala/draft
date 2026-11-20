import { describe, expect, it } from "vitest";
import { checkView, segmentMessage } from "../src/view.ts";

describe("view descriptions", () => {
  it("accepts the two components", () => {
    expect(checkView({ component: "text", text: "hi" })).toEqual({
      ok: true,
      view: { component: "text", text: "hi" },
    });
    expect(
      checkView(
        '{"component":"status-stub","target":{"type":"kiro-session","id":"01KAHX7Z1M2N3P4Q5R6S7T8V9W"}}',
      ),
    ).toMatchObject({
      ok: true,
      view: { component: "status-stub" },
    });
  });

  it.each([
    ["not JSON", "{component: text}"],
    ["an unknown component", { component: "table", rows: [] }],
    ["a missing field", { component: "text" }],
    ["a wrong target type", { component: "status-stub", target: { type: "github-pr", id: "1" } }],
    ["a bare string", "just words"],
  ])("falls back to plain text for %s", (_name, input) => {
    const r = checkView(input);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.fallback).toBe(typeof input === "string" ? input : JSON.stringify(input));
  });

  it("splits a message into text and view blocks", () => {
    const text = 'Here it is:\n\n```view\n{"component":"text","text":"x"}\n```\n\nDone.';
    expect(segmentMessage(text)).toEqual([
      { kind: "text", text: "Here it is:" },
      { kind: "view", source: '{"component":"text","text":"x"}' },
      { kind: "text", text: "Done." },
    ]);
    expect(segmentMessage("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(segmentMessage("")).toEqual([{ kind: "text", text: "" }]);
  });
});
