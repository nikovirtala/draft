# Open the message an attention item points at

## Goal
Each item under "N need you" takes the person to the message, interrupt or thread it counts.

## Notes
- Niko's feedback after using draft on 23 Nov 2026. Today AttentionBar.tsx renders each item as a list entry with its cause, conversation and age, and nothing to click.
- Reuse the moves the map uses to open an item (`OpenTarget`), so there is one way of going to something.

## Done when
- Clicking an item, or Enter on it, scrolls to and focuses its block, in a thread when it is in one; the e2e test covers a permission request and an acceptance request.
