# Declare each kind's states in one registry and draw the map from a fold of the log

## Context
The map (docs/model.md) draws every kind with its items by state. Kinds are state machines, but the stubs and steps have none yet, and later work (?8, ?41, ?9, ?20) adds kinds, a delivery lens will group states into phases over time, contexts will become regions, and the map must be rebuildable at a past moment.

Options considered:
- A map component that knows each kind and reads the projection tables: simple now, but every new kind needs map code, and a past moment needs the tables rebuilt.
- One registry where each kind declares its states and lists its items, and one pure fold over the log. Chosen.

## Decision
packages/core/src/map.ts holds a kind registry and `foldMap`, a pure fold of a context's log records up to a position, with a time window and a grouping as parameters. A kind declares its states (active, waiting on an actor, terminal), taken from its state machine where it has one and derived, with the derivation written down, where it has none, and how to list its items with the path of states each went through. The fold returns rows by columns with counts, items, waiting cells and the transitions in the window with their times, and every item carries its context. A new kind becomes a row by registering; the fold and the view know no kind. Which cell a map block has open is view state of the device (ADR mxngvxkw).

## Scope
packages/core/src/map.ts, packages/core/src/map-kinds.ts, packages/core/src/map-types.ts, apps/desktop/src/renderer/src/components/MapBlock.tsx

## Consequences
- A kind added later needs a declaration and no map code; one whose states are wrong is reported in the map's problems and the rest still draws.
- The map reads the log, not the SQLite projection, so it can be folded to any position; it costs a pass over the whole log for each draw, which is fine until logs are large.
- Steps and stubs derive their states, so those rows can disagree with a machine when one is added; they are replaced then.
- Open question: whether the registry should be loaded from kind files (docs/model.md, "Creating a kind") rather than registered in code.
