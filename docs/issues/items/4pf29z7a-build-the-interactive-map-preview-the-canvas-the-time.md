# Build the interactive map preview: the canvas, the time machine and the stack

## Goal
A Map preview in docs/design-system that runs: the mesh on a WebGL canvas with real data from draft's log, continuous zoom and pan, the lens switch and the list beside it, the time bar with replay and compare, and the tilt into the time stack. It is the picture the canvas, the time machine and the stack are accepted from.

## Notes
- Design: docs/model.md, "The map", "The time machine", "The time stack" and "For every reader"; the spec's planned canvas, time bar and stack, motion rule M6, roadmap slice 12.
- The static Graph and Chain previews fix the light, the pills and the marks; the interactive preview follows them, never a second set of rules.
- The renderer it uses is the one the app will use, so the choice is proposed as an ADR here.

## Done when
- The preview opens in a browser from the repository, offline, and runs on a fixture folded from draft's own log (at least two weeks, the 23 November cascade included).
- Zoom, pan, fit, every lens, replay, compare and the tilt work by pointer and by keyboard, and the list beside the canvas says what is lit.
- Static renders of named moments (everything now, waiting on me, the trace, a replay frame, the stack tilted) are produced by a script for CI's comparison.
- A recording of a session with it is attached to the pull request.
- Measured on the fixture and on a synthetic context of 5,000 items: frames per second while zooming, panning, replaying and tilting, and time to scrub a month.
- The renderer choice is a proposed ADR.
- The preview is accepted.
