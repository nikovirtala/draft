# Draw the map as one mesh seen through lenses

## Goal
The map's graph shows every item of a context as one dot in one cloud, in its state's colour, placed near what it references and what references it, and is seen through lenses (everything, waiting on me, only what is moving, open loops, one kind, one person's view, the causal trace) that light the dots that answer them and fade the rest. A lens lifts only the lit items that move or wait on the person into named pills.

## Notes
- Design: docs/model.md, "The map" (one mesh, position by references, lenses) and the Graph preview (docs/design-system/components/Graph), four states of one mesh.
- Replaces the discs sized by count and the regions by kind. A dot's place comes from references, seeded by its id, and moves only a little as references arrive; nothing ever moves when the lens changes.
- "Lens" is the word everywhere in the code and the interface, never "filter".
- "By state" stays the other layout of the same dots. The causal trace lens is s0ytw6nf.

## Done when
- Every item is one dot in one cloud, with no regions by kind, no names on the ground and no discs sized by count.
- A dot keeps its place across refreshes and when the lens changes, as the layout tests already require, and a test holds that.
- A lens lights its dots, fades the rest to 25% and lifts the lit items that move or wait on the person into pills; nothing is removed.
- No more pills than the cap are named; the rest are named on pointing or zooming, and a test holds the cap.
- Labels never overlap, measured as layoutLabels measures them today.
- Matches the Graph preview's four states in CI's screenshot comparison.
