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
- **Prove it before the pull request is done.** Whatever a test, a CI job or a local run can show, the pull request shows. Where your sandbox can't run a suite (the Electron app, a real agent CLI), CI can: push, wait for CI, read its results and artifacts (logs, screenshots) with `gh`, and fix what fails. "CI runs them" is never a reason to hand a check to a person.
- **A visual change starts from the accepted picture.** A change to a design rule (where a colour may fill, what focus or selection looks like, a token) goes into `docs/design-system` first: the rule's text, the tokens and the component's `preview.html`. The picture is accepted before code applies the rule; a rule in prose alone is not enough.
- **Check the rule across the whole app, not only your change.** A design or layout rule is a check the e2e harness runs after every test (the design system README's principles name them), so every state any spec reaches is checked. Don't add a narrower test for the same rule.
- **Compare every screenshot with its preview before you say ready.** CI's comment puts them side by side; open each one, and list in the pull request what you compared and what differed.
- **Keep "After deploy" as small as it can be.** It holds only what no test can show: a secret only a person has, a sign-in only they can do, a look or a decision only they can make. Each item says why no test can show it, and each step is written out in full with what they should see, starting from the command that gets them there; never point to steps elsewhere. When the same kind of check keeps landing there, add the test or CI job that takes it over, or file an issue for it.

  draft reads the section when the pull request merges and turns each item into a check that waits on the person, so write it in this shape. Write `Nothing` (with a reason after it, if you like) when there is nothing. Otherwise each top-level bullet is one check: its first lines say why no test can show it (a bold lead is its title), then the steps are a numbered list inside the bullet. A step holds its commands in code spans or fenced blocks and ends with what the person should see, after "You should see". An ADR id (8 characters, as adr writes them) in a bullet links the check to that ADR when it is proposed. A numbered list at the top of the section, with its reason before it, is one check. Anything else becomes one check that shows your Markdown as written.

      ## After deploy

      - **Look at the palette.** Why no test can show it: whether it looks right is a person's judgement. It also gates ADR 8rhwhgbw.
        1. In a terminal, run `pnpm --filter @nikovirtala/draft-desktop dev`. You should see a window open on cream.
        2. Type `show the map` and press Enter. You should see a graph of pale discs.
      - **Sign in once.** Why no test can show it: it needs your Kiro account.
        1. Run `kiro-cli login`. You should see a browser tab open.
- A merged branch is finished: follow-ups go on a new branch from `main`.
- Every change to `apps/desktop/src/renderer` follows the draft-design skill: read `.claude/skills/draft-design/SKILL.md` before you start, and work through its pre-merge checklist before the pull request is ready. A new kind of item in the conversation also follows `.claude/skills/draft-block/SKILL.md`.
