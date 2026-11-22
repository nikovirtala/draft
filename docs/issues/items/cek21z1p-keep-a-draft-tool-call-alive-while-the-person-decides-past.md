# Keep a draft tool call alive while the person decides, past Kiro's MCP request timeout

## Goal
A write, an edit or a command that asks the person doesn't fail because the agent's MCP client gave up waiting.

## Notes
draft's own tools (adr:56v0mtga) ask inside the MCP call, so the call is open while the person decides. Kiro's per-call MCP `requestTimeout` is 120000 ms by default (https://kiro.dev/docs/custom-agents/configuration-reference/), and Claude's and other agents' differ. When the client hangs up first, draft doesn't run the call (it is a failed step the agent is not told about). Options: send MCP progress notifications while waiting (does Kiro reset its timeout on progress?), answer the agent's own permission request only after the person decided (needs the agent to ask, which Kiro with allow-all rules doesn't), or return an error that tells the agent to call again once the person has answered. Check on a real Kiro first.

## Done when
- A call the person answers after 3 minutes runs, or the agent is told to call again and the second call runs once.
- The choice is recorded in an ADR that refines adr:56v0mtga.
