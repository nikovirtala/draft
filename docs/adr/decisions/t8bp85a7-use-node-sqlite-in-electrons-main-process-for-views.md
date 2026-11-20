# Use node:sqlite in Electron's main process for views

## Context
draft keeps its views (messages, tool calls, reference edges and live stubs) in SQLite, rebuildable from the log alone. The design prefers `node:sqlite` because it needs no native module rebuilt for Electron, with `better-sqlite3` as the fallback if Electron's Node lacks it.

Checked on Electron 45.4.1: `process.versions.node` is 24.22.3, and `require("node:sqlite")` in the main process opens a database and runs queries (SQLite 3.54.1). `node:sqlite` is a release candidate in Node 24.

## Decision
draft uses `node:sqlite` (`DatabaseSync`) in the Electron main process and in `packages/core`. It doesn't add `better-sqlite3`.

The projection (`views.db`) and the per-device view state (`device.db`, block placements) are separate databases. Neither is a source of truth: the projection is rebuilt from the log when it isn't a prefix of it.

## Scope
Every SQLite use in draft: the projections in `packages/core/src/projection.ts` and the view-state store in `apps/desktop/src/main/view-state.ts`.

## Consequences
- No native module, no electron-rebuild step, and the same code runs under Node 26 in tests and under Electron's Node 24 in the app.
- The API is synchronous and runs on the main thread; heavy rebuilds of large logs would block it. Moving projection work to a utility process is the escape hatch.
- `node:sqlite` is still a release candidate, so its API could change between Electron majors. The types come from `@types/node` 24 to match Electron's Node.
