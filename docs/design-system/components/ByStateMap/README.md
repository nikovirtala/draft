# ByStateMap

The map's by-state layout: a row for each kind and a cell for each state, from start to terminal. A cell is a chip by state: `moved-fill` with `moved-strong` words for what is under way, `done-fill` for a terminal state, `waiting-fill` where something waits on you (with "2 for you" in words), and no fill with an `idle-line` hairline when empty. The chosen cell is the chosen option of a control: `moved-selected` with `ink` words, and its list opens below.

Arcs show the latest moves in a strip above the row. Each starts and ends on a cell's top edge, all share one arrowhead, the stroke grows with the number of items, and an arc that holds another is drawn higher, so none crosses another or covers a label. The preview draws a kind with three states and a kind with six. An empty context shows a sentence and no cells; its preview has keyboard focus on the chosen layout option, a 1.5px `moved-mark` ring, no fill.

Screenshots it is compared with: `m01`, `m03-cell-opened`, `m10`, `m11`.
