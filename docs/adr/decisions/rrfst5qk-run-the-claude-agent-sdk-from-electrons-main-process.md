# Run the Claude Agent SDK from Electron's main process

## Context
The agent runs on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.329), which spawns the Claude Code binary (2.1.329) from a platform package such as `@anthropic-ai/claude-agent-sdk-linux-x64`. The renderer must never see the Anthropic API key.

Checked from Electron 45.4.1: `query()` started the binary from the main process and from a `utilityProcess`, and both received `system:init` with the model and Claude Code's version before failing on authentication, as expected without a key.

Options considered:

- The main process: the SDK already runs Claude Code as a child process, so main only relays messages. Telemetry context, the permission callback and the log stay in one process.
- A utility process: crash isolation, at the cost of an IPC protocol for messages, permission prompts and trace context.

## Decision
The SDK runs in the Electron main process, behind core's `AgentRuntime` interface, with one SDK session per conversation in streaming input mode. The API key comes from the main process environment and is passed only in the Claude Code child's `env`. The agent gets no built-in Claude Code tools in this slice (`tools: []`), only Kiro Remote's, and `settingSources: []` keeps user settings from widening its permissions. Read-only Kiro tools are in `allowedTools`; every other call goes through `canUseTool`, which asks the user for tools that change things and denies the rest.

Packaging unpacks the platform binary from the asar archive (`asarUnpack` for `@anthropic-ai/claude-agent-sdk-*`), and `pathToClaudeCodeExecutable` points at `app.asar.unpacked` in a packaged app. Each platform build ships its own platform package.

## Scope
How draft runs its agent: `apps/desktop/src/main/agent-sdk.ts` and its wiring in the main process.

## Consequences
- The key never reaches the renderer, and the agent's tools are limited to Kiro Remote.
- A Claude Code crash ends that conversation's SDK session; the next turn starts a new one with the history from the log. A hang in message parsing would block the main process.
- Moving to a utility process later is contained behind `AgentRuntime`.
- The 370 MB platform binary dominates the app's size, and packaging and signing must handle an unpacked executable (macOS notarization signs it too).
