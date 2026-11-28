# Draw the map on a canvas as one mesh

## Goal
The map's graph is drawn on a WebGL canvas: every item of a context one dot in one cloud, in its state's colour, placed near what it references and what references it, with continuous zoom, pan and fit, few named pills, and a list beside it that says the same in words.

## Notes
- Design: docs/model.md, "The map" and "For every reader"; the static Graph preview and the interactive Map preview.
- Replaces the SVG MapGraph.tsx graph, its discs and clusters. The viewport stays map-viewport.ts; the layout stays a pure function of the graph and the layout before it, now placing by references.
- Uses the renderer the preview's ADR chose. Lenses are separate (their own issue).

## Done when
- Every item is one dot in one cloud, placed by references, seeded by its id; a test holds that a dot keeps its place across refreshes, zooms and pans.
- Zoom is continuous about the pointer; pan and fit work by pointer and keyboard.
- No more pills than the cap are named, and labels never overlap, measured as layoutLabels measures them today.
- The list beside the canvas has a button per named item in reading order.
- 60 frames per second zooming and panning the 5,000-item synthetic context, measured in CI.
- Matches the interactive preview's named moments in CI's screenshot comparison.
