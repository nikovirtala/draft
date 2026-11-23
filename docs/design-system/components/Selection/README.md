# Selection

How purple is meant to be used, after the Wisteria Lily theme. Purple is layered, not one flat accent:

- a row under the pointer: `moved-fill`, the words unchanged;
- the chosen option in a list or a control: `moved-selected`, the words in `ink`. That is the context you are on in the Contexts menu, the "on" option of a segmented control (Last hour, Graph) and a chosen map cell. Nothing else is filled with `moved-selected`;
- keyboard focus: a 1.5px `moved-mark` ring, no fill, shown through `:focus-visible` only, so a click shows nothing;
- what changed or is under way: its name in pastel `moved-word`, with a dot or a letter beside it;
- an active place in a rail: a `moved-fill` tile with a `moved-mark` icon;
- a count of changes: a small `moved-strong` badge with the number in page colour, the only strong purple.

**A block is never filled.** A stub, a thread stub, a block in the panel or a window, and the headers of the panel and of a window stay on their own ground (`raised` for a stub, `page` for a header) whether the block is selected, clicked, expanded, focused or open in the panel. A thread open in the panel says so with its small "In the panel" chip and nothing else.
