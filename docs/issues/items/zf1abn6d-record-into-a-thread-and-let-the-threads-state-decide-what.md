# Record into a thread, and let the thread's state decide what the agent hears

## Goal
Turning the mic on records the room into the thread; what the agent receives follows the thread's existing agent state, so voice adds one switch and reuses play and pause.

## Notes
- The doc's table: mic off records nothing; on and paused, segments land for people only; on and listening, the agent receives finalized segments in batches at turn ends and stays silent, extracting candidates; on and active, it also answers when addressed. It acts only when the driver approves.
- Two indicators, always both: recording, and agent is hearing. Stop ends recording for everyone in the room.
- The agent never sees volatile text: only finalized segments, each with id, speaker and language, so answers cite segments and a citation plays its audio.
- Addressing is explicit: the agent's name, or holding the push-to-talk key (Space or the mic button). Dictation into the composer stays available, like Claude Code's /voice. Typed input is attributed to the driver, spoken input to the resolved person; the driver rule decides whose instructions steer.
- A low-confidence speaker shows dimmed with one-click correction (speaker.corrected), asking by elimination for people without a profile (canvas Voice, marker 3).

## Done when
- In a fixture session, paused, listening and active threads each give the agent exactly what the doc's table says, and volatile text never reaches it.
- Addressing by name and by push-to-talk is detected; talking near the agent is not addressing it.
- A segment is an item that can be referenced, and an agent citation plays its range.
