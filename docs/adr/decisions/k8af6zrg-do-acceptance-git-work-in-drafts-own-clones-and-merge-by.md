# Do acceptance git work in draft's own clones, and merge by rebase

## Context
Accepting an ADR means a commit on the proposing pull request's branch, and checking the ADR (adr verify) needs the branch's files. draft must not touch the person's working copies: they may have uncommitted work, another branch checked out, or hooks the person set up for themselves. A merge has a method, and a repository's branch protection decides which methods it allows. ark's repositories need linear history and land with Rebase and merge.

## Decision
All git work of an acceptance happens in clones that draft manages under the device's data directory (acceptance/<owner>__<repo>), one per repository, never in a path the person works in. The clones serve repositories, not contexts (17gtag9n): they sit beside contexts/, not in it, and never in a context's trusted folder (1vey5j12), even when that folder is a checkout of the same repository. Acceptance events, steps and interrupts are written to the log of the context whose conversation the request lives in. Each action adds a detached git worktree at the commit it acts on, runs there, and removes it. The clone is made and fetched with the person's git, so their credential helper and URL rewrites apply; config.json can name the remote of a repository (gitRemotes), which tests use for a local bare repository. The accept commit is pushed to the branch of the proposing pull request with a plain push, never forced: if the branch moved, the push is refused and the evidence the person saw is out of date. A pull request is merged with the rebase method, at the head commit the person saw (the API's sha guard). draft requires nothing that branch protection does not: no signed commits, no up-to-date branch and no review beyond what GitHub itself says blocks the merge. If the repository does not allow rebase merges, the step fails with GitHub's answer; draft does not fall back to another method.

## Scope
packages/core/src/person-tools.ts

## Consequences
Each repository costs one clone on disk, fetched when an acceptance needs it. A repository that allows only squash or merge commits cannot be merged from draft until its settings change or a later decision adds a method. A stale head is a refused step, not a merge of something nobody looked at.
