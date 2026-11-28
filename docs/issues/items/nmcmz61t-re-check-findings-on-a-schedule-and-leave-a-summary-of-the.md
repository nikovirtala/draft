# Re-check findings on a schedule, and leave a summary of the day

## Goal
A scheduled pass re-reads every finding that standing or an open kind rests on against its source and records whether it still holds; it also leaves a summary of the day for new agent sessions.

## Notes
- Design: docs/model.md, "Fitness checks", re-checking on a schedule. Needs findings as facts, so it comes with kinds (4seyq393).
- Relates to sizing the agent context (5tx1bn6n): a new session starts from standing, open kinds and the last few days.

## Done when
- A finding whose source changed gets a superseding fact with what was found, and what rests on it goes stale.
- A finding that still holds gets a new fact with the new date.
- Each correction is its own fact citing its evidence, and can be reverted on its own.
- Findings are re-checked most-relied-on first.
