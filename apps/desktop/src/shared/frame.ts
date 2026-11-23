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
