# Treat the context log as a durable execution record

## Context
q7hkbw4h makes the context log draft's own hash-chained JSON Lines store. Once real logs exist, the contract of what is in them is expensive to change. Three gaps were found before the first slice landed:

- `verifyChain` refused the whole log when one event had a type or schema version the build didn't know, so a newer draft, or another context, could make an older build lose access to its data.
- A tool call that changed something was logged once, after it ran. A crash in between left no trace of the intent, and nothing stopped a recovery from running it again.
- Every event of the person at the device carried a constant `local-user` actor, an assumed "me" that adding people would have to migrate.

## Decision
The log is a durable execution record with this contract:

- **Unknown events are kept.** The hash chain is verified over every record whatever its type. An unknown event type, or a known type at a newer schema version, is kept exactly as received, skipped by projections, counted (`draft.log.unknown_events`) and shown as a generic block. A known type at a known schema version whose envelope or data fails its schema still fails verification.
- **Intent before effect.** A call that changes something is a step: `step.started` (a fresh idempotency key, the tool, its input and its grounds, the decision) is appended and synced before the call runs, and the call is refused if that append fails. `step.completed` or `step.failed` follows with the result summary, referring to the started event's address. Read-only and refused calls keep a single `agent.tool_called`.
- **A started step is never run again.** A step without a completion shows as an interrupt that says the action may or may not have happened, with what it was. Nothing re-runs it automatically.
- **People are identities.** A user actor is `{ kind: "user", id, name }`: a ULID created on the device's first run and kept in config, with a display name from git or the OS. The agent never acts under it.

## Scope
The event contract of every context log: `packages/core/src/events.ts`, `verify.ts`, the projections, and the conversation and agent code that writes steps.

## Consequences
- An older build can open any log a newer one wrote, and a crash never hides or repeats a side effect.
- Idempotency keys are recorded but not yet sent: Kiro Remote's REST API deduplicates by `Idempotency-Key`, but its MCP tools don't accept a key (open follow-up). Until they do, a step that reached the service and then lost its result can only be resolved by a person.
- Interrupts stay until a later event resolves them; there is no "resolve" event yet.
- Projections must ignore unknown events and stay rebuildable from the log alone (property-tested).
- Adding people means adding identities, not rewriting events.
