/**
 * What the end-to-end run lets the app print, in one place. Every entry says why it is allowed;
 * prefer none. A line that matches an entry is dropped before it can fail a test, whatever source
 * it came from.
 */
export interface Allowed {
  /** Matched against the line as printed, without the `[source]` label the harness puts on it. */
  pattern: RegExp;
  /** Why this line is understood and harmless, and when the entry can go. */
  why: string;
}

export const ALLOWED: readonly Allowed[] = [];
