# Show what a folder will run before it is bound, and say when Kiro won't ask

## Goal
Before a person trusts a folder for a context, draft shows what the agent will start and load there on its own, and while the agent runs, draft says plainly when the person's own rules mean it won't ask before acting.

## Notes
- Found in ?35, with kiro-cli 3.5.0 over ACP in a folder Kiro had never opened: Kiro starts every MCP server in the folder's .kiro/settings/mcp.json (a probe server's command ran) and lists the folder's .kiro/skills. Kiro's trust screen guards its interactive sessions only, so a repository's mcp.json runs commands on the person's machine as soon as its folder is bound, and draft's trust step doesn't say so.
- Show before trusting: each MCP server the folder defines, with its command and arguments, and the skills and steering it carries. Trust the folder with or without them.
- Options to research for keeping them out, none tried yet: a session option or _meta field over ACP that skips workspace configuration; starting Kiro with a separate KIRO_HOME; whatever Kiro offers for workspace trust over ACP. Check each against a real kiro-cli, as ?35 did.
- Also found in ?35: Niko's ~/.kiro/settings/permissions.yaml holds a user-wide capability: all allow rule, on purpose, so Kiro wrote a file without session/request_permission even with autopilot off, and draft saw it only afterwards. ADR 06wp7907 already says rules outside draft apply; draft should read them and say so.
- Read the person's Kiro rules (user-wide ~/.kiro/settings/permissions.yaml and the workspace's file under ~/.kiro/workspace-roots/) when an agent starts. When an allow rule means Kiro won't ask for a capability, the agent status says which capability and names the file, as information, not a warning to act on: trusting everything can be the person's deliberate choice, and then draft's call-without-asking notices are the record. draft doesn't change the person's rules.
- claude-agent-acp is not affected in the same way: draft passes settingSources: [] and switches it to mode default.

## Done when
- The trust step lists the folder's MCP servers with their commands, and its skills and steering, before the person answers.
- A folder can be trusted without its .kiro configuration, or the trust step says why that isn't possible yet, with the research behind it.
- With a Kiro allow rule that stops Kiro asking, the agent status names the capability and the rule's file; tested with a fixture rules file.
- A real kiro-cli turn, recorded like ?35, shows the result.
