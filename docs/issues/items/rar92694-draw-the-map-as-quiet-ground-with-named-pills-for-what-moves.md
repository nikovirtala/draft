# Draw the map as quiet ground with named pills for what moves or waits

## Goal
The map's graph shows every item as a dot in its state's colour, a kind as the region its dots gather in, and lifts only what moves or waits on the person into a named pill.

## Notes
- Design: docs/model.md, "The map", quiet ground, few names. Replaces the discs sized by count. Keeps the layout that stays put: dots keep their seeded places.

## Done when
- No more pills than the cap are named; the rest are named on pointing or zooming, and a test holds the cap.
- A node keeps its place across refreshes, as the layout tests already require.
- Labels never overlap, measured as layoutLabels measures them today.
- Matches the Graph preview in CI's screenshot comparison.
