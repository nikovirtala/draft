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
import { designProblems } from "./design-checks.ts";

/**
 * What every end-to-end spec shares: how the app is launched, how a screenshot is named and where
 * it goes, and the watch on what the app prints.
 *
 * - `launchApp` is `electron.launch` (the app's main module first in `args`), plus a watch on the main process's stderr (copied to a file
 *   from its first line by capture-main.cjs) and console, and on the console and uncaught errors
 *   of every window it opens.
 * - `test` is Playwright's, plus a check after each test: a line that fails (console-policy.ts,
 *   with its allow-list in console-allowlist.ts) fails the test and is printed.
 * - The design rules (design-checks.ts: the window never scrolls, a fill only where the allow-list
 *   says, one focus ring) are checked on every window of an app when the test closes it, so after
 *   the test's last step, and on any app a test leaves open, when the test ends. A problem fails
 *   the test and is printed with the rule it breaks.
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

/** What the design checks found, until the test that follows it ends. */
const designFailures: string[] = [];

/** The files the main processes of this test's launches wrote their stderr to. */
const mainLogs: string[] = [];
/** The apps this test launched and has not closed. */
const open = new Set<ElectronApplication>();
let launches = 0;

/** The design checks on every window of an app, once, as it is about to close. */
async function checkDesign(app: ElectronApplication): Promise<void> {
  if (!open.delete(app)) return;
  designFailures.push(...(await designProblems(app)));
}

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
  open.add(app);
  // The test's last step is closing the app: check what is on screen first.
  const close = app.close.bind(app);
  app.close = async () => {
    await checkDesign(app);
    await close();
  };
  return app;
}

export const test = base.extend<{ consoleWatch: undefined }>({
  consoleWatch: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function uses from its first parameter.
    async ({}, use) => {
      await use(undefined);
      // An app the test left open is checked as it stands.
      for (const app of [...open]) await checkDesign(app);
      // The last lines of a process that was just closed are still on their way.
      await new Promise((resolve) => setTimeout(resolve, 250));
      for (const log of mainLogs.splice(0)) {
        if (!existsSync(log))
          violations.push(`[harness] ${log} was never written: capture-main.cjs did not load`);
        else for (const line of readFileSync(log, "utf8").split("\n")) flag("main stderr", line);
      }
      const broken = designFailures.splice(0);
      if (broken.length > 0)
        throw new Error(
          `the window breaks ${broken.length === 1 ? "a design rule" : "design rules"} (e2e/design-checks.ts; the rules are in docs/design/draft-design-spec.md):\n${broken.join("\n")}`,
        );
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

/**
 * A screenshot of one element, scrolled into view: whatever the page is scrolled to. It takes a
 * few pixels around the element, so a focus ring (drawn outside the box) is in the picture.
 */
export async function shotOf(scope: Locator, name: string): Promise<void> {
  await scope.scrollIntoViewIfNeeded();
  const box = await scope.boundingBox();
  if (box === null) throw new Error(`shotOf: ${name} has no box`);
  const margin = 4;
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  await scope.page().screenshot({
    path: join(artifacts, `${name}.png`),
    clip: {
      x,
      y,
      width: box.width + (box.x - x) + margin,
      height: box.height + (box.y - y) + margin,
    },
  });
}
