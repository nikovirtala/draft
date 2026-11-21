# Load Claude's skills and memory without its permission settings

## Goal
Let Claude in draft use the skills, memory files and plugins from `~/.claude` and `.claude` again, without the settings that can allow tools.

## Notes
- Slice 2 starts claude-agent-acp with `settingSources: []` so user settings can't skip draft's permission requests (ADR 06wp7907). That also drops skills and CLAUDE.md memory.
- See what the adapter accepts in `_meta.claudeCode.options` (settings, plugins, `systemPrompt`) to load them separately.

## Done when
- A skill from `~/.claude/skills` works in a draft conversation on Claude, and a user setting that allows a Kiro Remote tool still doesn't skip the prompt.
