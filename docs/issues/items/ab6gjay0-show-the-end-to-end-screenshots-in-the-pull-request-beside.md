# Show the end-to-end screenshots in the pull request beside the design

## Goal
Whoever reviews a UI change sees its screenshots in the pull request, next to the accepted design, without downloading artifacts.

## Notes
- Part of moving checks out of After deploy and into CI (AGENTS.md, Pull requests). PR #41's colours came out dark; its screenshots existed but were not looked at until Niko did.
- The end-to-end job takes screenshots of named states (a thread, the map's graph and grid, a stub of each pull request state, an acceptance request) and posts them to the pull request (a comment updated on each push, or the job summary), each beside the matching preview from docs/design-system/components.

## Done when
- A pull request that changes the renderer gets the screenshots in its conversation, updated on each push, with the design system's preview beside each.
