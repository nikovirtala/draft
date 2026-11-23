# the title bar is filled with moved-fill while a block is in focus

## Goal
While a block or conversation is in focus, the title bar (a window header) is drawn on moved-fill. Purple never fills a window header: keep the title bar on titlebar and say the focus in words (the 'In focus' mark of the attention bar already does).

## Notes
apps/desktop/src/renderer/src/styles.css:1019 (`.app[data-focused="true"] .titlebar`). Rule: docs/design/draft-design-spec.md, Where things may appear.

## Done when
No rule puts moved-fill or moved-selected behind a title bar or any header (a renderer test and the app-wide purple-fill e2e check); a screenshot of the focus state beside its preview.
