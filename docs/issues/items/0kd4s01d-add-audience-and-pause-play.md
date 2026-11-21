# Add audience and pause/play

## Goal
Decide who an event is for (audience) and let the user pause and resume agent work, recorded in the log.

## Notes
- Out of scope for the log-contract update of the first slice; the design update introduced both.
- The envelope keeps unknown fields and unknown event types, so these can be added without breaking older builds; an older build shows them as generic blocks.

## Done when
- Audience and pause/play have event types with schemas and a projection.
- A paused conversation starts no new steps until resumed.
