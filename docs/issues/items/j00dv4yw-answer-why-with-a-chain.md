# Answer why with a chain

## Goal
"Why did this happen?" about an event in a context's log gets a chain block: a verdict, the links back to what started it, what was ruled out.

## Notes
- Design: docs/model.md, "Why". Picture: the Chain preview.
- Built on the recorded causes and the edges projection; a link without a recorded cause is unproven, never inferred.

## Done when
- Asked about a real event in a fixture of draft's own log, the chain's links follow its recorded causes back to the root, and each opens the event it rests on.
- A link the agent proposes without a recorded cause shows as unproven; a test fails if one is drawn as recorded.
- What was ruled out is listed with why, and an investigation with no cause says so.
- The block matches its preview in CI's screenshot comparison.
