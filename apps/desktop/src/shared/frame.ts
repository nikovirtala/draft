/**
 * The words and sizes of the window's frame, apart from the components so they can be tested on
 * their own: what the composer says, when it explains asides, and how wide the thread's column may
 * be.
 */

/** What the main conversation's composer says while the agent listens. */
export const MAIN_PLACEHOLDER = "Ask, describe, or type @ to reference anything";

/** What a thread's composer says while the agent listens. */
export const THREAD_PLACEHOLDER = "Reply in thread…";

/** What a composer says while its agent is paused: plainly, that nobody on the other side reads. */
export const PAUSED_PLACEHOLDER =
  "The agent is paused and isn’t listening. Write @agent to reach it for one message.";

export function composerPlaceholder(o: { thread: boolean; paused: boolean }): string {
  if (o.paused) return PAUSED_PLACEHOLDER;
  return o.thread ? THREAD_PLACEHOLDER : MAIN_PLACEHOLDER;
}

/** An aside reaches someone only when there is another person to receive it. */
export function showsAsideHint(people: number): boolean {
  return people > 1;
}

/** The thread column's narrowest width in pixels. */
export const PANEL_MIN = 320;
/** The room the conversation keeps when the thread column is at its widest. */
export const CONVERSATION_MIN = 420;
/** What one arrow key moves the divider, and with Shift. */
export const PANEL_STEP = 16;
export const PANEL_STEP_LARGE = 64;
/** The most the main process accepts, whatever the window: a sanity bound, not a layout rule. */
const PANEL_STORED_MAX = 4000;

/** The widest the thread column can be in `available` pixels for both columns. */
export function panelMax(available: number): number {
  return Math.max(PANEL_MIN, Math.floor(available - CONVERSATION_MIN));
}

/** A width inside what `available` pixels allow. */
export function clampPanelWidth(width: number, available: number): number {
  return Math.round(Math.min(panelMax(available), Math.max(PANEL_MIN, width)));
}

/** What the main process keeps: a whole number of pixels inside the bounds any window could need. */
export function clampStoredPanelWidth(width: number): number {
  return Math.round(Math.min(PANEL_STORED_MAX, Math.max(PANEL_MIN, width)));
}
