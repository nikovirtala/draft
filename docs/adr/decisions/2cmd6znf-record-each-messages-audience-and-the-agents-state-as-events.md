# Record each message's audience and the agent's state as events

## Context
model.md ("Multiplayer and audience") gives every message an audience, people only or people and the agent, defaulting from the agent's state (paused, listening, active). Kinds (4seyq393) and a scribe state will read the audience, and multiplayer will make it a set of people. jj76pjg2 already keeps an event of a known type at a newer schema version as unknown.

Options considered:

- A UI flag that filters what is sent: invisible to kinds and projections, and nothing in the log proves what the agent saw.
- A boolean on the message: cheap, but naming people later would need a migration.
- A structured audience on `message.posted`, and the agent's state as its own event.

## Decision
- `message.posted` moves to schema version 2 with `audience: { people: "all" | [ids], agent: boolean }`. Version 1 messages are read as `{ people: "all", agent: true }`, what they were. An older build keeps version 2 messages as unknown events.
- `agent.state_changed` (`active` or `paused`, by a person) sets a conversation's agent state; `listening` comes with kinds. The default audience follows it. An aside skips the agent in an active conversation; `@agent` reaches it in a paused one, for that message and its turn only.
- A paused conversation starts no turns and no steps; pausing cancels a running turn that `@agent` didn't start.
- Schema versions are per event type from now on (`SCHEMA_VERSIONS`), so one type can move on without the others.
- `agent.anomaly`, `agent.session_started` and `log.recovered` are new types at version 1.

## Scope
`packages/core/src/events.ts`, `projection.ts` and the conversation service in `conversation.ts`.

## Consequences
- What the agent could read is answerable from the log alone, and kinds can read audiences without new plumbing.
- Named audiences fit the same field.
- An older build shows newer messages as generic blocks until it is updated.
