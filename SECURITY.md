# Security policy

draft is a personal project maintained by a single person, so there is no
formal bug-bounty program and no guaranteed response time.

## Reporting a vulnerability

Please report security-sensitive issues **privately**, through a GitHub
security advisory at <https://github.com/nikovirtala/draft/security/advisories/new>
or by email to [niko.virtala@hey.com](mailto:niko.virtala@hey.com), rather than
opening a public [GitHub issue](https://github.com/nikovirtala/draft/issues).
This keeps the details out of public view until there is a fix.

Include what you can: the draft commit or version, your operating system, the
agent you were running (Kiro CLI or claude-agent-acp, with versions), steps to
reproduce, and the impact you saw.

## Scope

draft runs agents on your machine and acts as you through your own `git`, `gh`
and `adr`. Reports about any of these are in scope:

- an agent changing something without a permission step, or accepting, merging
  or rejecting on your behalf
- a credential, token or key leaving the place it is kept (Electron safeStorage,
  your git and gh configuration, `ANTHROPIC_API_KEY` in the environment)
- content from one context reaching another context's agent without a person
  pulling it in
- a way to rewrite a context's log without its hash chain showing it
