Architecture decisions in this repository are managed by adr: read .claude/skills/adr/SKILL.md before changing architecture, and follow it.

Issues in this repository are tracked with issues: read .claude/skills/issues/SKILL.md before starting, continuing or finishing work, and follow it.

## Commits

- Each commit is atomic: one logical change, self-contained. `main` has a linear history: branches are rebased, never merged, and land with GitHub's **Rebase and merge**, so every commit on a branch lands on `main` as it is.
- Fold a fix into the commit it fixes with `git commit --fixup=<sha>`, then `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main`. `fixup!` and `squash!` commits never reach `main`; CI refuses them and merge commits.
- CI checks the tip of each push, not each commit.
- Agents commit with their own git identity, never Niko's, and end messages with the trailers their harness asks for.

## Commit messages

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), as `commitlint.config.mjs` enforces:

    <type>(<optional scope>): <description>

    [optional body]

    [optional footer(s)]

- Types: `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`, `test`.
- Description: imperative mood, starting with a lowercase letter unless it starts with a proper noun or an acronym (`Electron shell`, `MCP tools`), no trailing period, at most 72 characters.
- The body explains *why*, not *what*.

## Pull requests

- One branch per pull request, from `main`, named `<type>/<short-description>`. Never stack pull requests: work that depends on an unmerged one waits until it is merged.
- Keep the branch current with `git fetch origin && git rebase origin/main`, and push a rebased branch with `git push --force-with-lease`, only to your own branch.
- Keep the description current as the work changes: what the change does and why, how it was tested, and what is left. Describe the change, not the mechanics. Use the template in `.github/pull_request_template.md`.
- "After deploy" lists only what a person must do or check on their own machine, each step written out in full with what they should see, starting from the command that gets them there. Never point to steps elsewhere.
- A merged branch is finished: follow-ups go on a new branch from `main`.
