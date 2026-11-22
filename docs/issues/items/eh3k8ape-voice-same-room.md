# Voice, same room

## Goal
A mob in one room, in Finnish and English, can talk with draft running on one Mac: speech lands in the thread as segments with speaker, language and time, and the thread's agent state decides what the agent hears. Recording is not hearing.

## Notes
- Design: docs/model.md (Voice) and docs/implementation.md (Speech) in the draft design doc, and the canvas screens Voice and VoiceStop, as of 2026-11-22.
- The doc's speech slice 1 and the prototype plan's "Voice, same room" step: one mic channel, chunked lossless audio, the live pipeline, the on-stop pass as revision 2, voice profiles, one-click correction, consent, and the agent gate. It needs no hosted log, so it can come before multiplayer.
- Split into the parts below; each is one pull request.

## Done when
- Every part below is closed.
- A recorded mob session on Niko's Mac shows segments in the thread, the right agent state gating what the agent hears, and a digest after stop.
