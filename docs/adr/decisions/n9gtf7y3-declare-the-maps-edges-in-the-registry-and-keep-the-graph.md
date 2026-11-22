# Declare the map's edges in the registry and keep the graph layout incremental

## Context
The map is becoming a graph (docs/model.md, "The map"). It needs references between items, and positions that don't jump when the log moves. ADR db8dwjne puts each kind's states in one registry and draws from a pure fold; the graph must not add map code per kind, and later kinds (voice segments, feedback) bring edges of their own.

Options considered:
- Edges inferred in the view from item labels or ids: no registry change, but every new kind needs view code and edges would be guessed.
- Edges declared by each kind beside its items (`KindDecl.edges`), kept by the fold when both ends exist. Chosen.
- Layout by a force simulation (d3-force) or a layered layout (elkjs): a new runtime dependency, and each re-run moves nodes.
- A small layout that seeds each node from its id and places new nodes without moving old ones. Chosen.

## Decision
A kind declares the references it owns with `edges(input)`, typed as `from rel to` between items, from what the log or its source says and nothing inferred. `foldMap` returns them in `MapSnapshot.edges`, keeping an edge only when both ends are items of the map; a kind whose edges throw is reported in problems. The graph is a pure projection of the snapshot and a zoom (`map-graph.ts`). Positions come from `layoutGraph(graph, previous)` (`map-layout.ts`): seeded by id, existing nodes kept (pushed at most MAX_SHIFT), new nodes placed at their seed or the nearest free place, with no layout library.

## Scope
packages/core/src/map.ts, packages/core/src/map-graph.ts, packages/core/src/map-layout.ts, packages/core/src/map-ark.ts, packages/core/src/map-kinds.ts, apps/desktop/src/renderer/src/components/MapGraph.tsx

## Consequences
- A new kind brings edges by declaring them; the view knows no kind.
- Positions are testable and stable, and no dependency is added. The layout is simple: it does not minimise crossings, and a crowded context can look busy.
- Reading link and supersede events costs a few more file reads per refresh (each once, by blob sha).
- Open question: which edge kinds (suggested ones) a later agent may add, and how the graph is time-scrubbed.
