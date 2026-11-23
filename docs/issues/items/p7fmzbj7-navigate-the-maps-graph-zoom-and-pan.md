# Navigate the map's graph: zoom and pan

## Goal
The person moves around a large graph without losing their place.

## Notes
- Niko's feedback after using draft on 23 Nov 2026. Zoom with buttons, Cmd and +/-, and pinch; pan with the arrow keys, by dragging while Space is held, and by scrolling with two fingers. A button fits the graph to the panel.
- Panning and zooming change the viewport only, never the layout, so positions stay put (docs/model.md, A layout that stays put). The semantic zoom (cluster, kind, item) stays a separate, explicit move.

## Done when
- Each input moves the viewport as described, from the keyboard too; tests cover the viewport maths, and the e2e test zooms, pans and fits.
