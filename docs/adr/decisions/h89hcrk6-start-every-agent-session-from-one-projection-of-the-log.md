# Start every agent session from one projection of the log

## Context
Durable context (model.md) says a context resumes by rehydrating, never by replaying: a new agent session gets a projection of the log. Threads (x0fvskee) will run one ACP session per thread and may switch agents midway, and a second opinion is a fork seeded with the same projection. The first slice sent the whole transcript as the system prompt, and the agent's own memory (Kiro sessions, Claude transcripts) would differ per agent.

Options considered:

- Let each agent keep its session and resume it with `session/load`: agent-specific, and loses what happened outside that agent.
- One function that builds a compact projection from the log, used whenever any session starts.

## Decision
Every agent session, for a first turn, a restart, a crashed agent process, a refreshed token, a switch of agent or a fork, starts from `buildAgentContext(projection, conversation)` in packages/core, rendered as text before the first message. It holds:

- open items: steps that started and never finished (named as interrupted, "may or may not have happened"), and calls that ran without asking;
- decisions: what the person allowed, declined or draft refused, with outcomes;
- references in play, with their latest known state;
- the most recent messages the agent may read, cut to a budget, with a count of those left out.

The runtime keys sessions by conversation address and never relies on the agent's memory across sessions. Each start is logged as `agent.session_started` with the agent, model and a hash of the context.

## Scope
`packages/core/src/agent-context.ts`, the `context` field of `AgentTurnInput` in `packages/core/src/agent.ts`, and every `AgentRuntime`.

## Consequences
- Restart, switching agents and forking reuse one path, and the agent is never asked to redo a recorded step blindly.
- The agent loses detail beyond the budget; it can pull more through references once those tools exist.
- The audience rule is enforced in this function, so it is the one place to test that people-only messages never reach a model.
- Open question: the budget is fixed (30 messages, 16k characters); it may need to follow the model's context window.
