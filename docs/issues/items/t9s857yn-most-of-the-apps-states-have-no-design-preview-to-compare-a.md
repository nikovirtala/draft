# most of the app's states have no design preview to compare a screenshot with

## Goal
Give each part of the app a preview in docs/design-system/components, so a rule can change in the picture first and each screenshot has its own design beside it.

## Notes
e2e/states.json maps the frame (f01, f02, f03) to the Cover, NoticeAndWorking and Selection previews, which draw other things. Without a preview: the frame (title bar, footer), the composer, a message, a thread stub, a check, an interrupt or permission prompt, the by-state map's cells and arcs, a block's header.

## Done when
Every state in states.json names a preview that draws that state; the screenshot comment shows a matching pair.
