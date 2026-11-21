# Adapt placement from the move record

## Goal
After a person moves the same kind of block repeatedly, adapt its placement for that kind in this context, say so once, with undo and the moves as evidence.

## Notes
The device records every placement change (block, kind, from, to, when, cause) in the moves table of apps/desktop/src/main/view-state.ts; nothing reads it yet. Ignore causes focus and focus-restore. Design: "Feedback, everywhere" in docs/model.md.

## Done when
- Repeated moves of one kind propose an adaptation with the moves as evidence, undoable, and withdrawn when undone.
