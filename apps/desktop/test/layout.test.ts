import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LayoutService } from "../src/main/layout.ts";
import { ViewStateStore } from "../src/main/view-state.ts";
import type { BlockInfo } from "../src/shared/placement.ts";

const MAIN = "local/main";
const T1 = "local/t1";
const status: BlockInfo = {
  address: `${MAIN}/m1@1#kiro-session:S1`,
  kind: "status",
  home: MAIN,
  depth: 0,
  opens: null,
  title: "Fix the build",
};
const inThread: BlockInfo = {
  address: `${T1}/m1@1#kiro-session:S2`,
  kind: "status",
  home: T1,
  depth: 1,
  opens: null,
  title: "Write the docs",
};
const thread: BlockInfo = {
  address: T1,
  kind: "thread",
  home: MAIN,
  depth: 0,
  opens: T1,
  title: "The PR thread",
};

function open(dir = mkdtempSync(join(tmpdir(), "draft-layout-"))) {
  const store = new ViewStateStore(join(dir, "device.db"));
  let t = 0;
  const layout = new LayoutService(store, () =>
    new Date(Date.UTC(2026, 10, 21, 10, 0, t++)).toISOString(),
  );
  return { dir, store, layout, close: () => store.close() };
}

describe("this device's layout", () => {
  it("keeps placements, focus, window bounds and the move record across a restart", () => {
    const first = open();
    first.layout.ensure([
      { info: status, initial: "minimized" },
      { info: inThread, initial: "minimized" },
    ]);
    first.layout.openThread(thread);
    first.layout.move({ type: "pop-out", block: inThread.address });
    first.layout.move({ type: "expand", block: status.address });
    first.layout.focus({ block: status.address });
    first.store.setBounds(inThread.address, { x: 40.4, y: 60, width: 700, height: 500 });
    const before = first.layout.view();
    const moves = first.store.moves();
    first.close();

    const second = open(first.dir);
    expect(second.layout.view().layout).toEqual(before.layout);
    expect(second.layout.view().layout.focus?.block).toBe(status.address);
    expect(second.store.bounds(inThread.address)).toEqual({
      x: 40,
      y: 60,
      width: 700,
      height: 500,
    });
    expect(second.store.moves()).toEqual(moves);
    // Leaving focus after the restart puts everything back, as if it never ended.
    second.layout.focus(null);
    const placements = Object.fromEntries(
      Object.values(second.layout.view().layout.blocks).map((e) => [e.info.address, e.placement]),
    );
    expect(placements).toEqual({
      [status.address]: "inline",
      [inThread.address]: "window",
      [T1]: "panel",
    });
    second.close();
  });

  it("records every placement change: which block, its kind, from, to, when and why", () => {
    const { layout, store, close } = open();
    layout.ensure([{ info: status, initial: "minimized" }]);
    expect(store.moves()).toEqual([]);
    layout.move({ type: "expand", block: status.address });
    layout.move({ type: "open-in-panel", block: status.address });
    layout.move({ type: "close", block: status.address });
    expect(store.moves().map((m) => [m.block, m.kind, m.from, m.to, m.cause])).toEqual([
      [status.address, "status", "minimized", "inline", "user"],
      [status.address, "status", "inline", "panel", "user"],
      [status.address, "status", "panel", "inline", "user"],
    ]);
    expect(store.moves().every((m) => /^2026-11-21T10:00:\d\d\.000Z$/.test(m.at))).toBe(true);
    close();
  });

  it("refuses what the rules refuse and records nothing", () => {
    const { layout, store, close } = open();
    layout.ensure([{ info: inThread, initial: "minimized" }]);
    expect(layout.move({ type: "open-in-panel", block: inThread.address })).toEqual({
      ok: false,
      reason: "no-panel-at-this-depth",
    });
    expect(layout.move({ type: "close", block: "nope" })).toMatchObject({ ok: false });
    expect(store.moves()).toEqual([]);
    close();
  });

  it("closes a window back to where the block came from", () => {
    const { layout, close } = open();
    layout.ensure([{ info: status, initial: "inline" }]);
    layout.move({ type: "pop-out", block: status.address });
    expect(layout.view().layout.blocks[status.address]?.placement).toBe("window");
    layout.move({ type: "close", block: status.address });
    expect(layout.view().layout.blocks[status.address]?.placement).toBe("inline");
    close();
  });

  it("opens a branched thread in the panel, and focus follows to it", () => {
    const { layout, close } = open();
    layout.ensure([{ info: status, initial: "inline" }]);
    layout.focus({ conversation: MAIN });
    layout.openThread(thread);
    const v = layout.view().layout;
    expect(v.focus?.block).toBe(T1);
    expect(v.blocks[T1]?.placement).toBe("panel");
    expect(v.blocks[status.address]?.placement).toBe("minimized");
    layout.focus(null);
    expect(layout.view().layout.blocks[status.address]?.placement).toBe("inline");
    close();
  });

  it("focuses a thread's own block when a conversation is selected", () => {
    const { layout, close } = open();
    layout.ensure([{ info: status, initial: "inline" }]);
    layout.openThread(thread);
    layout.focus({ conversation: T1 });
    expect(layout.view().layout.focus).toMatchObject({ block: T1, conversation: T1 });
    close();
  });

  it("gives a block the place an older version of draft kept for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-layout-"));
    const db = new DatabaseSync(join(dir, "device.db"));
    db.exec("create table placements (key text primary key, placement text not null)");
    db.prepare("insert into placements values (?, ?)").run(status.address, "inline");
    db.close();
    const { layout, close } = open(dir);
    layout.ensure([{ info: status, initial: "minimized" }]);
    expect(layout.view().layout.blocks[status.address]?.placement).toBe("inline");
    close();
  });

  it("counts a thread as read only while its block is in the panel or a window", () => {
    const { layout, close } = open();
    layout.openThread(thread);
    layout.markShown([{ conversation: T1, messages: 4 }]);
    expect(layout.view().seen[T1]).toBe(4);
    layout.move({ type: "close", block: T1 });
    layout.markShown([{ conversation: T1, messages: 6 }]);
    expect(layout.view().seen[T1]).toBe(4);
    close();
  });

  it("starts empty from a stored layout that doesn't check out", () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-layout-"));
    const db = new DatabaseSync(join(dir, "device.db"));
    db.exec("create table layout (id integer primary key check (id = 1), json text not null)");
    db.prepare("insert into layout values (1, ?)").run("{not json");
    db.close();
    const { layout, close } = open(dir);
    expect(layout.view().layout).toEqual({ blocks: {}, focus: null });
    close();
  });
});
