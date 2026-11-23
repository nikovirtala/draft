# a selected stub is filled with moved-selected from edge to edge

## Goal
A selected stub that holds the map (or any body) is drawn whole on moved-selected: the map, its state cells and Recent moves all sit on purple. Mark it as a selected block-full is marked: the header row on moved-selected, the body on its usual ground. A stub with no separate body stays filled whole.

## Notes
The design system's Selection README said 'the block in focus: moved-selected', right for a row and wrong for a block with a body.

## Done when
A selected stub with a map has moved-selected on its header and not on its body (renderer test); the Selection README, the meanings in docs/design-system/README.md and preview.html say 'the selected row, the header of the block in focus'; screenshots of a selected map stub and a selected one-line stub.
