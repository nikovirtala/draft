# Size the agent context to the model's context window

## Goal
Fit the projection a session starts from to the model it runs on, instead of fixed limits.

## Notes
- `buildAgentContext` keeps 30 messages, 16k characters, 20 decisions and 20 references (ADR h89hcrk6). Agents report the window: Kiro's `context_usage`, ACP's `usage_update` `size`.

## Done when
- The limits come from the agent's reported context window, with the fixed ones as a fallback.
