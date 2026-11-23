# Use one pastel palette whose colours keep their meaning everywhere

## Goal
A colour means one thing across draft, so the person learns it once.

## Notes
- Niko's feedback after using draft on 23 Nov 2026. The map and graph use red and green; the design canvas uses a pastel set on cream: purple for what moved or the agent's activity (#7442c8, #EDE1FF), amber for what waits on a person (#fdefd3, #8a5200), teal for text and settled things (#005661), sand for structure (#e6d7b2, #cdcbb2), slate for secondary text (#5d6b6d). Keep how purple is used today.
- No red or green: an open loop or a failure is told by shape and words (a dashed outline, a label), never by colour alone, which also serves colour-blind people.
- The colours and their meanings are one table in one module (tokens in styles.css generated from it, or read by it), and every component uses the tokens, not literal colours; a test fails on a literal colour in a component.

## Done when
- The map, the graph, status stubs, interrupts and acceptance use the tokens, with no red or green left; the table of colour to meaning is in docs/implementation.md; screenshots of the map and a thread.
