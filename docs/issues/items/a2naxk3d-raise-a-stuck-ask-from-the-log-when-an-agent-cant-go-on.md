# Raise a stuck ask from the log when an agent can't go on

## Goal
draft notices from the log when an agent is stuck (the same step failing again, turns without a result, a session past its timeout with nothing new) and raises one Stuck ask that cites those events.

## Notes
- Design: docs/model.md, "Asking once". The thresholds are an open question there; start with a step failing three times and settle the rest from use.

## Done when
- A scripted step that fails three times raises one Stuck ask citing the three failures; a fourth folds into it.
- A session past its timeout with no new event raises one, and a new event after it clears it.
- Nothing is raised for an agent that is working; a test covers a long turn that ends with a result.
