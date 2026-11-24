# the by-state map's arcs end at one point and cross, against L7

## Goal
Arcs between the states of a row start and end on a cell's top edge, with the ends spread along it, share one arrowhead, stack and never cross (spec L7, A9, the by-state map).

## Notes
Seen in the screenshots of PR 57, m10 (the three states of Issues) and m11 (the six states of Decisions), which have no design preview: several arcs end on the top edge of one cell at the same point, so their arrowheads sit on each other, and arcs cross where one runs into another's span. `layoutArcs` in `map-arcs.ts` and `test/renderer/map-arcs.test.ts` are meant to prevent exactly this, so either the test measures something other than what is drawn, or the arcs are drawn with other ends than it computes. The by-state table in PR 56 noted it; no issue was filed.

## Done when
In m10 and m11 no two arrowheads share a point and no two arcs cross; a test measures this on what the map draws (its SVG paths) and fails on the current drawing; the by-state arcs have a design preview in docs/design-system.
