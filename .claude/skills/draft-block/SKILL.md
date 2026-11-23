---
name: draft-block
description: Use when adding or changing a kind of item that shows in draft's conversation, such as a check, a wait from the change feed, a status stub or a new block, including its stub, its block in the panel and window, its chip and states, its place on the map, its e2e state and screenshot, and its design preview.
---

# draft block

A recipe for adding a new kind of item to the conversation. It follows how checks (?80, commits `2c5a5ae`, `2b8ed74`, `78ec84e`, `bc0b7ce`) and the change feed's waits (commits `ef4218d` to `f311ce1`) were added: the core first, then the window, then the end-to-end proof, with the design system moving first for anything that looks new. The rules for colour, fills, focus and layout are in [the design spec](../../../docs/design/draft-design-spec.md) and the `draft-design` skill: load it before you touch the renderer. The model is docs/model.md ("Core model: blocks and placements", "Kinds are state machines", "The map") and docs/implementation.md.

`<kind>` below is a lowercase singular name such as `check`. Each step is one small commit; the order keeps every commit passing on its own.

## 0. Decide the shape and the states

- **A timeline block** (a check, an interrupt, a note, a notice) is a `Block` the conversation lists in order, drawn by `ConversationView`. **A placeable block** (a status stub, a thread, the map) has an address and a placement (inline, minimized, panel or window) and is drawn by `BlockContent`. Decide which; a thing that waits on the person is usually a timeline block, a thing the person opens beside the conversation a placeable one.
- Write the states as a machine when it has one (`packages/core/src/machine.ts`, as `check.ts`, `thread.ts`, `interrupts.ts`), and say for each state: active, waiting (on whom), or terminal. A state that waits on the person is `waiting-fill`; a failure also has its cross and dashed outline; done is `done-fill`. A new meaning for a colour is not allowed.
- Open an issue (`ARK_AGENT=<your name> issues new …`) with Done when, and start it.

## 1. The design first

- Draw it in the design system before any code: add or change `docs/design-system/components/<Part>/preview.html` and its `README.md` (a stub in `PullRequestStub`, a chip in `StateChip`, a notice in `NoticeAndWorking`, evidence in `Evidence`, a map part in `Graph`), using tokens as CSS custom properties and the chips the rule gives. The picture is accepted before code applies it. A kind that fits an existing preview extends it (the feed's waits did, in `4f6f8ee`).
- Check the allow-list: which fills, which marks, which words. Nothing purple on a block.

## 2. The core: events, fold and conversation

In `packages/core/src` (a commit of its own, with its tests in `packages/core/test`):

- The events in `events.ts` and what folds them (a module like `check.ts` or `kiro-feed.ts`, pure, replayable from the log). A kind that takes a machine reuses it.
- The block in `conversation.ts` (what the timeline lists) and, for something that needs the person, its interrupt in `interrupts.ts`, so it counts in the attention order.
- Types the renderer imports go in a small module with an export in `packages/core/package.json` (`check-types.ts`, `kiro-feed-types.ts`), so the renderer never imports the fold.

## 3. Its place on the map: the kind registry

In `packages/core/src/map-kinds.ts`:

- A `KindDecl` (`CHECK_KIND` is the small example): `id`, `label`, `source: "machine"` with `statesOfMachine(...)`, or `source: "derived"` with a `derivation` and each state's `class` (`active`, `waiting` with `waitsOn`, `terminal`), `items(input)` that lists items with the path of states each went through and where each opens (`inConversation`, a stub, links), and `edges(input)` for the references it makes (`gates`, `part-of`, `supersedes`).
- Register it in the `mapRegistry` list at the bottom of the file, in the order of the rows. The registry refuses a kind with no states, a wait with no owner or no terminal state.
- The map needs nothing else: the graph's cluster, items and legend and the by-state row come from the declaration. `packages/core/test/map.test.ts` and `map-contract.test.ts` hold the counts; add the kind's.

## 4. The window: the block in the conversation

In `apps/desktop` (a commit of its own):

- Types in `src/shared/ipc.ts` (the `Block` union; the `InterruptCause` and its label in `src/shared/attention.ts` if it needs the person), and, if the person answers, the IPC channel in `ipc.ts`, `src/preload/index.ts` and `src/main/index.ts`.
- The component in `src/renderer/src/components/<Kind>Block.tsx` (a timeline block; `CheckBlock.tsx`, `InterruptBlock.tsx`) or, for a placeable block, a stub and a full block: the stub registers itself once with `ws.register({ info: { address, kind, home, depth, opens, title }, initial })`, uses `useSelectable`, shows `BlockControls` or the `.where` chip, and `BlockContent.tsx` gets a `case` for the kind (`StatusStub.tsx`, `ThreadStub.tsx`, `MapBlock.tsx`). Add the branch in `ConversationView.tsx`.
- Its parts, by the anatomy in the spec: a stub is a `.stub-line` with a dot, a title, chips and words; a block in the panel or a window is `.block-full` with a `.block-header` on `page` and a body; a state is a chip from the one chip rule (`.pending` with a tone), never new geometry; the person's answer is one `.primary-button` at most.
- Styles in `styles.css` use `var(--token)` only, join the shared chip selector list, and put any new animation in the reduced-motion block. Never fill the block with purple.
- A renderer test in `apps/desktop/test/renderer/<kind>.test.tsx` with `harness.tsx` (`check-view.test.tsx`, `session-feed.test.tsx` are the examples): its states, its words, its answer. Run the palette test.
- If it reads something slowly, show `Working` (one indicator, 500 ms), not a new one.

## 5. The proof: e2e state and screenshot

In `apps/desktop/e2e` (a commit of its own):

- A spec that drives the real app through the harness: `import { launchApp, shot, shotOf, test } from "./harness.ts"`, never `_electron`. Use the fake agent (`fake-acp-script-<kind>.json`, `test/fake-acp-agent.ts`) and the fake services in `@nikovirtala/draft-core/testing` (`FakeGithub`, the fake Kiro Remote) so nothing real is called. Check the states by their `data-testid`.
- Take a named screenshot per state (`shot(page, "k01-two-checks-need-you")`, `shotOf(locator, "fw02-…")`) and add each to `e2e/states.json` with the state's name, the screenshot, the design preview that draws it (the one from step 1) and its width. `test/e2e-states.test.ts` fails when a listed screenshot is not taken or a preview does not exist. The checks' `k01` to `k04` are taken but not listed yet (drift D7): do better.
- The app-wide checks (the window never scrolls; purple fills only where `data-fill` allows) run after every test once the harness has them (planned); a new part has to pass them without an exception.

## 6. Docs and issue

- A short section in `docs/implementation.md` (what it reads, what it shows, where it stops), as the checks and the feed have.
- If the colour table, a meaning or a rule changed, `docs/design/draft-design-spec.md` and the `draft-design` skill change in the same pull request.
- Close the issue with `issues close` and how each Done when was met, in the same change as the fix.

## 7. Verify

- [ ] `pnpm check`, `adr verify` and `issues verify` pass.
- [ ] CI's screenshot comment shows every new state beside its preview, and the differences are listed in the pull request.
- [ ] The pre-merge checklist of the `draft-design` skill passes: tokens only, fills only where the allow-list says, the app-wide checks, the spec and skill updated.
- [ ] A new kind of block is small enough for one pull request of a handful of commits (core, window, e2e, docs); a larger one is split by step and never stacked.
