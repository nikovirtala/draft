# Voice, remote mob on a call

## Goal
A mob on a call, recorded from the driver's Mac, is attributed by channel: the room on the mic, the call on a system channel.

## Notes
- The doc's speech slice 2: a system channel beside mic, from a Core Audio process tap or ScreenCaptureKit; speakers resolved per channel, then mapped to people across the session. Room versus call is free; diarization runs within each.
- Nothing above the channel layer changes: the segment contract, revisions and the agent gate stay the same.

## Done when
- A recorded call session shows segments attributed by channel and settled to people after stop.
