# Make every agent ask before it acts, and log a call that didn't

## Context
bavp4nfa moves draft to ACP. Over ACP the agent runs a tool itself after it asks with `session/request_permission`, so draft can only record a step before a call that changes something if the agent asks first.

What was found, checked against kiro-cli 3.5.0 and claude-agent-acp 0.109.0 in the sandbox:

- **Kiro CLI V3** decides with capability rules (`permissions.yaml`, deny > ask > allow), session presets requested in `_meta.kiro.policyPreset`, `--trust-all-tools`, and a session `autopilot` option that starts `on` and accepts file changes without asking ([Kiro permissions](https://kiro.dev/docs/permissions/), [V3 permissions migration](https://kiro.dev/docs/cli/v3/permissions/)). In a folder nobody trusted it asks before every shell command and every MCP call, even when a saved rule allows it. Seen in a real turn: it asked for `kiro_list_sessions` and `kiro_launch_session`, with `_meta.kiro.mcpTool.identity` naming the server and tool. Its own "Tool Load" call, which loads a tool definition, runs without asking and carries no tool identity.
- **claude-agent-acp** reads the user's Claude settings (`settingSources: ["user","project","local"]`), which can allow tools, and starts in mode `auto`, where Claude decides for itself; `bypassPermissions` is offered outside root. A client can pass `_meta.claudeCode.options` in `session/new` and switch the mode with `session/set_config_option`.
- Both advertise `mcpCapabilities.http`, so Kiro Remote can be handed over HTTP with a bearer header ([ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)).

So both agents can be configured to run a call that changes something without asking. Neither can be made to by draft's own choice of options alone, because user-level settings and rules outside draft also apply.

Options considered:

- Trust the agent's configuration: simplest, but a user rule or a future default silently skips draft's steps.
- Configure the agent to ask, check that it took the setting, and detect a call that ran unasked anyway.
- Run the tools in draft (client-side MCP over ACP): Claude's adapter supports it, Kiro does not advertise it.

## Decision
draft configures each agent to ask and checks that it does, and treats any call it sees running without a permission request as an anomaly.

- **Launch.** Kiro: `kiro-cli acp --agent-engine=v3 --auth-method=cli`, the `autopilot` session option set to `off`. Claude: `claude-agent-acp` with `_meta.claudeCode.options` `{ settingSources: [], tools: [] }` (no user settings, no built-in tools) and the mode set to `default`. Any agent that advertises an `autopilot` option gets it switched off. If the agent doesn't report the setting as taken, draft doesn't start the session and says why.
- **Where it runs.** The agent starts in `agent-workspace` under draft's data directory, never a user repository; Kiro treats it as an untrusted folder. draft declares no `fs` and no `terminal` capability.
- **Kiro Remote.** In `session/new`, over HTTP with `Authorization: Bearer <token>` when the agent advertises `mcpCapabilities.http`, otherwise the `kiro-remote mcp` stdio client from kiro-remote's packages/mcp, which signs in on its own. A refreshed token starts a new session.
- **Answers.** Every permission request goes through `decideTool`. Only Kiro Remote's tools, identified by structured fields (`_meta.kiro.mcpTool.identity`, the Claude adapter's `_meta.claudeCode.toolName`, or a full `mcp__kiro-remote__…` name), never by title, can be allowed; everything else is refused without asking. Only an `allow_once` option is ever chosen, so the agent never saves a rule.
- **Anomaly.** A `tool_call` that reaches `in_progress`, `completed` or `failed` without a permission request is written as `agent.anomaly` and shown as an interrupt, unless it is a read-only Kiro Remote tool, a call whose ACP kind only reads (and isn't another MCP server's), or Kiro's "Tool Load", recognized by its exact structured shape.
- **Credentials.** draft stores none for agents. Kiro keeps its own sign-in. The Claude adapter reads `ANTHROPIC_API_KEY` from the environment draft passes through; if it is missing the conversation says how to set it. The key isn't passed to other agents. secrets.ts stays: it holds Kiro Remote's OAuth tokens.

## Scope
How draft starts and configures agents and answers their requests: `apps/desktop/src/main/acp/` and its wiring in `apps/desktop/src/main/index.ts` and `config.ts`.

## Consequences
- A call that changes something is recorded as a step before it runs with both agents as draft launches them, and a call that skipped the request is never silent.
- An anomaly is detected only once the call is running: draft can't stop it, only show it.
- The Kiro "Tool Load" exception depends on Kiro's current shape; if it changes, it shows as an anomaly until the rule is updated (follow-up: ask Kiro for a stable identity on its own calls).
- Kiro asks for read-only Kiro Remote tools too, in an untrusted folder; draft answers those itself without asking the person.
- An agent of no known kind gets only the generic checks.
