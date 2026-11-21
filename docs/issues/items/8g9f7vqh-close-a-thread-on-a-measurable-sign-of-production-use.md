# Close a thread on a measurable sign of production use

## Goal
A thread closes when a usage signal, traced through deploy provenance, shows that what it produced is used.

## Notes
Depends on deploy provenance. Threads wait in shipped, with a timeout. Design: "Threads" in docs/model.md.

## Done when
- A shipped thread closes on usage evidence, or surfaces an interrupt at the timeout.
