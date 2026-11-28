# Light a chosen event's causal trace as a path through the mesh

## Goal
Choosing an event, or opening the map from a chain, lights the chain as a path through the mesh: lit dots, an arrow along each recorded cause, a small pill on each with its name and state, the rest faded.

## Notes
- Design: docs/model.md, "The map", why it moved. Picture: the CausalTrace and Graph previews.

## Done when
- The path drawn for a fixture event has the same links as its chain block; a test compares them.
- Causes back to the root and effects forward to where they stop are lit; nothing moves.
- Choosing a pill on the path opens the chain block there.
- Matches the interactive preview's trace moment in CI's comparison.
