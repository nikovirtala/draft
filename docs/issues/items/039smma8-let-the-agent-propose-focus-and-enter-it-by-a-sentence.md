# Let the agent propose focus, and enter it by a sentence

## Goal
"Focus on the PR thread" enters focus only when a person accepts a proposal; the agent never applies it.

## Notes
Focus is entered by the keyboard gesture only for now (Ctrl or Cmd + period on the selected block, Esc to leave). The placement state machine already refuses any move by the agent.

## Done when
- A sentence from the person, or an agent proposal they accept with one gesture, enters focus.
- Nothing the agent writes changes the layout on its own.
