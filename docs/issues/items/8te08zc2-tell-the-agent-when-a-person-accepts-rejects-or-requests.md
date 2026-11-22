# Tell the agent when a person accepts, rejects or requests changes

## Goal
Once a person decides on an acceptance request, the thread's agent knows the outcome before its next turn, so it never contradicts it or offers to do it again.

## Notes
- Found on 2026-11-22: after Niko accepted nikovirtala/draft#14 (merged at 12:49 UTC as f724c94), the agent still described the pull request as open and asked whether it should rebase-merge it.
- The settlement is in the log (the step, its settlement and the actor), but it isn't in what the agent is told.
- Deliver it like other context the agent gets: with its next prompt, a short note naming the request, the decision, who made it and when, and the resulting state (merged at a commit, changes requested with the text, rejected with the reason).
- The same goes for every person-only transition of a kind, not only acceptance.

## Done when
- A test agent's next prompt after an acceptance, a rejection and a request for changes carries the outcome.
- In a real turn after an accept, the agent reports the pull request as merged.
