/// <reference lib="dom" />

/**
 * What the design checks run inside the page (Playwright serializes each function, so none may use
 * anything outside itself: no import, no constant of this file). They read; the only thing they
 * change is focus, in `armFocus` and `look`, which is what the focus check is about.
 */

export interface FillArgs {
  byColour: Record<string, string[]>;
  places: Record<string, string[]>;
  titlebar: { colour: string; selector: string };
  spec: string;
}

export interface FocusLook {
  path: string;
  style: string;
  width: number;
  colour: string;
  background: string;
  before: string | undefined;
}

declare global {
  interface Window {
    /** The elements Tab reached, in order, and what each looked like before anything had focus. */
    __designFocus?: { reached: Element[]; backgrounds: WeakMap<Element, string> };
  }
}

/** The window never scrolls. */
export function windowIn(spec: string): string[] {
  const out: string[] = [];
  const scrolling = document.scrollingElement ?? document.documentElement;
  const height = window.innerHeight;
  if (scrolling.scrollHeight > height)
    out.push(
      `the document is ${scrolling.scrollHeight}px tall in a window ${height}px tall: something grows past the window`,
    );
  if (scrolling.scrollTop !== 0) out.push(`the window is scrolled by ${scrolling.scrollTop}px`);
  const bar = document.querySelector("header.titlebar");
  if (bar !== null && Math.abs(bar.getBoundingClientRect().top) > 0.5)
    out.push(`the title bar starts ${bar.getBoundingClientRect().top}px from the window's top`);
  const footer = document.querySelector('[data-testid="footer"]');
  if (footer !== null) {
    const bottom = footer.getBoundingClientRect().bottom;
    if (Math.abs(bottom - height) > 0.5)
      out.push(`the footer ends at ${bottom}px in a window ${height}px tall`);
  } else {
    // A window of one block has no footer: the block ends at the window's bottom or above it.
    const last = document.querySelector(".app")?.lastElementChild;
    const bottom = last?.getBoundingClientRect().bottom ?? 0;
    if (bottom > height + 0.5)
      out.push(`the last part of the window ends at ${bottom}px in a window ${height}px tall`);
  }
  return out.map((p) => `window: ${p}. Rule: ${spec} P6 (the window never scrolls)`);
}

/** A fill appears only where the allow-list says. */
export function fillsIn({ byColour, places, titlebar, spec }: FillArgs): string[] {
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e !== null && e !== document.body; e = e.parentElement) {
      const id = e.getAttribute("data-testid");
      const cls = [...e.classList].slice(0, 2).join(".");
      parts.unshift(
        `${e.tagName.toLowerCase()}${id !== null ? `[${id}]` : cls !== "" ? `.${cls}` : ""}`,
      );
      if (parts.length >= 6) break;
    }
    return parts.join(" > ");
  };
  const allowing = (token: string) =>
    Object.entries(places)
      .filter(([, tokens]) => tokens.includes(token))
      .map(([place]) => place);
  const out: string[] = [];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const seen: [string, string][] = [["background", style.backgroundColor]];
    if (el instanceof SVGElement) seen.push(["fill", style.fill]);
    for (const [property, value] of seen) {
      if (value === titlebar.colour) {
        if (!el.matches(titlebar.selector))
          out.push(
            `fills: ${pathOf(el)} has ${property} ${value} (titlebar), which only ${titlebar.selector} may have. Rule: ${spec} A1`,
          );
        continue;
      }
      const tokens = byColour[value];
      if (tokens === undefined) continue;
      const marks = (el.getAttribute("data-fill") ?? "").split(/\s+/).filter((m) => m !== "");
      if (marks.some((m) => tokens.some((t) => places[m]?.includes(t)))) continue;
      const wanted = [...new Set(tokens.flatMap(allowing))];
      out.push(
        `fills: ${pathOf(el)} has ${property} ${value} (${tokens.join(" or ")}) and data-fill=${marks.length === 0 ? "none" : `"${marks.join(" ")}"`}; the places that allow it are ${wanted.join(", ")}. Rule: ${spec} A1 (a fill appears only where the allow-list says)`,
      );
    }
  }
  return out;
}

/** Records every background, and puts the keyboard at the top of the document. */
export function armFocus(): void {
  const backgrounds = new WeakMap<Element, string>();
  for (const el of document.querySelectorAll("*"))
    backgrounds.set(el, getComputedStyle(el).backgroundColor);
  window.__designFocus = { reached: [], backgrounds };
  (document.activeElement as HTMLElement | null)?.blur();
  getSelection()?.collapse(document.body, 0);
}

/** What the element that has focus looks like; null for none, or one already seen. */
export function look(): FocusLook | null {
  const el = document.activeElement;
  const state = window.__designFocus;
  if (el === null || el === document.body || state === undefined) return null;
  if (state.reached.includes(el)) return null;
  state.reached.push(el);
  const style = getComputedStyle(el);
  const parts: string[] = [];
  for (let e: Element | null = el; e !== null && e !== document.body; e = e.parentElement) {
    const id = e.getAttribute("data-testid");
    parts.unshift(
      `${e.tagName.toLowerCase()}${id !== null ? `[${id}]` : e.classList.length > 0 ? `.${e.classList[0]}` : ""}`,
    );
    if (parts.length >= 5) break;
  }
  return {
    path: parts.join(" > "),
    style: style.outlineStyle,
    width: Number.parseFloat(style.outlineWidth),
    colour: style.outlineColor,
    background: style.backgroundColor,
    before: state.backgrounds.get(el),
  };
}

/** How many elements Tab reached. */
export function reachedCount(): number {
  return window.__designFocus?.reached.length ?? 0;
}

/** Where to press the mouse on the i-th element Tab reached; null when it can't be, or `skip` matches it. */
export function pressPoint(arg: { i: number; skip: string }): { x: number; y: number } | null {
  const el = window.__designFocus?.reached[arg.i];
  if (el === undefined || !el.isConnected || el.matches(arg.skip)) return null;
  // Nothing pressed keeps focus from the one before: a script that moves focus on a press gives
  // the ring to the new element when the old one showed it.
  (document.activeElement as HTMLElement | null)?.blur();
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The outline of the i-th element if the press gave it focus; null if it did not. */
export function pressed(i: number): { style: string; width: number; path: string } | null {
  const el = window.__designFocus?.reached[i];
  if (el === undefined || document.activeElement !== el) return null;
  const style = getComputedStyle(el);
  const id = el.getAttribute("data-testid");
  return {
    style: style.outlineStyle,
    width: Number.parseFloat(style.outlineWidth),
    path: `${el.tagName.toLowerCase()}${id !== null ? `[${id}]` : el.classList.length > 0 ? `.${el.classList[0]}` : ""}`,
  };
}

/**
 * What the layout looks like right now, as one string: how tall the document is, how tall each
 * scrolling box's content is, and how many elements there are. While it keeps changing, the app
 * is still drawing (a map laying out, a list loading) and a measurement would be of a moment.
 */
export function layoutSignature(): string {
  const scrolling = document.scrollingElement ?? document.documentElement;
  const boxes = [...document.querySelectorAll(".conversation, .block-full, .panel, .workspace")];
  return [
    scrolling.scrollHeight,
    window.innerHeight,
    document.querySelectorAll("*").length,
    ...boxes.map((b) => `${b.scrollHeight}/${b.clientHeight}`),
  ].join(" ");
}
