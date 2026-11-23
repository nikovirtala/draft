# Run a real Kiro in CI with an API key

## Goal
draft's behaviour with a real Kiro (tools as steps, a call kept alive past its timeout, the note of what changed) is proven in CI, not on a person's Mac.

## Notes
- Part of moving checks out of After deploy and into CI (AGENTS.md, Pull requests). PRs #26 and #33 left their checks against a real kiro-cli to Niko, three of them three-minute waits.
- Kiro's CLI skips the browser sign-in when KIRO_API_KEY is set, meant for CI (https://kiro.dev/docs/cli/headless/). First check whether the key also works for `kiro-cli acp`, the mode draft uses, not only `chat --no-interactive`; if it doesn't, record that in this issue and stop.
- If it does: a job, on main and on pull requests that touch apps/desktop/src/main/acp, that installs a pinned kiro-cli and runs draft's ACP runtime headless against a scratch repository with scripted prompts: a write asks and runs once on allow, a deny leaves nothing, the agent has no built-in shell or write tool, a call answered after 3 minutes runs once.
- The API key is a repository secret only Niko can create: that is this issue's one step for a person.

## Done when
- The job passes on main with a real Kiro, and its log shows each scenario; or this issue records that acp doesn't accept an API key, with the evidence.
