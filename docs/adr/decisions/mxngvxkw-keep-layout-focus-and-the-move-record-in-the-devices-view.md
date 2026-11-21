# Keep layout, focus and the move record in the device's view-state store

## Context
Blocks live in one of four places (model.md, "Core model: blocks and placements"). Placement must never reach the log, must survive a restart, must be per device (a phone places the same block differently), and the feedback loop will later adapt placement from the moves, so every change needs evidence: block, kind, from, to, when.

## Decision
Placement, focus and window bounds are kept in the device's view-state store (device.db), never in the log. A pure state machine (apps/desktop/src/shared/placement.ts) models the four placements, the moves, one panel block at a time, no panel for a block made inside a thread, one stub per moved block, and focus. A block is defined by its address and kind, so any kind can be placed. Every placement change is stored in a moves table with block, kind, from, to, time and cause (user, displaced, focus, focus-restore). The agent cannot move a block: the state machine refuses agent moves, and no IPC path from agent output reaches it. The attention count is computed per conversation and focus filters it by conversation.

## Scope
apps/desktop/src/shared/placement.ts, apps/desktop/src/main/view-state.ts, apps/desktop/src/main/layout.ts, apps/desktop/src/main/windows.ts

## Consequences
Layout cannot be shared between devices or audited from the log; both are intended. The moves table grows without bound until the feedback loop reads and prunes it. Open question: whether focus should persist across a restart; it does now, as part of the layout.
