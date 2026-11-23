---
name: draft-design
description: Use when styling or adding UI in apps/desktop/src/renderer, including colour, fills, focus, chips, stubs and blocks, the map, motion, loading or accessibility, or before merging any renderer change.
---

# draft design

Rules for how draft's window looks and behaves. This is a summary. The source of truth is [the design spec](../../../docs/design/draft-design-spec.md); the palette is [docs/design-system](../../../docs/design-system/README.md). If this skill and the spec disagree, the spec wins, and you fix the skill in the same change. To add a new kind of item to the conversation, use the `draft-block` skill as well.

Each rule is **built** (the code does it) or **planned** (nothing carries it yet). Do not assume a planned file, check or attribute exists: look first. The spec's Drift section lists where the code breaks a rule today; do not copy a drifting pattern.

## Before you touch the renderer

1. Read the spec's "Where things may appear" and the anatomy of the part you change.
2. Look at the design system's preview for it (`docs/design-system/components/<Part>/preview.html`). If your change needs a look the preview does not show, change the design system's text, tokens and preview first and get the picture accepted before code applies it.
3. Check `apps/desktop/e2e/states.json` for the screenshots your change will show in CI's comment.

## Tokens (built)

- `docs/design-system/tokens.json` is the source of every colour, type family, spacing, radius and line width. `apps/desktop/src/shared/palette.ts` reads it and adds each colour token's job (`fill`, `line` or `text`). `styles.css` holds the tokens in its `:root` between `palette:start` and `palette:end`; `pnpm --filter @nikovirtala/draft-desktop palette:sync` writes them. Never edit that block by hand.
- Write a colour as `var(--token)` (or `currentColor` in an SVG). Never a hex, `rgb()` or a colour name in `styles.css` or a component; `test/palette.test.ts` fails.
- A token has one job: words (`color`) take `ink`, `text`, `muted` and the `*-word` tokens; hairlines, outlines and strokes take `line`, `line-strong`, `edge`, `idle-line`, `loop-mark` and the `*-mark` tokens; areas (`background`, `fill`) take the `*-fill` tokens, `moved-selected` and the grounds `page`, `surface`, `raised`, `titlebar`.
- A line around a box is `var(--hairline)` (0.5px); a dashed one is `var(--hairline-dashed)`. A strong mark is never thicker than 2.5px.
- A new token goes into `tokens.json`, then `ROLES` and `ROWS` in `palette.ts`, then `palette:sync`.
- Words are 4.5:1 on their surface. The only pairs below are `moved-word` on `page` and `moved-strong` on `moved-fill`, at 12.5px and up, weight 500, never the only sign.

## Meanings (built)

Purple is what moved or the agent's activity, green done, blue under way elsewhere, amber what waits on you (and a failure), a hairline not started, a dashed ring an open loop. A colour never takes another's meaning. A failure is `waiting-fill`, a dashed `waiting-mark` hairline, a cross and its words. There is no red.

## Where things may appear

A fill that is not on this list is a bug.

- **`moved-selected`:** the chosen option in a list or a control (the current context row, the "on" option of a switch `.map-range label.on`, the chosen map cell `.map-cell.selected`) and the main action button `.primary-button`. Words on it are `ink`. Built.
- **`moved-fill`:** a row or control under the pointer (`:hover`), and a "moved" chip or cell (`.where`, `.thread-chip.new`, `.pending.moved`, `.map-cell.active`). Built.
- **Never purple on** a block (`.stub`, `.thread-stub`, `.block-full`), a block's header (`.block-header`, `.stub-line`), the panel (`.panel`) or a window header (`.titlebar`), whether it is selected, clicked, expanded, focused or open in the panel. A thread open in the panel says so with the `.where` chip. Built, held by the **fills** check.
- **Keyboard focus:** a 1.5px `moved-mark` outline, no fill, through `:focus-visible` only (never `:focus` or `:focus-within`). Built: one rule at the top of `styles.css` covers every element; do not write another `outline`. Held by the **focus** check and `test/design-focus.test.ts`.
- **State fills** are chips, map cells and the notices that ask the person: `waiting-fill` (waits on you, failure), `done-fill`, `review-fill`, `moved-fill`. A whole block takes a state fill only when it asks the person for something, and only `waiting-fill` (`.prompt`, `.interrupt`, `.error`). Built.
- **Chips** join the one rule (`.pending, .chip, .thread-chip, .where, …`): pastel fill, word in the same hue, a transparent border, `--radius-chip`, weight 500 at 12.5px. Not started is a hairline with no fill; a failure is the dashed chip with a cross. Never write a chip's geometry again. Built.
- **Hairlines** around boxes, in `line` or `line-strong`. Boxes are told apart by fill and ground, not by a frame. Built.
- **Strong colour** (`*-mark`, `moved-strong`) only in marks (dots, rings, arcs, arrows, disc outlines, a check or a cross) and in words, never as an area. Built.
- **Marking a fill:** every element that carries a fill has `data-fill="<place>"` (`chosen`, `action`, `pointer`, `chip`, `cell`, `notice`, `ask`; two separated by a space), and the **fills** check fails one without a place that allows its colour. The table is `src/shared/fills.ts`, equal to the spec's A1. The main action button is `action`. Built.

## Anatomy, as built

Use the component that draws a part; do not draw it again.

