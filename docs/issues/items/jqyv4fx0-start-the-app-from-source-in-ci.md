# Start the app from source in CI

## Goal
CI fails when the app can't start the way a developer starts it, from core's source with no dist/.

## Notes
- Part of moving checks out of After deploy and into CI (AGENTS.md, Pull requests). PR #32 imported a core subpath the Vite aliases didn't list; CI built core's dist/ first, so only `pnpm dev` on a Mac found it (fixed in #35).
- A job that removes packages/core/dist, builds the desktop app with electron-vite and starts it headless long enough to load the renderer, failing on a resolve error.

## Done when
- A core import the aliases can't resolve fails CI, shown by a test commit that removes one alias.
