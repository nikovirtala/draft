# Draw the map: every kind's items by state, live

## Goal
Show one view of everything that exists in a context and what is moving, as docs/model.md ("The map") describes it: rows are kinds, columns are their states, each cell counts its items, what waits on the person is highlighted and recent transitions are arrows between cells. A cell opens its items, and an item opens where it lives. It opens from a sentence ("show the map") and updates as the log moves. First cut: threads, steps, interrupts by kind, acceptance requests, Kiro session stubs and pull request stubs.

## Notes
Built as one projection: a kind registry (each kind declares its states, which are active, waiting or terminal, and how to list its items) and a pure fold over the log up to a position, with a time window and a grouping as parameters, returning transitions with their times and a context id on every item. A new kind becomes a row by registering. Later work builds on it: a delivery lens (time and phases with gates), zoom levels, contexts as regions (?32), the map at a past moment, kinds from ?8 and ?41, deployments (?9).

## Done when
- The fold and registry are in packages/core with unit tests (each kind, waiting cells, transitions in a window, a past position, a test kind registered with no map code).
- "Show the map" opens a map block, placed like other views (inline, panel, window); its counts match the conversation and update live; a cell opens its items; an item opens its thread or stub.
- Its view state (open, placement, selected cell) is in the device view-state store.
- docs/implementation.md describes the projection and how a kind becomes a row.
- An end-to-end test opens the map by sentence on a fixture context and opens a cell and an item.
