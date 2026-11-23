import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LayoutService } from "../src/main/layout.ts";
import { ViewStateStore } from "../src/main/view-state.ts";
import {
  CONVERSATION_MIN,
  clampPanelWidth,
  clampStoredPanelWidth,
  composerPlaceholder,
  MAIN_PLACEHOLDER,
  PANEL_MIN,
  PAUSED_PLACEHOLDER,
  panelMax,
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

describe("the thread column's width", () => {
  it("stays between the narrowest column and the room the conversation keeps", () => {
    expect(clampPanelWidth(10, 1600)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, 1600)).toBe(1600 - CONVERSATION_MIN);
    expect(clampPanelWidth(612.4, 1600)).toBe(612);
    // A window too narrow for both: the thread keeps its minimum.
    expect(panelMax(500)).toBe(PANEL_MIN);
  });

  it("keeps a whole number of pixels the main process can store", () => {
    expect(clampStoredPanelWidth(100)).toBe(PANEL_MIN);
    expect(clampStoredPanelWidth(500.6)).toBe(501);
    expect(clampStoredPanelWidth(99_999)).toBe(4000);
  });

  it("is remembered on this device and comes back after a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "draft-width-")), "device.db");
    const first = new ViewStateStore(file);
    const layout = new LayoutService(first);
    expect(layout.view().panelWidth).toBeNull();
    const seen: (number | null)[] = [];
    layout.onChange((v) => seen.push(v.panelWidth));
    layout.setPanelWidth(640.2);
    layout.setPanelWidth(640);
    expect(layout.view().panelWidth).toBe(640);
    // The same width again changes nothing, so nothing is announced twice.
    expect(seen).toEqual([640]);
    first.close();

    const second = new ViewStateStore(file);
    expect(new LayoutService(second).view().panelWidth).toBe(640);
    second.close();
  });

  it("is forgotten with null, and the default holds after a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "draft-width-")), "device.db");
    const first = new ViewStateStore(file);
    const layout = new LayoutService(first);
    layout.setPanelWidth(640);
    const seen: (number | null)[] = [];
    layout.onChange((v) => seen.push(v.panelWidth));
    layout.setPanelWidth(null);
    layout.setPanelWidth(null);
    expect(layout.view().panelWidth).toBeNull();
    expect(seen).toEqual([null]);
    first.close();

    const second = new ViewStateStore(file);
    expect(new LayoutService(second).view().panelWidth).toBeNull();
    second.close();
  });
});
