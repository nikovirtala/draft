# Replay, compare and look back with the time machine

## Goal
The map shows any moment of the context: a time bar with replay and play, a comparison of two moments, every lens at any moment, and a moment that can be referenced from the conversation.

## Notes
- Design: docs/model.md, "The time machine"; spec's planned time bar and M6. foldMap already folds to a position; replay needs it fast enough to scrub.
- Reduced motion steps from event to event.

## Done when
- Scrubbing a month of the fixture keeps the frame under 16 ms per frame on the 5,000-item synthetic context, measured in CI.
- Replay adds and recolours dots at their places and never moves one; a test holds it.
- Comparing Monday with now lights exactly what was new, moved or closed in between, tested on the fixture.
- The map at a position is an address; referencing it in the conversation opens the map there.
- Under reduced motion no animation plays; a test checks the renderer asks matchMedia.
