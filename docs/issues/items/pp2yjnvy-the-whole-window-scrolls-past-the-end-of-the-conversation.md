# the whole window scrolls past the end of the conversation

## Goal
The window never scrolls: only the conversation and a panel's own body do. With a long map in the conversation (window about 1960 px wide), scrolling past the end of the conversation moves the title bar out of view and lifts the footer to the middle of the window, with empty page below, and two scrollbars show.

## Notes
Find the element that grows past 100% (a flex child or grid row without a bound) and fix it there, not with overflow: hidden on body alone. Applies to the main window and to a block's own window.

## Done when
With a conversation much taller than the window, scrolled to the end, document.scrollingElement.scrollHeight equals innerHeight, the footer's bottom equals the window's bottom and the title bar's top is 0; an e2e test holds it.
