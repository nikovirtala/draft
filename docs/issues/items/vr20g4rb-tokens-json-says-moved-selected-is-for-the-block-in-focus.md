# tokens.json says moved-selected is for the block in focus, which the design system no longer allows

## Goal
Correct the usage text of moved-selected in docs/design-system/tokens.json to the chosen option of a list or a control (and the selected row), as Selection/README.md and docs/design-system/README.md say.

## Notes
tokens.json:`moved-selected` usage reads 'the selected option, the block in focus, the row you are on'. palette.ts copies that text into PaletteEntry.meaning. Change it in the design system first, then run palette:sync.

## Done when
tokens.json, README.md and Selection/README.md agree; palette:sync leaves no diff.
