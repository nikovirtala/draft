# Keep the person's credentials out of the agent's process

## Goal
The agent can't act as the person on GitHub, git remotes or AWS through its own shell. Acting as the person goes through draft's acceptance only.

## Notes
- Found on 2026-11-22 while testing acceptance: the Kiro agent ran gh as Niko (gh auth status showed nikovirtala, with the repo and workflow scopes) and offered to rebase-merge nikovirtala/draft#14 itself. With a Kiro rule that allows everything, nothing stops gh pr merge. That goes around acceptance and breaks "the agent never acts under your identity" (implementation.md, Audit).
- The agent process runs as the person's operating-system user, so it reaches whatever that user's tools reach: gh's token in the keychain, git's credential helper (osxkeychain on macOS), SSH keys and the SSH agent, AWS profiles and the SSO cache, npm tokens.
- First layer, the environment: start the agent with its own empty GH_CONFIG_DIR, GH_TOKEN and GITHUB_TOKEN unset, GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL pointing at a file draft writes with no credential helper, GIT_TERMINAL_PROMPT=0, SSH_AUTH_SOCK unset, and AWS_PROFILE and the other AWS variables unset. Kiro's own sign-in must keep working: check where kiro-cli keeps it before changing anything it reads.
- That stops casual use, not a process that reads files. The real boundary is a sandbox: research Kiro V3's local command sandbox and macOS sandboxing for the agent's shell, and what each keeps out (~/.aws, ~/.ssh, the keychain).
- Work that needs the person's credentials goes through draft's steps (acceptance, Kiro Remote), never through the agent's environment.

## Done when
- In a real turn, gh auth status and git ls-remote against a private repository fail from the agent's shell, while draft's acceptance still merges as the person and Kiro still signs in.
- The environment draft builds for the agent process is unit-tested.
- What the agent can still reach (files the user can read) is written down, with what the sandbox research found.
