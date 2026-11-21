# Give Kiro's own tool calls a stable identity draft can trust

## Goal
Stop recognizing Kiro CLI's "Tool Load" call by its shape.

## Notes
- kiro-cli 3.5.0 sends `tool_call` "Tool Load" (kind other, rawInput `{id: "tool::<server>::<tool>"}`, `_meta.kiro.toolOrigin: "default"`) without a permission request. draft treats it as read-only only for that exact shape (ADR 06wp7907); anything else is an anomaly.
- Ask Kiro for a structured identity on built-in calls (as `_meta.kiro.mcpTool` does for MCP tools), or a read-only marker draft can rely on.

## Done when
- draft identifies Kiro's utility calls from a structured field, and the shape rule is gone.
