import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
  type Locator,
  type Page,
} from "@playwright/test";
import { isViolation, labelled, type Source } from "./console-policy.ts";

/**
 * What every end-to-end spec shares: how the app is launched, how a screenshot is named and where
 * it goes, and the watch on what the app prints.
 *
 * - `launchApp` is `electron.launch` (the app's main module first in `args`), plus a watch on the main process's stderr (copied to a file
 *   from its first line by capture-main.cjs) and console, and on the console and uncaught errors
 *   of every window it opens.
 * - `test` is Playwright's, plus a check after each test: a line that fails (console-policy.ts,
 *   with its allow-list in console-allowlist.ts) fails the test and is printed.
 * - `shot` and `shotOf` write a named screenshot to `artifacts`. The names in states.json are the
 *   ones the pull request's screenshot comment shows beside the design.
 *
 * A spec imports `test`, `launchApp`, `shot` and `shotOf` from here, never `_electron` or its own
 * copy of them, so a run against a real agent gets the same watch.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const artifacts = join(here, "artifacts");
mkdirSync(artifacts, { recursive: true });

/** What the app printed that should fail the test, until the test that follows it ends. */
const violations: string[] = [];

function flag(source: Source, line: string): void {
  if (isViolation(source, line)) violations.push(labelled(source, line));
}

/** The files the main processes of this test's launches wrote their stderr to. */
const mainLogs: string[] = [];
let launches = 0;

function watchPage(page: Page): void {
  page.on("console", (m) => {
    if (m.type() === "error") flag("renderer console.error", m.text());
  });
  // An uncaught exception, and a promise rejected with nothing to catch it.
  page.on("pageerror", (e) => flag("renderer uncaught error", e.stack ?? String(e)));
}

function watchApp(app: ElectronApplication): void {
  app.on("console", (m) => {
    if (m.type() === "error") flag("main console.error", m.text());
  });
  for (const page of app.windows()) watchPage(page);
  app.on("window", watchPage);
}

/** `electron.launch`, watched. */
export async function launchApp(
  options: Parameters<typeof electron.launch>[0] & { args: string[] },
): Promise<ElectronApplication> {
  const log = join(artifacts, `main-stderr-${process.pid}-${++launches}.log`);
  mainLogs.push(log);
  // The app's main module is the first argument; capture-main.cjs starts in its place and loads it.
  const [main, ...rest] = options.args;
  if (main === undefined || !main.endsWith(".js"))
    throw new Error("launchApp: the first argument is the app's main module");
  const app = await electron.launch({
    ...options,
    args: [join(here, "capture-main.cjs"), ...rest],
    env: { ...(options.env ?? process.env), DRAFT_E2E_MAIN_LOG: log, DRAFT_E2E_MAIN: main },
  });
  watchApp(app);
  return app;
}

export const test = base.extend<{ consoleWatch: undefined }>({
  consoleWatch: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function uses from its first parameter.
    async ({}, use) => {
      await use(undefined);
      // The last lines of a process that was just closed are still on their way.
      await new Promise((resolve) => setTimeout(resolve, 250));
      for (const log of mainLogs.splice(0)) {
        if (!existsSync(log))
          violations.push(`[harness] ${log} was never written: capture-main.cjs did not load`);
        else for (const line of readFileSync(log, "utf8").split("\n")) flag("main stderr", line);
      }
      const seen = violations.splice(0);
      if (seen.length > 0)
        throw new Error(
          `the app printed ${seen.length === 1 ? "a line" : "lines"} that fail the run (see console-policy.ts; allow only what is understood, in console-allowlist.ts):\n${seen.join("\n")}`,
        );
    },
    { auto: true },
  ],
});

export const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(artifacts, `${name}.png`) });

/** A screenshot of one element, scrolled into view: whatever the page is scrolled to. */
export async function shotOf(scope: Locator, name: string): Promise<void> {
  await scope.scrollIntoViewIfNeeded();
  await scope.screenshot({ path: join(artifacts, `${name}.png`) });
}
