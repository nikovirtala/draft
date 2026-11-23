# the caret blink and the message actions fade ignore prefers-reduced-motion

## Goal
Every animation and transition stops or becomes instant under prefers-reduced-motion, in the one block at the end of styles.css.

## Notes
styles.css:284-292 (`.caret`, `blink` infinite) and :967-968 (`.message-actions` opacity transition) are not in the reduced-motion block at :2150, which holds only `.working-ring`.

## Done when
The reduced-motion block lists the caret (still, visible) and the actions; a test fails on an animation or transition outside it.
