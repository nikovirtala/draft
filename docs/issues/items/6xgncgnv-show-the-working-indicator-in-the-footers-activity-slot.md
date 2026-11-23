# Show the working indicator in the footer's activity slot

## Goal
The one quiet global place for work with no block of its own is the footer's activity slot, not the title bar.

## Notes
GlobalWorking sits beside the agent's state in the title bar until the footer exists with its data-testid footer-activity slot (see the footer issue). Moving it is one line in App.tsx.

## Done when
GlobalWorking is rendered in the footer-activity slot and no longer in the title bar; its test finds it there.
