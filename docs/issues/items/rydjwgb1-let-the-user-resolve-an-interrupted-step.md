# Let the user resolve an interrupted step

## Goal
Give an interrupt a way to be settled: the user checks what happened and records it as done, failed or to be retried as a new step.

## Notes
- An interrupt is a `step.started` without a completion; draft never re-runs it. Today it stays on screen for good.
- Resolving it is a user decision, so it is a raw event that names the started step.
- Retrying means a new step with a new idempotency key, never re-running the old one.

## Done when
- An interrupt can be resolved from the conversation, and the resolution is in the log.
- A resolved interrupt no longer shows as one after a restart.
