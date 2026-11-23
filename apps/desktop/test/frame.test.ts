import { describe, expect, it } from "vitest";
import {
  composerPlaceholder,
  MAIN_PLACEHOLDER,
  PAUSED_PLACEHOLDER,
  showsAsideHint,
  THREAD_PLACEHOLDER,
} from "../src/shared/frame.ts";

describe("the composer's words", () => {
  it("says what the main composer, a thread's composer and a paused one are for", () => {
    expect(composerPlaceholder({ thread: false, paused: false })).toBe(
      "Ask, describe, or type @ to reference anything",
    );
    expect(composerPlaceholder({ thread: true, paused: false })).toBe("Reply in thread…");
    expect(composerPlaceholder({ thread: false, paused: true })).toBe(PAUSED_PLACEHOLDER);
    expect(composerPlaceholder({ thread: true, paused: true })).toBe(PAUSED_PLACEHOLDER);
    expect(PAUSED_PLACEHOLDER).toMatch(/isn’t listening/);
    expect(new Set([MAIN_PLACEHOLDER, THREAD_PLACEHOLDER, PAUSED_PLACEHOLDER]).size).toBe(3);
  });
});

describe("the aside hint", () => {
  it("shows only when there is another person to hear an aside", () => {
    expect(showsAsideHint(0)).toBe(false);
    expect(showsAsideHint(1)).toBe(false);
    expect(showsAsideHint(2)).toBe(true);
    expect(showsAsideHint(5)).toBe(true);
  });
});
