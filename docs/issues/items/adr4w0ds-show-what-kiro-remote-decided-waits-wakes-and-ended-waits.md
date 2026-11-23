# Show what Kiro Remote decided: waits, wakes and ended waits

## Goal
draft shows the factory's own state, read from Kiro Remote's change feed and folded like any other kind: which session waits for which pull request, why a session last woke, and a wait that ended without its pull request merging. The map, a session's stub and "needs you" agree with what Kiro Remote decided, with no second copy of its state.

## Notes
- The contract is Kiro Remote's change feed (GET /v1/events, docs/github.md "The change feed"), ark ADR 9t6n5jc6. Links and waits from before the feed have no event, so the fold starts from GET /v1/sessions/{id}.
- The feed's parsing and the fold are pure functions in core, so ark's folds can read the same feed, and the "feed with a cursor that a fold follows" is one small abstraction the next feed reuses.
- A session's wakes and their causes stay queryable, so the factory doc's "wakes done by hand" count is a later one-liner.

## Done when
- A session waiting on a pull request draws an edge to it on the map and says so on its stub, and the edge goes when the wait ends.
- A session's stub and its node say why it last woke, with the pull request.
- A wait that ended unreadable or registration_failed is one item in needs you that the person can dismiss.
- An event type the reader does not know is skipped when it is an annotation; a state type stops the fold, raises one notice and marks the derived waits and links stale. A gap in seq restarts from the starting state and says so.
- A contract test checks the reader against Kiro Remote's checked-in JSON Schemas.
