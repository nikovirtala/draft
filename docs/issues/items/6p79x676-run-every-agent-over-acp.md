# Run every agent over ACP

## Goal
Replace the Claude Agent SDK runtime with one ACP client runtime behind `AgentRuntime`: local `kiro-cli acp` by default, Claude through `claude-agent-acp` with a Console API key.

## Notes
- Decision: ADR bavp4nfa (supersedes rrfst5qk). Standard ACP only; Kiro's `_kiro/*` extensions only when advertised.
- ACP permission requests go through `decideTool`, so approved calls that change something begin a durable step (`beginStep`) before they run.
- Kiro Remote's MCP server goes to the agent in `session/new`, with the bearer token from the OAuth flow (xy2we9f8).
- Tell the agent about interrupted steps in the history it gets after a restart, so it doesn't repeat them blindly.
- Needs a scripted ACP agent for tests, like today's `FakeAgentRuntime`.

## Done when
- A turn runs against `kiro-cli acp` and against `claude-agent-acp`, streaming, with Kiro Remote's tools.
- Tools that change things still ask first and are recorded as steps.
- The Agent SDK runtime and its dependency are removed.
