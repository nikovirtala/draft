# Cross contexts by snapshot and record every crossing

## Context
model.md says a reference across contexts keeps a snapshot, the context boundary is a trust boundary, and text from another context gets in only when a person pulls it in. The audit rules say each read across contexts is recorded. The agent of one context must never see another context's log.

Options considered:

- A resolver for cross-context targets, polled like a live stub: the stub would update, but every poll reads another context's log, and the target would drift under an old reference.
- Share one projection across contexts: simple, and exactly what the boundary forbids.
- Read the target once, keep a snapshot in the referencing log, and record the crossing: chosen.

## Decision
A reference to an item in another context is a snapshot, made once, and every crossing is an event in the log of the context it was made from.

- **Reference.** An address of another context's item, written in a message (`<context>/<conversation>/<item>@<version>`), becomes a `reference.made` edge whose target type is `context-item` and whose snapshot holds the context name, the address, the title and a short excerpt, the version and the event hash. draft reads the target's log itself, with no model, and only to take that snapshot. It is never polled.
- **The agent never reads it.** Edges of type `context-item` are left out of the agent's context. Nothing from the other context reaches the agent unless a person pulls it in, which writes a `context.crossed` event with the purpose `pulled`; only then the snapshot joins that conversation's context.
- **Each crossing is recorded.** `context.crossed` has the purpose `referenced`, `followed` (a person opened the other context from the reference), `pulled` or `opened` (a person confirmed opening a context by sentence). Its actor is the person, or draft for `referenced`. It carries the other context's name, the target address and the snapshot's hash.
- **Following** a reference opens the other context in its own window. It does not change the current context's agent.

## Scope
References across contexts: `packages/core/src/agent-context.ts`, `packages/core/src/conversation.ts`, `packages/core/src/projection.ts`, `packages/core/src/events.ts`, `apps/desktop/src/main/contexts/`.

## Consequences
- A snapshot can be stale; it says when it was taken and is never updated. Refreshing one is a later step.
- The excerpt in a snapshot is stored in the referencing log, so a person who can read that log reads that excerpt. Sharing a context shares what its references snapshotted.
- A target that is gone or unreadable leaves the typed address as plain text.
- Revert and reprocessing of one context stay inside it: its log, projections and view state refer to others only by snapshot.