- **Frame:** `App.tsx` (`MainWindow`, `BlockWindow`): `.titlebar`, `.workspace` (`section.left`, `PanelDivider`, `aside.panel`), `Footer`. Only `.conversation` and the body of `.block-full:not(.thread-view)` scroll; their parent chain keeps `min-height: 0`; a positioned child of a scroller needs the scroller to be `position: relative`.
- **Composer:** `Composer.tsx`, one `.primary-button` at most.
- **Message:** `MessageView.tsx`, user bubble on `surface`, the agent on the page in serif; its stubs in `.stubs`, its thread stubs in `.threads`.
- **Stub:** `StatusStub.tsx` (`.stub`, `.stub-line`, `.dot`, `.stub-status`, `.pending` with a tone), `ContextItemStub.tsx`. **Thread stub:** `ThreadStub.tsx`. Both use `useSelectable` and the block controls (`Icons.tsx`).
- **Block in the panel or a window:** `BlockContent.tsx` → `ThreadView`, `MapBlockFull`, `StatusBlock`; `.block-full` with a sticky `.block-header` on `page`.
- **Notices and interrupts:** `InterruptBlock.tsx`, `PromptCard.tsx`, `ProposalCard.tsx`, `Conclusion.tsx`, `NoticeBlock.tsx`, `NoteBlock.tsx`, `UnknownBlock.tsx`, `.error`.
- **Acceptance and checks:** `AcceptanceRequest.tsx` (evidence chips `.evidence-mark`), `CheckBlock.tsx` (`.interrupt.check`).
- **Map:** `MapBlock.tsx` (`MapView`, `MapRowView`, `ItemList`, `Moves`, the provenance line), `MapGraph.tsx` (`.graph-*`, `LayoutSwitch`), `map-arcs.ts` (`layoutArcs`). Arcs start and end on a cell's top edge, share one arrowhead, stack and never cross; a graph edge is `edge`, a cascade `moved-mark`, a wait `waiting-mark`; the legend names every mark.
- **Working and loading:** `Working.tsx` (`Working`, `GlobalWorking`, `WORKING_DELAY_MS`). One indicator, shown after 500 ms. No skeleton or second spinner (planned: loading states keep their size).
- **Footer:** `Footer.tsx`: folder, withheld sign-ins, `GlobalWorking`, the agent's state last.

## Motion

- Small. The only motion is the working ring, the caret and the actions' fade. No animation library.
- Every animation or transition goes in the one `@media (prefers-reduced-motion: reduce)` block at the end of `styles.css`. The ring, the caret and the actions' fade are in it; a new animation or transition adds its stop there, and `test/design-motion.test.ts` fails without it.
- The indicator waits `WORKING_DELAY_MS`; a part that loads keeps its size (planned).

## Accessibility checklist

- [ ] Words are at least 4.5:1 on their surface, except the two named pairs; `pnpm --filter @nikovirtala/draft-desktop test` passes the palette test.
- [ ] Colour is never the only sign: the state is in words; a failure has its cross and dashed outline; an open loop its dashed ring; the legend names a new mark.
- [ ] Every interactive element shows the 1.5px `moved-mark` ring on `:focus-visible`, and nothing shows it after a click.
- [ ] It works by keyboard in reading order, nothing traps focus, and the agent's controls stay last in the footer.
- [ ] A block is a `section` with an `aria-label`; an icon is `aria-hidden` and its button is named; a live state is `aria-live` or `role="status"`; a failure notice is `role="alert"`.
- [ ] Animations stop under `prefers-reduced-motion`, in the one block.

## Layout checklist

- [ ] The window does not scroll at a low and a wide size: only `.conversation` and a block body scroll, the title bar and footer stay.
- [ ] A long title, a long context name and a long word truncate or wrap inside their box (the top bar stays on one line).
- [ ] A hidden or absolutely positioned child sits inside a `position: relative` scroller.
- [ ] A chip uses the shared chip rule; a box's line is a hairline; a ground is `raised`, `page`, `surface` or `titlebar` as the anatomy says.
- [ ] A map's arcs do not cross, cover a label or differ in arrowhead; a graph label has its own box.
- [ ] A part that loads keeps its size (planned) and shows `Working`, never a second spinner.

## Pre-merge checklist

- [ ] Tokens only: no hard-coded colour, line width or font family; `palette:sync` leaves no diff.
- [ ] Fills only where the allow-list says, marked with `data-fill`; no purple on a block, a header, the panel or a window header.
- [ ] The app-wide e2e checks pass (`e2e/design-checks.ts`, run after every test): **window** (the window never scrolls), **fills** (a fill only where `data-fill` allows) and **focus** (one 1.5px ring, none after a click); and the unit tests `test/design-fills.test.ts` (hover), `test/design-focus.test.ts` and `test/design-motion.test.ts`. Do not add a narrower test for the same rule.
- [ ] Every screenshot in CI's comment on the pull request is compared with its design preview, and the differences are listed in the pull request description.
- [ ] A rule that changes starts in the design system's preview and is accepted from the picture first; the spec and this skill are updated in the same pull request.
- [ ] The accessibility and layout checklists above pass.
- [ ] A place where the code breaks the spec that you find and do not fix is added to the spec's Drift and opened as an issue (`ARK_AGENT=<your name> issues new …`).
- [ ] `pnpm check`, `adr verify` and `issues verify` pass. Commits and pull request text describe the change and name no person.
