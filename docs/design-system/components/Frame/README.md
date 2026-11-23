# Frame

The window: the title bar (`titlebar`, a `line` hairline below), the conversation on `page` in one column, the composer, and the footer. With a block open beside the conversation, the panel is a column on `page` after an 8px divider; the thread open in it is told by its "In the panel" chip, and nothing in the window is filled with purple.

The preview draws:

- the window, conversation only;
- the side panel open, with keyboard focus on the divider (a 1.5px `moved-mark` ring, no fill);
- what needs you: the count at the right of the title bar in `waiting-word`, and its list on `surface`, one wait chip for each item;
- a window scrolled to the end, and a block's own window scrolled to the end: only the conversation or the block's body scrolls, the title bar, the block's header, the composer and the footer stay;
- the footer's ground, two ways, side by side: **A**, on the page, as built; **B**, on `titlebar`, as `tokens.json` says ("The title bar and the footer"). Which one is right is a decision for the person; neither is chosen here.

Screenshots it is compared with: `f01`, `f03`, `a04`, `w01`, `w02`.
