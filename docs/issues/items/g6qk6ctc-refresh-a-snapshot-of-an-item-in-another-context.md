# Refresh a snapshot of an item in another context

## Goal
A person can take a new snapshot of a referenced item of another context, recorded as a crossing, without changing the old one.

## Notes
Snapshots are taken once when referenced and never change (ADR gw4vxvw4). Also: a reference to a context or to a thread conclusion, and addresses typed with an imported log's own context name.

## Done when
- A newer snapshot sits beside the first, with its hash.
- The agent's context uses only what was pulled in.
