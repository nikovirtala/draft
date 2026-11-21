# Show the stub of what a retried step made

## Goal
A retried step that launches a session should show that session as a live stub.

## Notes
Retry runs the tool as the person and records the step; its result is not yet referenced, so a new session has no stub or interrupts until someone names it.

## Done when
- The result of a retried step is referenced in its conversation.
