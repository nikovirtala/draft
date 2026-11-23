# draft: Design Spec

> Living guide for how draft's window looks, feels and behaves. Change it through a pull request. It is not an ADR, see [Why this is not an ADR](#why-this-is-not-an-adr).

Status: first version. It describes the renderer (`apps/desktop/src/renderer/src`) as it is on `main` after #52, marks what is built and what is planned, and lists every place the code breaks a rule written here under [Drift](#drift). The palette itself is the design system's: [docs/design-system](../design-system/README.md) owns the colours, the type families, the spacing, the radii, the line widths and the previews, and this spec says where each may appear and how the parts of the window are put together from them.

Marks used below: **built** means the code does it today, **planned** means it is a rule or a part that no code or check carries yet.

## Table of contents

- [Vision](#vision)
- [Design principles](#design-principles)
- [Tokens](#tokens)
- [Meanings](#meanings)
- [Where things may appear](#where-things-may-appear)
- [Anatomy, as built](#anatomy-as-built)
- [Motion and loading](#motion-and-loading)
- [Accessibility](#accessibility)
- [Performance](#performance)
- [Lessons](#lessons)
- [Decisions](#decisions)
- [Open questions](#open-questions)
- [Drift](#drift)
- [Roadmap](#roadmap)
- [Why this is not an ADR](#why-this-is-not-an-adr)

## Vision

draft is a conversation-first agent UI that is cognitively easy. The person talks, the agent answers, and everything the agent touches (a session, a pull request, a decision, a check, the map) comes into the conversation as a block they can leave where it is, open beside it or pull into a window. The screen asks for as little thought as it can: one conversation column, one panel, a footer that stays quiet.

Two habits keep it easy. Every model is simple: a block is inline, minimized, in the panel or in a window (docs/model.md, "Core model: blocks and placements"), and a kind is a row of states (docs/model.md, "The map"), so a new thing costs a registration and not a new idea. And a colour assigned a meaning never changes it: purple is what moved or the agent's activity, green what is done, blue what is under way elsewhere, amber what waits on you, and nothing else borrows them.

## Design principles

- **P1. A colour means one thing, everywhere, always.** The meanings are in the design system's README and are listed under [Meanings](#meanings). A meaning never takes another's colour, and a colour never changes its meaning along the way.
- **P2. Pastel fills carry the state.** The fill is the colour people see. Strong colour appears only in marks (dots, arcs, arrows, a check, the working ring) and in words.
- **P3. A rule about where a colour may appear is a list of places, not a sentence.** Each fill has an allow-list ([Where things may appear](#where-things-may-appear)); anything not on it is wrong, and a check across the app, not one component's test, holds it.
- **P4. Never colour alone.** The word always names the state. A failure is also a cross and a dashed outline, an open loop a dashed ring.
- **P5. Hairlines.** Every line around a box is the hairline (0.5px, one device pixel on a Retina screen), in sand. Boxes are told apart by their fill and their ground, not by their frame. The only thick strokes are marks, never above 2.5px.
- **P6. The window never scrolls.** The title bar and the footer stay where they are. Only the conversation and the body of a panel or a window scroll, each inside its own box.
- **P7. One model per thing.** One chip (`StateChip`), one working indicator (`Working`), one ring for focus, one block frame (stub, header, body). A new part reuses these before it adds a rule.
- **P8. Readable words.** Every text colour is at least 4.5:1 on the surface it is drawn on, except the two pairs the design system accepts by name.

## Tokens

`docs/design-system/tokens.json` is the source of every value: colours, type families and styles, spacing, radii and line widths. Nothing else holds a value. **Built:**

- `apps/desktop/src/shared/palette.ts` reads `tokens.json` and adds the job of each colour token (`fill`, `line` or `text`, the surfaces a text token is drawn on, `STRONG`, `ACCEPTED_BELOW_AA`) and the table of colour to meaning (`ROWS`). It never types a colour.
- `renderer/src/styles.css` holds the tokens in its `:root`, between `/* palette:start */` and `/* palette:end */`. `pnpm --filter @nikovirtala/draft-desktop palette:sync` (`apps/desktop/scripts/sync-palette.ts`) writes that block and the table in docs/implementation.md from `rootBlock()` and `docTable()`; `apps/desktop/test/palette.test.ts` fails when either differs, when a rule outside `:root` writes a literal colour, when a custom property is used that `:root` does not define, when a token is used for another job than its own (words take text tokens, `border`, `outline` and `stroke` take line tokens, `background` and `fill` take fill tokens), when a strong mark is thicker than 2.5px, when a box line is not a hairline, and when a text pair is below 4.5:1 other than the two accepted.
- A component writes a colour as `var(--token)` in `styles.css`, or as `currentColor` where an SVG inherits one. It never writes a hex, `rgb()` or a colour name.
- To add a token: add it to `tokens.json` (name, value, usage) and give it a role in `ROLES` in `palette.ts`, run `palette:sync`, and add it to exactly one row of `ROWS`. A new meaning gets a fill, a mark and a word.

Type, spacing, radii and line widths come the same way (`--font-sans`, `--font-serif`, `--font-mono`, `--space-1` to `--space-4`, `--radius-chip`, `--radius-card`, `--radius-round`, `--hairline`, `--hairline-dashed`). Today only the chip's geometry is read from `tokens.json` by a test; other sizes in `styles.css` are written as px, see [Open questions](#open-questions).

## Meanings

The table of colour to meaning is the design system's ([docs/design-system/README.md](../design-system/README.md), "Meanings"), printed from `ROWS` in docs/implementation.md, "Colour, and the indicator that draft is working". It is not copied here, so it cannot disagree. In short, each meaning has up to three steps and a token is used for its own step only:

| Meaning | Fill | Mark | Word |
| --- | --- | --- | --- |
| Moved, the agent's activity | `moved-fill`, `moved-selected` | `moved-mark` | `moved-word`, `moved-strong` |
| Done, settled | `done-fill` | `done-mark` | `done-word` |
| Under way elsewhere | `review-fill` | `review-mark` | `review-word` |
| Waits on you, and a failure | `waiting-fill` | `waiting-mark` | `waiting-word` |
| Not started, an open loop | none | `idle-line`, `loop-mark` | `muted` |
| The ground and its hairlines | `page`, `surface`, `raised`, `titlebar` | `line`, `line-strong`, `edge` | `ink`, `text` |

Ground, for orientation (**built**): the window is `page`; the title bar is `titlebar`; a stub, a thread stub, a message's code block and the graph stage are `raised`; the panel, a block in the panel or a window and its header are `page`; menus, the composer's field and the user's message bubble are `surface`; titles, names and links are `ink`, body words `text`, secondary words `muted`.

## Where things may appear

This is the allow-list. A fill that is not here is a bug. **Built** lists the selectors that carry each fill today (read in `styles.css`); **planned** is the way it will be held. Every rule below is one the code follows, except where [Drift](#drift) says otherwise.

### Marking a fill

- **A1. Planned: every element that carries a state fill is marked `data-fill="<allowed place>"`,** with one value per place in the lists below (`chosen`, `pointer`, `chip`, `cell`, `notice`). An app-wide e2e check reads every element whose computed background is a state fill and fails on one without a mark, or whose mark does not allow that colour. No code sets `data-fill` today; the design-system session is adding the check, see [Open questions](#open-questions).

### Purple: `moved-selected` and `moved-fill`

- **A2. `moved-selected` (fill) is for the chosen option in a list or a control, and for the main action button.** Built: the context you are in in the Contexts menu (`.context-item-button[data-current="true"]`), the "on" option of the map's range and layout switches (`.map-range label.on`), the chosen map cell (`.map-cell.selected`), and the main action button (`.primary-button`: Send, Passed, Accept, Switch). The words on it are `ink`.
- **A3. `moved-fill` is a row or a control under the pointer, and the fill of a "moved" chip or cell.** Built under the pointer: `button.icon:hover`, `.branch-agent:hover`, `.attention-open:hover`, `.context-item-button:hover`, `.map-range label:hover`, `.panel-divider:hover`, `.graph-node:hover` (55% on transparent). Built as a state fill: the chips `.where`, `.thread-chip.new`, `.thread-chip.working`, `.pending.moved`, `.context-badge`, `.agent-badge.active`, the legend chip `.graph-legend li.moved`, the cell `.map-cell.active`, and the item disc `.graph-dot.moved`.
- **A4. Purple never fills a block, a block's header, a panel or a window header.** A block is a stub (`.stub`), a thread stub (`.thread-stub`), a block in the panel or a window (`.block-full`), their headers (`.block-header`, `.stub-line`), the panel (`.panel`) and the title bar. It stays on its own ground (`raised` for a stub, `page` for a header and a panel, `titlebar` for the title bar) whether it is selected, clicked, expanded, focused or open in the panel. A thread open in the panel says so with its "In the panel" chip (`.where`) and nothing else. A unit test (`test/renderer/no-purple-blocks.test.tsx`) holds this for the block selectors it names, and the e2e test "a selected stub is never filled" for one stub; one place breaks it, see [Drift](#drift) D1.
- **A5. Keyboard focus is a 1.5px `moved-mark` ring, no fill, through `:focus-visible` only,** so a click shows nothing. Built for blocks (`:is(.stub, .thread-stub, .block-full):focus-visible`, `outline: 1.5px solid var(--moved-mark)` with a 1px offset); the other focus rules are 2px, some use `:focus-within` and two draw a fill: see D2 and D3.
- **A6. `moved-mark` is for icons, arcs, arrows, the caret and the working ring; `moved-word` is pastel words on the page; `moved-strong` is a chip's word and, planned, one small badge with a count in the page colour.** Built: the arrows of the by-state map (`.map-arrows path`), a cascade edge (`.graph-edge.cascade`), the caret (`.caret`), the working ring (`.working-ring`), the working label (`.working-label`, `moved-word`). The count badge is not built.

### State fills: chips, map cells, notices

- **A7. A state chip is a pastel fill, the word in the same hue, no outline (a transparent border), `--radius-chip` corners, weight 500 at 12.5px.** One rule gives the geometry to every chip (`.pending, .chip, .thread-chip, .where, .context-badge, .agent-badge, .evidence-mark, .map-stale, .stub-status.pr-state, .graph-legend li`); a new chip joins that list and never writes its own geometry. Built tones: `waiting-fill` with `waiting-word` (`.pending`, `.chip`, `.thread-chip.waiting`, `.agent-badge.paused`, `.map-stale`, `.evidence-pending`), `done-fill` with `done-word` (`.pending.good`, `.evidence-green`, `.pr-merged`), `review-fill` with `review-word` (`.pending.review`, `.pr-open`), moved as in A3. Not started is no fill and an `idle-line` hairline (`.thread-chip`, `.pr-closed`, the legend's `li.idle`); an open loop no fill and a dashed `loop-mark` hairline (`li.loop`).
- **A8. A failure is the waiting fill with a dashed `waiting-mark` hairline (`--hairline-dashed`), a cross and its words.** Built: `.pending.bad`, `.evidence-red`, `.error`, `.context-folder.missing`. It has no colour of its own and no red.
- **A9. A map cell is a chip by state class.** Built (`.map-cell`): `active` takes `moved-fill`, `terminal` takes `done-fill`, a cell where something waits on you (`.lit`) takes `waiting-fill`, an empty cell has no fill and an `idle-line` hairline, and the chosen cell is A2. The count is in the cell's words, not only its colour.
- **A10. A whole block may be filled with a state fill only when it asks the person for something, and only with `waiting-fill`.** Built: the permission prompt and proposal (`.prompt`), an interrupt and a check (`.interrupt`, `.interrupt.check`), a failure notice (`.error`). A closed interrupt drops the fill (`.interrupt.closed`). No other block has a state fill: a stub's state is its dot, its chips and its words.
- **A11. Notes and notices are not state fills.** A note from draft (`.generic.notice`), an event this build does not understand (`.generic`) and the log-recovered notice are `raised` with a dashed `line-strong` hairline and `muted` words.

### Hairlines and strong colour

- **A12. Lines around a box are `--hairline` in `line` or `line-strong`; a dashed line (a failure, an open loop, a people-only message, a note) is `--hairline-dashed`.** Edges and tethers of the graph are `edge`. The only thick strokes are marks: a graph edge or cascade 1.6px, a state arc up to 3px (`strokeOf` in `map-arcs.ts`), the settled ring of a cluster 2.5px, the working ring 2px; none above 2.5px except the arcs, which draw only on the map's own strip and are the one accepted exception, see [Open questions](#open-questions).
- **A13. Strong colour (`*-mark`, `moved-strong`) appears only in marks (dots, rings, arcs, arrows, outlines of discs, a check or a cross glyph) and in words,** never as the fill of an area.

## Anatomy, as built

Every part below lists what draws it, its states, and what it may and may not carry. Colour rules refer to the allow-list above.

### The frame

- **Parts.** `MainWindow` and `BlockWindow` in `App.tsx`: the title bar (`header.titlebar`: the brand, `ContextBar`, the conversation's title, `AttentionBar`), the workspace (`.workspace`: `section.left` with the conversation and, when a block is in the panel, `PanelDivider` and `aside.panel`), and the `Footer`. A window for one block has the title bar (`.window-bar`) and the block.
- **Scrolling.** Only `.conversation` (`overflow-y: auto`, `position: relative` so hidden radios do not lengthen the document) and the body of a block in the panel or a window (`.block-full:not(.thread-view)`, with its header sticky) scroll. `html`, `body` and `#root` are `height: 100%`; `.app` is a flex column; `.workspace` has `min-height: 0`. Horizontal scroll is allowed inside a code block, a table and a map row (`.map-row-scroll`) only. The test "the window never scrolls" in `e2e/map.spec.ts` holds it for a long conversation and a long map; the app-wide check is **planned**.
- **Title bar.** `titlebar` ground, `line` hairline below, `-webkit-app-region: drag` with the controls set to no-drag. It carries words and the attention bar and no state fill (D1).
- **Panel.** 8px divider (`.panel-divider`, resizable by pointer and keyboard, double-click resets) and a column of at least 380px and 44% by default. The panel holds one block at a time, on `page`.
- **Footer.** See [The footer](#the-footer-and-its-quiet-global-state).
- **Window of one block.** The same block frame as the panel (`.block-full`), alone under the title bar.
- **States.** Conversation only; conversation and panel; focus (`data-focused`, the attention bar says "In focus … Esc leaves"); booting (`BootingWindow`); trust step (`TrustStep`); refused (`.refused`).

### The composer

- **Parts.** `Composer.tsx`: `form.composer-wrap` with a `textarea` (`surface`, `line-strong` hairline, `field-sizing: content`), the send button (`.primary-button`, "Send", "Aside" while Alt is held), and, once a second person has spoken, the hint line (`.composer-hint`, `kbd`).
- **States.** Active, paused (placeholder says it is not listening), busy (Send disabled, an aside still goes), empty (Send disabled).
- **May carry.** The main action button (A2) and the focus ring (A5). **May not carry** a state fill, a chip or a second action button.

### A message

- **Parts.** `MessageView.tsx`: `article.message.user` (right, `surface` bubble in sans) or `.message.agent` (the page, in serif), its Markdown body (`Markdown.tsx`), the stubs it mentions (`.stubs`), the thread stubs branched from it (`.threads`), and its actions (`.message-actions`: branch, copy reference), shown on hover and on focus within.
- **States.** People only (`.aside`: dashed hairline, a label), streaming (`StreamingMessage` with a caret), mentioned items.
- **May carry.** Stubs and thread stubs. **May not carry** a fill other than the user bubble's `surface`.

### A stub and a thread stub

- **Parts.** A status stub (`StatusStub`, `.stub.status-<status>`): a `.stub-line` with a dot (`.dot`, the mark of the state), the title (`ink`, with the reference in mono), the `Working` indicator while it is read, the status word or chip (`.stub-status`, `.pr-state` for a pull request), more chips (`.pending` with a tone: `bad`, `good`, `wait`, `review`, `moved`), then the block controls or the "In the panel" chip. Expanded, it adds `.stub-details`. A thread stub (`ThreadStub`, `.thread-stub`) has the `↳` mark, the title, the agent, chips for working, new messages, waiting on you, state and artifacts, its conclusion and, inline, its last message. The map's stub (`MapStub`, `.stub.map-stub`) holds the map inline.
- **Dot colours.** Idle `idle-line`, running `moved-mark`, awaiting permission and failed `waiting-mark`, merged `done-mark`, open `review-mark`.
- **States.** Minimized (one line), expanded (inline details), away (in the panel or a window, with the `.where` chip), selected (`data-selected`), focused.
- **Pull request chips (built, docs/design-system `PullRequestStub`).** Merged is the done chip with a check, open is the review chip, a review requested from you is a wait chip, a failing check or a conflict is a failure chip (A8), closed without merging is the not-started hairline with a cross. What Kiro Remote decided shows as a wait chip (the words "Waiting for" and the pull request's reference), a moved chip ("Woke: …") and, when the feed stopped at something unreadable, a wait chip "Waits may be out of date".
- **May carry.** Dots, chips, words, block controls. **May not carry** a purple or other state fill on the stub itself (A4, A10), a second dot, or a colour as the only sign of its state.

### A block in the panel and in its own window

- **Parts.** `BlockContent` picks `ThreadView`, `MapBlockFull` or `StatusBlock` by kind, and falls back to a generic block that names the kind it does not know. Each is `section.block-full` with a `header.block-header` (`page` ground, `line` hairline, sticky at the top of the scrolling body) and a body. A thread block's header also holds the agent select, `AgentState`, Wrap up and End thread, and its body is a `ConversationView` with its own composer.
- **States.** `status-running` and `status-awaiting_permission` size to their content, others fill the column. Selected and focused by keyboard (A5). Open in a window: the window's title bar names the block and where it came from (`windowTitle`).
- **May carry.** Header controls, words, chips, the focus ring. **May not carry** purple on the block or its header (A4).

### Notices and interrupts

- **Parts.** An interrupt (`InterruptBlock`, `.interrupt`): a label chip (`.chip` on the interrupt's own fill, no chip box), its age, a body by cause, and the person's buttons. A permission prompt (`PromptCard`, `.prompt`), a proposal (`ProposalCard`), a conclusion to confirm (`ConclusionCard`), a failure notice (`.error`, with a cross and `role="alert"`), a note (`NoteBlock`), the log-recovered notice (`NoticeBlock`), an unknown event (`UnknownBlock`) and the ended note of a thread (`EndedNote`).
- **States.** Open (shown where you are: in focus, or when nothing is), settled and cleared (`.interrupt.closed`: no fill, one line, always shown as history), counted only (outside the focus).
- **May carry.** `waiting-fill` (A10) and the person's buttons (one `.primary-button` at most). **May not carry** red, an icon as the only sign, or purple.

### Acceptance requests and checks

- **Parts.** An acceptance request (`AcceptanceBody`, `AcceptanceActions`): a title and an Open link, one evidence row per check (`.evidence`: a chip, the check's name in `ink`, its detail in `muted`), what accepting does and whether it can be undone, and three answers (Accept as the main button, Request changes, Reject, each with words). A check (`CheckBlock`, `.interrupt.check`): a state chip (`Waiting for you`, `Passed`, `Failed`), the title, what it came from, "Reason and steps" (every command with a Copy button, what the person should see), the decisions it gates (`.check-gate`, which hosts that decision's request once it passes), a note field and Failed and Passed.
- **Evidence chips.** Passed is `done-fill`, Failed is the failure chip (A8), Waiting is `waiting-fill`. The words Passed, Failed and Waiting are always written.
- **States.** Requested, passed, failed. Buttons say "Working…" while an answer is sent.
- **May carry.** `waiting-fill` on the request and the check as a whole (A10), chips for evidence. **May not carry** a green block for a passed check: the answer is a line of words and the chip.

### The map

- **Parts.** `MapView` (`MapBlock.tsx`): a summary line ("N open · M waiting on you", `aria-live`), the `Working` ring while it reads GitHub, two switches (`.map-range`: the window "Last hour", "Last day", "Everything", and the layout "Graph", "By state", `LayoutSwitch` in `MapGraph.tsx`), the layout, the open cell's list (`.map-items`), "Recent moves" (`.map-moves`), one provenance line per feed (`.secondary`, "Built from the (feed) feed, cursor N", with "out of date: …" when the feed stopped), and the problems line.
- **The graph (`MapGraph.tsx`, `.graph-*`).** A stage (`.graph-stage`, `raised`, `line-strong` hairline, `--radius-card`) with a panned and zoomed plane. A cluster is a disc (`.graph-disc`, `surface`, `line-strong` hairline) sized by its count, its count in `ink`, its name under it in `muted`, and a `done-mark` ring for the settled share (`.graph-ring`, 2.5px). A cluster where something waits on you takes `waiting-fill` and a `waiting-mark` hairline (`.graph-disc.waiting`). A stepped-out item is a small disc in its state's fill with a mark hairline (`.graph-dot` with `.moved`, `.settled`, `.waiting`), on a dotted tether (`.graph-tether`, `edge`). An open loop is a dashed `loop-mark` ring (`.graph-loop`). An edge is `edge` and as wide as the references it carries (`.graph-edge`); a cascade is a `moved-mark` arrow (`.graph-edge.cascade`, `.graph-arrowhead`); a session waiting for a pull request is a `waiting-mark` edge at the weight of a cascade (`.graph-edge.waits`). Names are boxes the layout keeps clear of nodes and of each other (`layoutLabels`). The legend is chips (`.graph-legend li`) and names every mark in words. Crumbs and Escape zoom out; zoom and pan change the viewport and never move a node (`map-viewport`).
- **By state (`state` layout, `MapRowView`).** One row for each kind and one cell for each state, left to right from start to terminal, each cell a chip by state class (A9) with its label, its count and what waits ("2 for you") or its notes. The arcs between cells are a strip above the row (`Arrows`, `layoutArcs` in `map-arcs.ts`): each starts and ends on a cell's top edge, they are `moved-mark`, share one arrowhead size, are stroked by how many items made the move, and stack: an arc that holds another is drawn higher, and ends that meet in a cell are spread along its edge so none crosses another (`test/renderer/map-arcs.test.ts` measures it).
- **States.** Empty (a sentence from the registry's kinds), reading, a row "from before" (`.map-stale`) or "states derived" (`.map-derived`), a lit cell, the chosen cell with its list, a stale feed.
- **May carry.** State chips and marks only. **May not carry** a block fill, an arc that crosses another or covers a cell's label, an arrowhead of another size, or a mark whose meaning rests on colour (the legend and the labels say it).

### Loading and working indicators

- **Parts.** `Working` (`Working.tsx`): one `span.working` with a ring (`.working-ring`: a track of `moved-mark` at 25%, a `moved-mark` arc, 14px, 2px) and its label, which is `visually-hidden` unless `showLabel` is set (`.working-label`, `moved-word`). `role="status"`, named by `label`.
- **Where.** An agent turn at the foot of its conversation (`place="turn"`) and in a thread stub's chip; a stub being read, beside its title (`stub`); the map reading GitHub, in its bar and its minimized line (`map`); a window opening its context (`BootingWindow`, `context`); the footer's quiet global place (`GlobalWorking`, `global`).
- **Other loading text.** The map says "Reading the log…" before its first snapshot and "…" on its minimized line; these are plain words, not the indicator (see [Open questions](#open-questions)). A button that sends says "Working…".
- **May not.** A second spinner, a skeleton, a progress bar or a pulse: **planned** loading states are in the [Roadmap](#roadmap).

### The footer and its quiet global state

- **Parts.** `Footer.tsx`, `.footer` (`line` hairline above, `muted` 12px words, wraps): the folder the agent works in (`ContextFolder`), the one line about withheld sign-ins (`AgentEnvironment`, a `details` that opens upward over the conversation), `.footer-activity` with `GlobalWorking`, and at the right end the agent's name, its state and Pause or Play (`AgentState`, last in the keyboard order).
- **States.** Agent active (`.agent-badge.active`, a moved chip) or paused (`.agent-badge.paused`, a wait chip); working shown or empty.
- **May carry.** Words, two chips and the indicator. **May not carry** a block, an alert or a fill other than those chips. The top bar keeps what is used all the time and the footer what is rarely acted on.

## Motion and loading

- **M1. Built: motion is small and means work.** The only moving things are the working ring (`working-turn`, 0.9s linear), the streaming caret (`blink`, 1s) and the message actions' fade (0.1s). No page transition, no hover motion on blocks, no animation library.
- **M2. Built in part: every animation stops under `prefers-reduced-motion`, in the one block at the end of `styles.css`.** The block holds the working ring (it stays half drawn: still there, never turning). The caret and the actions' fade are not in it: D4.
- **M3. Built: the working indicator shows `WORKING_DELAY_MS` (500ms) after the work starts and goes the moment it ends,** so quick work never flickers. One constant, every place.
- **M4. Planned: a part that loads has a loading state that keeps its size,** so nothing jumps when it arrives (the map's "Reading the log…" line, a stub before its first read, a thread before its messages). The Roadmap has the slice.
- **M5. Built: the window opens on the page colour** (`PAGE_BACKGROUND` from `palette.ts`), before the page is drawn.

## Accessibility

- **C1. Contrast.** Words are at least 4.5:1 on the surface they are drawn on (`contrast` and `TEXT_CONTRAST` in `palette.ts`, held by the palette test). Two pairs are below on purpose and named: `moved-word` on `page` (2.5:1) and `moved-strong` on `moved-fill` (4.0:1). They are used at 12.5px and up, weight 500, and never as the only sign. Marks are not text and have no floor. Recompute a number from the final tokens before quoting it.
- **C2. Never colour alone.** A state is named in words (a stub's status, a chip, a cell's label with its count, `aria-label`s that say "2 waiting on you"). A failure has a cross and a dashed outline; an open loop a dashed ring. The graph's legend names every mark.
- **C3. Focus.** Every interactive element shows the 1.5px `moved-mark` ring on `:focus-visible` (A5). No `outline: none` without it.
- **C4. Keyboard.** Everything works by keyboard in reading order: blocks are `tabindex` stops that select on focus; the divider resizes with arrow keys; the graph is a `role="application"` whose nodes are buttons, with Cmd plus or minus to zoom, Cmd 0 to fit, arrows to pan and Escape to zoom out; the attention list's items are buttons; Cmd or Ctrl and a period enters and leaves focus, Escape leaves. The agent's controls are last.
- **C5. Names and live regions.** A block is a `section` with an `aria-label`; the map summary, the streaming message and the working indicator are live regions (`aria-live`, `role="status"`); a failure notice is `role="alert"`; icons are `aria-hidden` and their buttons are named.
- **C6. Reduced motion.** As M2.
- **C7. Headings and words.** Titles are `ink`; a block's title is in its header. Words are in plain language and say what happened.

## Performance

Where it applies today, and **built** unless marked:

- Only the stubs on screen are polled: `useVisibleStubs` reports the elements with `data-stub-target` that intersect the window, and the main process polls those.
- The map is asked for again only when the log head moves (`mapHead`), and the main process reads GitHub only while a map is on screen (`setMapVisible`).
- The graph's layout stays put and is reused per zoom (`useLayout`, `useLabels`), so a refresh moves nothing and does not recompute from scratch.
- A new part adds no polling of its own, no timer that runs while it is not on screen and no layout that moves what the person has learned. **Planned:** a budget for the renderer's start time and for a long conversation; none is measured yet.

## Lessons

Each is a rule with its reason.

- **L1. Pastel fills carry state; strong colour only in marks and words.** A strong fill on an area reads as an alarm and hides the words; the pastel fill is the colour people see, the strong one only points at it.
- **L2. A rule about where something may appear is an allow-list checked across the app, not one component's test.** A selection rule written as one prose line ("the block in focus: moved-selected") was right for a row and filled whole blocks with purple, and the tests that existed checked the component that had been fixed, not the next one. Name the places; check every element.
- **L3. A design rule changes in the preview first and is accepted from the picture.** The preview in `docs/design-system/components` is where a rule is seen. Code follows the accepted picture, never the other way round; if the code needs a rule the preview lacks, the preview gets it first.
- **L4. Red and green chips were ugly: a chip is pastel, no outline, 7px corners, weight 500.** The board's chip, with draft's own font and darker words only as far as 4.5:1 needs. A failure has no colour of its own.
- **L5. Hairlines.** A 1px line in a strong colour around everything turns a calm page into a form. Half a pixel in sand, and boxes told apart by fill.
- **L6. The window must never scroll.** A visually hidden radio positioned against the window lengthened the document and the whole window scrolled past the conversation. A scroller is also the containing block of what is positioned inside it, and only the conversation and a panel body scroll.
- **L7. Arcs stack and never cross.** Arcs that start and end on a cell's top edge, with ends spread along it and an arc that holds another drawn higher, can always be drawn without a crossing unless their ends interleave; the layout measures it.
- **L8. A colour assigned a meaning never changes it.** A reader learns the palette once. The moment purple means "selected" in one place and "the agent did it" in another, both are lost; that is why the chosen option and what moved are different steps of one hue.
- **L9. No attribution to a person in repo text.** Commit messages, pull request titles and descriptions, docs, code comments and tests describe the change ("the palette in docs/design-system", "after the Wisteria Lily theme"), never who asked for it or accepted it. Decisions below name the pull request that made them.

## Decisions

Answers to earlier questions, with the reason, so later work does not reopen them. Dated, with the pull request that made them.

1. **2026-11-23, #43: the palette is `tokens.json`, written once.** A value typed twice drifts; the test fails when `styles.css` or the doc differs.
2. **2026-11-23, #48 then #52: purple is layered, and a block is never filled with it.** #48 marked the block in focus with `moved-selected`; #52 reversed it because a selected stub with a map was purple from edge to edge. The chosen option of a list or a control and the main action button are the only `moved-selected`; a row under the pointer is `moved-fill`; keyboard focus is a ring.
3. **2026-11-23, #52: the window never scrolls.** The conversation and a panel body scroll inside their boxes (L6).
4. **2026-11-23, #52: arcs between states start and end on the cells, share one arrowhead and stack (L7).**
5. **2026-11-23, #51: what Kiro Remote's change feed says shows in the stub, the map and the provenance line,** in wait and moved chips, an edge and a "Built from" line, and nothing rests on colour alone.
6. **2026-11-23, this PR: a whole block may take `waiting-fill` when it asks the person (A10).** The code does it for interrupts, permission prompts, checks and failure notices, and the design system's NoticeAndWorking preview draws a failure notice that way. The reason is that what waits on you is the one thing the person should not miss. To confirm; the alternative is a chip only.
7. **2026-11-23, this PR: the state-fill marking and the app-wide checks are written as planned.** #53 says #52 adds the window and purple-fill checks to the e2e harness; `main` has narrower tests (`e2e/map.spec.ts`, `test/renderer/no-purple-blocks.test.tsx`) and no `data-fill`. This spec links the checks by name once they land.
8. **2026-11-23, this PR: the skills are kept identical in `.kiro/skills` and `.claude/skills`, as adr and issues are.**

## Open questions

1. **`data-fill` values and the app-wide check.** The values in A1 (`chosen`, `pointer`, `chip`, `cell`, `notice`) are this spec's proposal. The design-system session is writing the check; rebase on it and use its names.
2. **A failed Kiro session.** Its stub shows a `waiting-mark` dot and the word "Failed", not the failure chip (A8). Should a failed session be a failure chip?
3. **Type sizes.** `tokens.json` has four text styles, a message style and a code style; `styles.css` writes 11px, 11.5px, 12px, 12.5px, 13px, 13.5px, 14px, 15px and 26px directly. Should every size be a token?
4. **Loading text.** "Reading the log…" and "…" are words, not `Working`. Should they be?
5. **The chip's hover.** docs/implementation.md says a hover darkens a chip and outlines it in its own colour; the CSS draws a 1px inset line in `currentColor`, which is not a hairline. Keep it as the one exception or make it a hairline?
6. **Arcs above 2.5px.** A state arc is up to 3px (`strokeOf`), above the 2.5px a strong mark may be. The palette test does not see SVG attributes. Lower the cap or allow it?
7. **Dark theme.** The window is `color-scheme: light` only. No dark theme is planned.
8. **A budget for the renderer.** Which numbers (start time, a long conversation, a large map) and how they are measured.

## Drift

Every place the code breaks a rule above today. Each is also an issue (ids from the issues tool; the issue says the same).

| Id | Rule | Where | Issue | Type |
| --- | --- | --- | --- | --- |
| D1 | A4: purple never fills a window header | `styles.css:1019`, `.app[data-focused="true"] .titlebar` is `moved-fill` while a block is in focus | wgytkvq6 | bug |
| D2 | A5, C3: the ring is 1.5px through `:focus-visible` | 2px at `styles.css:443`, `:1475` (and `:focus-within`, which shows after a click), `:1588`, `:1774`, `:1789`, `:1945` | tny598kt | bug |
| D3 | A5: focus is a ring, never a fill | `styles.css:805-807` (`.panel-divider:focus-visible`) and `:1145-1147` (`.attention-open:focus-visible`) | 2s98f7nk | bug |
| D4 | M2: every animation stops under reduced motion | `.caret` (`styles.css:284-292`) and `.message-actions` (`:967-968`) are outside the block at `:2150` | edenwvc1 | bug |
| D5 | Meanings: `moved-selected` is not for a block | `docs/design-system/tokens.json`, usage of `moved-selected` says "the block in focus", copied into `palette.ts` | vr20g4rb | chore |
| D6 | Meanings: the footer is `titlebar` | `tokens.json` says the title bar and the footer; `styles.css:592` draws the footer on `page` | vr20g4rb | chore |
| D7 | L3: every state has a preview to be compared with | `e2e/states.json` maps the frame, the composer and the map's cells to previews that draw other things, and does not list the checks' screenshots `k01` to `k04` (`e2e/checks.spec.ts`) at all | t9s857yn | chore |

Seven items, six issues (D5 and D6 share one).

## Roadmap

The next design slices, one coherent slice each, each a small pull request (a handful of commits), never stacked:

1. **Drift fixes, part 1: focus.** D2 and D3 (one ring rule for the whole renderer, `:focus-visible`, 1.5px) and D4 (the reduced-motion block), with a test that lists every `outline` and every animation in `styles.css`.
2. **Drift fixes, part 2: the title bar and the tokens.** D1 (say the focus in words on the title bar) and D5, D6 (the design system's usage text), after the picture is accepted.
3. **The marked fills and the app-wide checks.** `data-fill` on every state fill (A1), read by the harness checks that the design-system session lands; links by name here.
4. **Previews for what has none.** D7: the frame, the composer, a message, a thread stub, a check, a prompt, the by-state map's cells and arcs; `states.json` names them.
5. **Loading states.** M4: a part that loads keeps its size (the map before its first snapshot, a stub before its first read), in the preview first.
6. **The map's by-state lens as a lens.** The by-state layout exists (`state`); the model's lenses (only what is moving, waiting on me, open loops) are planned and each is a switch option (A2) over the same cells.
7. **The count badge.** The one small `moved-strong` badge with a number (A6), for what changed since the person last looked.

The first slice is the first item.

## Why this is not an ADR

The ADRs in `docs/adr/decisions/` record architecture decisions with their alternatives, made once and superseded rather than edited, and `adr` generates their index. This spec is a guide to how the window looks and behaves: it changes as the renderer is built, it holds rules and a list of where the code breaks them rather than one decision between options, and a change to it goes through a pull request like any other doc. A decision in it that is architectural (how the palette is generated, how a check reads the DOM) belongs in an ADR and is linked from [Decisions](#decisions) when it exists. The two skills that carry it to an agent are in `.kiro/skills/draft-design` and `.kiro/skills/draft-block`, and are kept identical in `.claude/skills`.
