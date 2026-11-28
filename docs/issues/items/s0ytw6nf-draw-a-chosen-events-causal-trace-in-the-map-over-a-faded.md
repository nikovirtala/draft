# Draw a chosen event's causal trace in the map over a faded ground

## Goal
Choosing an event in the map, or opening the map from a chain, lines up the same chain in place while the rest fades.

## Notes
- Design: docs/model.md, "The map", why it moved. Picture: the CausalTrace and Graph previews.

## Done when
- The trace drawn for a fixture event has the same links as its chain block; a test compares them.
- Causes back to the root and effects forward to where they stop are drawn; everything else fades and keeps its place.
- Matches its preview in CI's screenshot comparison.
