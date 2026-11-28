# Graph

The map in the palette: one mesh of dots seen through lenses. It replaces the discs sized by count and the regions by kind. Four states, one mesh, the same 60 dots at the same places in each:

- **Everything.** The default lens. Every dot at its state's strength; the 7 that move or wait on you are named as pills.
- **Waiting on me.** Lights the dots that wait on you (4) and names them.
- **One kind: pull requests.** Lights the 18 pull requests wherever they sit. A kind is a lens, not a region.
- **Why it moved.** The causal trace of the 23 November cascade: the chain lights as a path between neighbouring dots, with the Chain preview's own cards on the path and `moved-mark` arrows on top.

Above each stage is the lens switch, drawn as the Switch preview draws a switch: the chosen lens is `moved-selected` with `ink` words, the rest `muted` on `surface`.

## The data

Items, ids and states come from draft's own log for the evening of 23 November 2026: pull requests #36 to #57, issues (?86 among them), the accepted and proposed decisions, sessions, signals, deployments and threads. The references that place the cascade, #51 closing ?86, #52 closing three issues, #42 and its decision, and #55 and #57 with the decisions they propose, are real. The other references are filled in to make a plausible mesh and carry no claim. Positions are seeded by id and relaxed along the references; they are worked out once and reused in every state.

## The ground

- **A dot** is 4px across, the same for every state (to confirm, spec open question 12), in its state's `*-mark`: `moved-mark`, `waiting-mark` and `review-mark` at full strength; `done-mark` (settled) and `idle-line` (not started) at 40%. A dot has no outline and no disc.
- **Position** comes from references: a dot sits near what it references and what references it. There are no regions by kind and no names on the ground.
- **A pill** is a named item lifted out of the ground: StateChip-shaped, `raised`, a `line-strong` hairline, `--radius-chip`. It holds the kind's mark (a small outline shape in `ink`), the name in `ink` and the state's chip. It has no state fill of its own. It sits beside its dot, joined by a `line-strong` hairline; the dot stays where it was.
- **A wait** stays an edge: a session that waits for a pull request, as Kiro Remote's change feed says, is a `waiting-mark` line with an arrow to what it waits for, at the weight of a cascade (1.6px). It goes when the wait ends. The legend names it, so no meaning rests on colour alone.
- **A reference** is not drawn on the ground; it places the dot. It is drawn where a lens asks for it, as the trace's arrows.

No strong colour fills an area or draws a thick ring: dots are marks, fills are pastel and only in chips, lines are hairlines.

## Lenses

A lens lights the dots that answer it, at full strength whatever their state, and fades the rest to 25% of their strength. It then lifts the lit items that move or wait on you into pills. Nothing is removed.

What a lens may light:

- **Everything:** all dots (they keep their own strength; nothing fades).
- **Waiting on me:** dots whose state is waits on you, a failure included.
- **Moving:** dots whose state is moved.
- **Open loops:** dots that are open loops.
- **One kind:** dots of that kind: decisions, issues, pull requests, sessions, deployments, signals, threads.
- **One person:** dots that person acted on or is asked about.
- **Why it moved:** the dots of one event's chain, and the arrows between them.

What may be a pill: a lit item that moved in the window (`moved`) or waits on the person (`waiting`). At most 7 pills at once (to confirm, spec open question 11); the rest stay dots. Nothing else is a pill, and anything else is named when you point at it or zoom to it.

What may fade (to 25%): dots, pills, the wait edge and reference arrows that are not lit. Nothing else fades: the legend, the lens switch and the chain's cards stay at full strength.

What never moves: a dot is where it was when the lens changes, when a trace is drawn, when the log moves and when you zoom or pan. A lens changes strength and adds pills, cards and arrows; it moves nothing. A dot moves only a little as references arrive, seeded by its id, and never from scratch.

An open loop is a dashed `loop-mark` ring, which a 4px dot has no room for: on the ground it is a dot in its state's colour, the open loops lens lights it, and the pill that names it carries the dashed ring (spec open question 13, answered by this lens).

## The trace

The cards in the last state are the Chain preview's link card (`chain-link`, written the same here). They sit on their dots, which the layout puts near each other, and the path wraps once where it runs out of width. The arrows are `moved-mark`, 1.6px, one for each recorded cause. A command is a cause, not an item: it has a card on the path and no dot. A faded pill's words fall below 4.5:1 on purpose: the ground recedes while the chain is read (spec open question 14).

The asks (sex1prmq) and what rests on this (wjfp7ca4) reuse the card and fade by hop (each hop a step fainter); nothing here is drawn only for the cascade.
