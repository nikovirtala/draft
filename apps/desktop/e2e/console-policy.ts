import { ALLOWED, type Allowed } from "./console-allowlist.ts";

/**
 * What counts as the app saying something it shouldn't, as a function of one line it printed.
 * The harness gets the main process's stderr (from a file, see capture-main.cjs) and console, and
 * each window's console and uncaught errors; the harness labels each line with where it came from and
 * asks this module whether it fails the test.
 */

export type Source =
  | "main stderr"
  | "main console.error"
  | "renderer console.error"
  | "renderer uncaught error";

/** Electron's format: `(electron) 'safeStorage.isEncryptionAvailable' is deprecated ...`. */
export const DEPRECATION = /\(electron\).*deprecat/i;
/** Node's own deprecations: `(node:123) [DEP0040] DeprecationWarning: ...`. */
export const NODE_DEPRECATION = /\bDeprecationWarning\b/;
/** Node's report of a promise rejected with nothing to catch it, in the main process. */
export const UNHANDLED_REJECTION = /UnhandledPromiseRejection|Unhandled(?: Promise)? Rejection/i;

/** Whether a line from this source fails the test, given an allow-list. */
export function isViolation(
  source: Source,
  line: string,
  allowed: readonly Allowed[] = ALLOWED,
): boolean {
  if (line.trim() === "") return false;
  if (allowed.some((a) => a.pattern.test(line))) return false;
  switch (source) {
    case "main stderr":
      return [DEPRECATION, NODE_DEPRECATION, UNHANDLED_REJECTION].some((re) => re.test(line));
    // A console.error of the main process also reaches its stderr, so a line may be reported twice.
    case "main console.error":
    case "renderer console.error":
    case "renderer uncaught error":
      return true;
  }
}

/** The line as the failure prints it. */
export const labelled = (source: Source, line: string): string => `[${source}] ${line.trim()}`;
