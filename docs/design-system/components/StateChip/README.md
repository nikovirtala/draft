# StateChip

One word or a short phrase for an item's state: a pastel fill, the word in the same hue, no outline, 7 px corners, weight 500. It is the delivery board's chip, used for every state in draft: pull requests, checks, evidence, waits, the map's legend and its cells.

| Meaning | Fill | Word | Mark | Examples |
| --- | --- | --- | --- | --- |
| Moved, the agent's activity | `moved-fill` | `moved-word` | `moved-mark` | Working, moved 2 min ago |
| Done, settled | `done-fill` | `done-word` | `done-mark` | Merged, 8/8 checks passed, approved |
| Under way elsewhere | `review-fill` | `review-word` | `review-mark` | Open, 4 running, in review |
| Waits on you | `waiting-fill` | `waiting-word` | `waiting-mark` | Your review, proposed, permission asked |
| Failure | `waiting-fill`, a dashed `waiting-mark` hairline | `waiting-word` | a cross | 2 failing, merge conflict |
| Not started | none, an `idle-line` hairline | `muted` | | Not started, closed |
| Open loop | none, a dashed `loop-mark` hairline | `muted` | | Open loop |

- The word always says the state; the colour only repeats it. A failure is told by its cross and dashed outline, not by a colour of its own.
- The board's word colours (#009456, #973cff, #0a7fd1, #b87700) are 3.2 to 3.8:1 on their fills, under the 4.5:1 small text needs. draft keeps the hues and darkens the words just enough (`*-word`); the board's values stay for marks (`*-mark`).
