# Check the map's counts against the repositories' own logs

## Goal
The map's decisions and issues counts are proven equal to what the adr and issues tools report, without anyone comparing them by hand.

## Notes
- Part of moving checks out of After deploy and into CI (AGENTS.md, Pull requests). The first map was checked by hand against `adr list` and `issues list` in draft, ark and kiro-remote.
- A contract test folds this repository's own docs/adr and docs/issues through the map's kinds and compares the counts per state with the tools' JSON output, run in CI.

## Done when
- The test passes on main and fails when a fold miscounts a state (shown by a mutation in the test's own fixture).
