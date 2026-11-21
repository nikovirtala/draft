# Return a thread's conclusion to the main conversation

## Goal
When a thread wraps up, its conclusion returns to the main conversation as a summary, so decisions don't disappear into threads.

## Notes
Design: "Threads" in docs/model.md. The thread state is `open` only (packages/core/src/workspace.ts, ThreadState); this adds the next states.

## Done when
- A thread can wrap up with a conclusion that appears in the main conversation at its stub.
- The conclusion cites the thread.
