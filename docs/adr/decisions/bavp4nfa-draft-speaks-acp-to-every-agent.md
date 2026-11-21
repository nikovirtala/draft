# draft speaks ACP to every agent

## Context
The first slice runs Claude through the Claude Agent SDK in Electron's main process (rrfst5qk). The design has moved on: draft should supervise more than one kind of agent, starting with Kiro, without a runtime per vendor.

The Agent Client Protocol (ACP) is an open standard for connecting a client to a coding agent over JSON-RPC on stdio: sessions, prompts, streamed updates, tool calls and permission requests. Kiro CLI implements it as `kiro-cli acp` ([Kiro docs](https://kiro.dev/docs/cli/acp/)). Claude speaks it through `claude-agent-acp`, an adapter on the Claude Agent SDK maintained in the agentclientprotocol organization ([repository](https://github.com/agentclientprotocol/claude-agent-acp)); it bills a Console API key when `ANTHROPIC_API_KEY` is set. The design's "Bringing Claude in" section already rules out claude.ai sign-in for apps on the Agent SDK.

ACP lets an agent add extension methods and notifications whose names start with an underscore; Kiro's are under `_kiro/`. A client that depends on them is tied to one agent.

core already has an `AgentRuntime` interface with a permission hook (`confirmTool`) and a step hook (`beginStep`), and the log records every call that changes something as a durable step, so the runtime behind the interface can change without changing the log.

Options considered:

- Keep the Agent SDK in the main process and add a second runtime per agent: two integrations to keep in step, and Kiro's own agent can't be reached through the Agent SDK.
- ACP for every agent: one runtime, agents as child processes speaking a published protocol.

## Decision
draft talks to every agent over ACP, through one ACP client runtime behind core's `AgentRuntime`:

- The default agent is a local `kiro-cli acp`.
- Claude runs through `claude-agent-acp`, with a Claude Console API key passed only in that child process's environment.
- draft uses standard ACP only. It uses Kiro's `_kiro/*` extensions only when the agent advertises them during initialization, and works without them.
- ACP permission requests go through the same policy as now: read-only tools run, tools that change things ask the user and begin a durable step before they run, everything else is refused.

This supersedes rrfst5qk. The Agent SDK runtime stays in the code until the ACP runtime replaces it in the next slice; this pull request doesn't change the runtime.

## Scope
How draft runs agents: the `AgentRuntime` implementations in `apps/desktop/src/main` and the interface in `packages/core/src/agent.ts`.

## Consequences
- One protocol for every agent; adding an agent is configuration, not a new integration.
- draft depends on the agents' ACP implementations and on their release cadence. Open question: which ACP protocol version to pin, and how to test against each agent without credentials (a scripted ACP agent for tests, like today's fake).
- Claude features the Agent SDK exposes but ACP doesn't (for example per-server MCP tool policies) are out of reach unless the adapter maps them.
- Kiro Remote's MCP tools must reach the agent through ACP's MCP server configuration in `session/new`; the OAuth token flow (xy2we9f8) passes the bearer token there instead of to the Agent SDK.
- Packaging ships or locates `kiro-cli` and `claude-agent-acp` instead of the Agent SDK's platform binary.
