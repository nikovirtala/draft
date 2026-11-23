# Fail CI on Electron deprecation and runtime warnings

## Goal
A deprecated Electron API or a runtime warning fails CI before anyone has to see it in a terminal.

## Notes
- Part of moving checks out of After deploy and into CI (AGENTS.md, Pull requests). The safeStorage deprecation (fixed in #38) printed at every start and was found by hand.
- The end-to-end run collects the main process's and the renderer's console; a line matching `(electron) … deprecated` or a renderer error fails the run, with a short allow-list in one place for warnings that are understood.

## Done when
- A deliberate deprecated call fails the end-to-end job with the line in its log; the allow-list is empty or each entry says why.
