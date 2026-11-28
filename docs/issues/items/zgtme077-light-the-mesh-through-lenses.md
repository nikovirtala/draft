# Light the mesh through lenses

## Goal
The canvas lights what a lens answers, fades the rest, draws faint lines between lit neighbours and lifts lit items that move or wait on the person into pills; a lens is chosen by asking or with the lens switch.

## Notes
- Design: docs/model.md, "The map", lenses. "Lens" is the word in code and interface, never "filter".
- Lenses now: everything, waiting on me, only what is moving, open loops, one kind, what rests on an item. One person's view waits for multiplayer.

## Done when
- Each lens is a pure function from the snapshot to the lit set, tested on the fixture.
- Changing the lens moves no dot; a test compares positions before and after.
- "what waits on me?" in the conversation opens the map in that lens.
- The list beside the canvas shows the lit items, and the change is announced.
- Matches the interactive preview's named moments in CI's comparison.
