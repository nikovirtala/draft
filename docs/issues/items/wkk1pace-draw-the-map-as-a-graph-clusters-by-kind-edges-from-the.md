# Draw the map as a graph: clusters by kind, edges from the registry, a layout that stays put

## Goal
Draw the map as the graph seen from one distance at a time (docs/model.md, "The map"): a context's kinds as clusters sized by their count with a ring for the share that has settled, bundled edges between clusters weighted by the references they carry, and items that moved in the window or wait on the person stepped out as small nodes. Zooming opens a cluster into its items, then one item's neighbourhood. The grid stays as a layout of the same nodes ("By state").

## Notes
Edges are declared per kind in the registry, beside items(), never special-cased in the view. The projection is a pure function of the fold's snapshot plus edges; positions are computed outside React, seeded by id and placed incrementally. First cut: the context, kind and item zoom levels. Later: universe and process levels (contexts as regions), the scrubber, the delivery lens.

## Done when
- A kind declares its edges; the log's references, a thread's parent, an acceptance request's target, an ADR's supersedes and links, an ark issue's links and a deployment's pull request are edges.
- A pure projection gives nodes, clusters, bundled edges with counts and stepped-out items at the context, kind and item zoom levels.
- The map draws the graph by default, with a Graph | By state switch; the grid is unchanged.
- Positions stay put when the log moves (tested).
- The graph is reachable from the keyboard and does not rely on colour alone.
- docs/implementation.md describes the projection, the edges and the layout rule.
