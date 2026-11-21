# Check a real turn on claude-agent-acp

## Goal
Run one real turn on Claude through claude-agent-acp, with Kiro Remote's tools, and keep its transcript.

## Notes
- Slice 2 checked the adapter (0.109.0) in the sandbox up to the prompt: draft's `session/new` meta and the switch to mode `default` take, and a missing or wrong key ends the turn with the message that says how to set `ANTHROPIC_API_KEY`. No key was available for a real turn.
- `DRAFT_REAL_AGENT=claude pnpm --filter @nikovirtala/draft-desktop exec vitest run test/real-agent.test.ts`, with `ANTHROPIC_API_KEY` set and `claude-agent-acp` on PATH.

## Done when
- The real-agent test passes on Claude: a permission request before `kiro_launch_session`, a step, no anomaly.
- The transcript is attached to the issue or a PR.
