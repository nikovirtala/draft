import type { ElectronApplication, Page } from "@playwright/test";
import { FILL_PLACES, FILL_TOKENS, TITLEBAR } from "../src/shared/fills.ts";
import { colour, type Token } from "../src/shared/palette.ts";
import {
  armFocus,
  fillsIn,
  look,
  pressed,
  pressPoint,
  reachedCount,
  windowIn,
} from "./design-page.ts";

/**
 * The design rules, checked on what the app draws, in every window a test opened, after the test's
 * last step (the harness runs them when the test closes the app). One check for each rule, so a
 * rule is held in one place:
 *
 * - **window**: the window never scrolls (spec P6, L6): the document is no taller than the window,
 *   the title bar starts at its top and the footer ends at its bottom.
 * - **fills**: a fill appears only where the allow-list says (spec A1): every visible element whose
 *   computed background is a fill token is marked `data-fill` with a place that allows it.
 * - **focus**: keyboard focus is one 1.5px `moved-mark` ring and no fill, and a click shows none
 *   (spec A5, C3): Tab through the window, then press the mouse on each element Tab reached.
 *
 * What a pointer does (`:hover`) cannot be reached this way: test/design-fills.test.ts reads the
 * stylesheet for it. A problem is a line that says what is wrong, where, and which rule it breaks;
 * the harness fails the test with every line. The code that runs in the page is design-page.ts.
 */

const SPEC = "docs/design/draft-design-spec.md";

/** `#rrggbb` as the computed style prints it. */
function rgb(token: Token): string {
  const n = Number.parseInt(colour(token).replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * What a mouse press is not tried on. A text field and a select show the ring for any way of
 * focusing them, as the platform defines `:focus-visible`. A separator is moved by pressing it and
 * moving the pointer, and a width the check dragged to would be kept.
 */
const NOT_PRESSED =
  ":is(textarea, input, select):not([type=radio], [type=checkbox], [type=button], [type=submit], [type=range]), [role=separator]";

async function fillProblems(page: Page): Promise<string[]> {
  const byColour: Record<string, string[]> = {};
  for (const token of FILL_TOKENS) byColour[rgb(token)] = [...(byColour[rgb(token)] ?? []), token];
  const places = Object.fromEntries(
    Object.entries(FILL_PLACES).map(([place, p]) => [place, [...p.tokens] as string[]]),
  );
  return page.evaluate(fillsIn, {
    byColour,
    places,
    titlebar: { colour: rgb(TITLEBAR.token), selector: TITLEBAR.selector },
    spec: SPEC,
  });
}

/** Tab through the window; each element reached shows the ring and no fill of its own. */
async function focusProblems(page: Page): Promise<string[]> {
  const out: string[] = [];
  const ring = rgb("--moved-mark");
  await page.bringToFront();
  await page.mouse.move(0, 0);
  await page.evaluate(armFocus);

  let idle = 0;
  for (let i = 0; i < 300 && idle < 3; i++) {
    await page.keyboard.press("Tab");
    const seen = await page.evaluate(look);
    if (seen === null) {
      idle++;
      continue;
    }
    idle = 0;
    // Chromium draws a width below a device pixel as one pixel, so a 1.5px ring reads 1px on a
    // screen at 1x. A 2px ring, the drift this catches, reads 2px at any scale; the stylesheet
    // test (test/design-focus.test.ts) holds the declared 1.5px.
    const problems: string[] = [];
    if (seen.style !== "solid" || seen.width < 1 || seen.width > 1.5)
      problems.push(`its outline is ${seen.style} ${seen.width}px, not a 1.5px solid ring`);
    else if (seen.colour !== ring)
      problems.push(`its ring is ${seen.colour}, not moved-mark ${ring}`);
    if (seen.before !== undefined && seen.before !== seen.background)
      problems.push(`its background changed from ${seen.before} to ${seen.background}`);
    for (const p of problems)
      out.push(
        `focus: ${seen.path} has keyboard focus and ${p}. Rule: ${SPEC} A5 (a 1.5px moved-mark ring, no fill)`,
      );
  }

  // The mouse on the same elements: pressed on each and released elsewhere, so nothing is
  // activated. A click shows no ring (see NOT_PRESSED for what is left out).
  const count = await page.evaluate(reachedCount);
  for (let i = 0; i < count; i++) {
    const at = await page.evaluate(pressPoint, { i, skip: NOT_PRESSED });
    if (at === null || at.x < 0 || at.y < 0) continue;
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    const shown = await page.evaluate(pressed, i);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    if (shown !== null && shown.style !== "none" && shown.width > 0)
      out.push(
        `focus: ${shown.path} shows a ${shown.width}px ${shown.style} outline after a mouse press. Rule: ${SPEC} A5 (a click shows no ring)`,
      );
  }
  await page.mouse.move(0, 0);
  return out;
}

/** The three checks on every window the app has open; each problem is one line. */
export async function designProblems(app: ElectronApplication): Promise<string[]> {
  const out: string[] = [];
  for (const [n, page] of app.windows().entries()) {
    if (page.isClosed()) continue;
    try {
      // The pointer parked in a corner, so no row is under it and shows its hover.
      await page.mouse.move(0, 0);
      const found = [
        ...(await page.evaluate(windowIn, SPEC)),
        ...(await fillProblems(page)),
        ...(await focusProblems(page)),
      ];
      out.push(...found.map((p) => `[design] window ${n + 1}: ${p}`));
    } catch (e) {
      // A window that went away while it was read has nothing left to show.
      if (!page.isClosed())
        out.push(
          `[design] window ${n + 1}: the checks could not run: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
  }
  // Tab reaches many alike elements; one line for each kind of problem.
  return [...new Set(out)];
}
