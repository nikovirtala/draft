# Write to GitHub only as the person, with their own git, gh and adr, from a UI action

## Context
ADR 9p8jj6p5 makes draft's GitHub client read only. Accepting an ADR or merging a pull request is a write: a commit, a push and a merge. docs/model.md says accepting is done as the person, with their identity and signing key, and never goes through the agent. If draft held a write token or a private key to do it, draft would be handling a secret, which no ADR allows.

## Decision
The read client stays as 9p8jj6p5 decided: it can only GET. Writes are a separate module, the person's tools, that starts the person's own programs and gives them nothing: git (identity, signing key and credential helper come from the person's git config), gh api (gh's own sign-in, REST only) and the adr CLI. draft never reads a key or a write token, never passes one in, and never stores one. The module is reached from one place, a person's answer to an acceptance request in the UI. The agent's tool policy refuses every tool that accepts, rejects or merges, whichever MCP server it comes from, and the state machine of an acceptance request marks those transitions as person only. The person's tools remove ARK_AGENT and ARK_ON_BEHALF_OF from the environment, so ark records the person and not an agent. A commit is signed or it is not made: draft turns signing on for the commit and refuses to start when the git config has no identity or no signing key. If the person's git or gh cannot do a step without draft holding a secret, the step fails and says so; draft has no fallback that would hold one.

## Scope
packages/core/src/person-tools.ts

## Consequences
A person without gh, a signing key or a git identity cannot accept from draft and is told which is missing. gh and git show their own prompts and errors, and draft reports them as the step's failure. GITHUB_TOKEN in the environment is read by gh when it runs, as it would in the person's own terminal. Tests use a fake gh that forwards to a fake GitHub, so the real sign-in is only checked on the person's machine.
