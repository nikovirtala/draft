# Settle speakers on stop, keep revisions, and offer a digest

## Goal
Stopping a recording replays it: the on-stop pass writes revision 2 of every segment, speakers settle, and a digest proposes decisions, open questions and tasks for acceptance.

## Notes
- A segment is an item with revisions: ids stay stable, live is revision 1, the on-stop pass revision 2, a replay with a newer pipeline the next. Views show the latest; older ones stay for audit and comparison.
- Live diarization tops out at four voices; the on-stop pass settles labels and can find more (canvas VoiceStop).
- The digest keeps Granola's split: people's segments stand as said, the agent's candidates wait for a yes, as acceptance (relates to ?41).
- Exports are views over the events: WebVTT, SRT, RTTM to compare diarizers, Markdown for ark records.

## Done when
- After stop, every segment has revision 2 with stable ids, and references made during the session still resolve.
- The digest's candidates appear as acceptance requests and can become an ADR draft or an issue.
- The four exports are produced from the events.
