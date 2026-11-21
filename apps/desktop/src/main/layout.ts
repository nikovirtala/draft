import type { BlockRegistration, MoveOutcome, View } from "../shared/ipc.ts";
import {
  type BlockInfo,
  enterFocus,
  type FocusTarget,
  type Layout,
  leaveFocus,
  type Move,
  move,
  type PlacementChange,
  register,
} from "../shared/placement.ts";
import type { ViewStateStore } from "./view-state.ts";

/**
 * This device's layout: the placement state machine, kept in memory and written to the device's
 * view-state store after every change, together with the changes that made it. Only a person's
 * gesture reaches `move` and `focus`: nothing the agent says does.
 */
export class LayoutService {
  private layout: Layout;
  private seenMessages: Record<string, number>;
  private readonly legacy: Record<string, "inline" | "minimized">;
  private readonly listeners = new Set<(v: View) => void>();

  constructor(
    private readonly store: ViewStateStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.layout = store.layout();
    this.seenMessages = store.seen();
    this.legacy = store.legacyPlacements();
  }

  view(): View {
    return { layout: this.layout, seen: this.seenMessages };
  }

  onChange(cb: (v: View) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private commit(layout: Layout, changes: readonly PlacementChange[]): void {
    this.layout = layout;
    this.store.commit(layout, changes);
    this.emit();
  }

  private emit(): void {
    const v = this.view();
    for (const l of this.listeners) l(v);
  }

  /** Registers blocks the first time this device sees them; a block seen before stays put. */
  ensure(blocks: readonly BlockRegistration[]): void {
    let layout = this.layout;
    const changes: PlacementChange[] = [];
    for (const b of blocks) {
      if (layout.blocks[b.info.address] !== undefined) continue;
      const placement = this.legacy[b.info.address] ?? b.initial;
      const r = register(layout, b.info, { placement, returnTo: placement }, this.now());
      layout = r.layout;
      changes.push(...r.changes);
    }
    if (layout !== this.layout) this.commit(layout, changes);
  }

  /** A person's move: refused moves change nothing. */
  move(m: Move): MoveOutcome {
    const r = move(this.layout, m, "user", this.now());
    if (!r.ok) return { ok: false, reason: r.reason };
    this.commit(r.layout, r.changes);
    return { ok: true };
  }

  /** Enters focus on a block, or on a conversation (a thread's own block when it has one). */
  focus(target: FocusTarget | null): void {
    if (target === null) {
      if (this.layout.focus === null) return;
      const r = leaveFocus(this.layout, this.now());
      this.commit(r.layout, r.changes);
      return;
    }
    let t = target;
    if ("conversation" in t) {
      const thread = Object.values(this.layout.blocks).find(
        (e) => e.info.opens === (target as { conversation: string }).conversation,
      );
      if (thread !== undefined) t = { block: thread.info.address };
    }
    const r = enterFocus(this.layout, t, this.now());
    if (r.layout === this.layout) return;
    this.commit(r.layout, r.changes);
  }

  /**
   * A thread was branched: its block opens in the panel and goes back to a one-line stub when
   * closed. While in focus, focus follows the person to the thread they just made.
   */
  openThread(info: BlockInfo): void {
    const r = register(
      this.layout,
      info,
      { placement: "panel", returnTo: "minimized" },
      this.now(),
    );
    this.commit(r.layout, r.changes);
    if (r.layout.focus !== null) this.focus({ block: info.address });
  }

  /** What each thread has shown on this device: the ones in the panel or a window are read. */
  markShown(threads: readonly { conversation: string; messages: number }[]): void {
    let changed = false;
    for (const t of threads) {
      const e = Object.values(this.layout.blocks).find((b) => b.info.opens === t.conversation);
      if (e === undefined || (e.placement !== "panel" && e.placement !== "window")) continue;
      if (this.seenMessages[t.conversation] === t.messages) continue;
      this.store.setSeen(t.conversation, t.messages);
      this.seenMessages = { ...this.seenMessages, [t.conversation]: t.messages };
      changed = true;
    }
    if (changed) this.emit();
  }

  /** The device saw `messages` of a thread, whatever its placement (a thread that starts empty). */
  seeded(conversation: string, messages: number): void {
    if (this.seenMessages[conversation] !== undefined) return;
    this.store.setSeen(conversation, messages);
    this.seenMessages = { ...this.seenMessages, [conversation]: messages };
  }
}
