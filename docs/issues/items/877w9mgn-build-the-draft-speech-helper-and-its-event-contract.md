# Build the draft-speech helper and its event contract

## Goal
A Swift helper, draft-speech, does all speech work on the Mac and speaks to draft only in JSON-lines events, so everything above it is data that can be logged and tested without a microphone.

## Notes
- Swift 6, macOS 26, Core ML on the Neural Engine through FluidAudio: Parakeet TDT 0.6B v3 (transcription and language), Sortformer (diarization), Silero VAD, downloaded on first use and pinned by hash. Language per segment through NaturalLanguage, never chosen up front.
- Spawned by Electron's main process; commands on stdin (session.start, session.stop, profile.enroll, profile.delete), events on stdout (audio.chunk.written, segment.volatile, segment.finalized, segment.revised, speaker.resolved, helper.error, helper.health), as the event contract table and the segment.finalized example in the doc.
- Audio: capture rate, mono per channel, lossless ALAC in .m4a, one-minute chunks addressed by content hash; a segment points at {audioHash, start, end}; one monotonic session clock anchored to wall time once.
- Local only: no audio or transcript leaves the Mac. Rejected alternatives are in the doc (Node-API addon, Transformers.js, whisper.cpp, Web Speech, SpeechAnalyzer as the main engine).
- Parakeet's weights come under NVIDIA's open model licence: check it before shipping (relates to ?5).

## Done when
- The helper's events are tested against recorded fixtures (an English, a Finnish and a mixed recording with three to six speakers) with no microphone.
- helper.health reports the pinned model versions, and a revision names its pipeline by hash.
- draft stores every event in the context's log as it arrives, never edited.
