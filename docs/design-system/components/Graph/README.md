# Graph

The map's graph in the palette: a quiet ground, and a trace over it. It replaces the discs sized by count.

## The quiet ground

Every item is a dot at its own place, so how much there is and where it piles up is seen before anything is read. The first state has 60 items in 6 kinds: 55 dots and 5 pills.

- **A dot** is 4px across, the same for every state (to confirm, spec open question 12), in its state's `*-mark`: `moved-mark`, `waiting-mark` and `review-mark` at full strength; `done-mark` (settled) and `idle-line` (not started) at 40%.
- **A kind** is the region its dots gather in. It has no disc and no outline. Its mark (a small outline shape, in `ink`), its name and its count, in `muted`, sit at its edge. The name and count are not part of the ground, so they never fade.
- **A pill** is a named item lifted out of the ground: StateChip-shaped, `raised`, a `line-strong` hairline, `--radius-chip`. It holds the kind's mark, the name in `ink` and the state's chip. It has no state fill of its own.
- **A wait** stays an edge: a session that waits for a pull request, as Kiro Remote's change feed says, is a `waiting-mark` line with an arrow to what it waits for, at the weight of a cascade (1.6px). It goes when the wait ends. The legend names it, so no meaning rests on colour alone.

No strong colour fills an area or draws a thick ring: dots are marks, fills are pastel and only in chips, lines are hairlines.

### Allow-lists

What may be a pill:

- an item that moved in the window (`moved`);
- an item that waits on the person (`waiting`), including a session that waits for a pull request.

Nothing else is a pill. At most 7 pills are lifted at once (to confirm, spec open question 11); the rest stay dots. Anything else is named when you point at it or zoom to it.

What may fade (to 25%, in a trace): dots and pills. Nothing else fades: regions' names and counts, the legend, and the chain's cards stay at full strength.

What never moves: a dot, a region, a pill and a name stay where they are when a trace is drawn, when the log moves and when you zoom or pan. A trace changes strength and adds cards and arrows; it moves nothing.

## The trace over the ground

Choosing an event fades the ground and lines its chain up. The links are the Chain preview's cards (`chain-link`, written the same here), with the `moved-mark` arrow, 1.6px, for each recorded cause, on top of the ground. The second state draws the 23 November cascade, with the issue that closed chosen and marked "seen here". A faded pill's words fall below 4.5:1 on purpose: the ground recedes while the chain is read.

The asks (sex1prmq) and what rests on this (wjfp7ca4) reuse the card and fade by hop (each hop a step fainter); nothing here is drawn only for the cascade.
