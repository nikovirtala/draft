# Ask for consent, keep voice profiles opt-in, and let people delete their voice data

## Goal
Everyone recorded agrees first, and each person owns their own voice data.

## Notes
- Consent is an event per person per session; recording starts only after the people present agreed; someone who joins later is asked then.
- Voice profiles are opt-in and stay on the device: a profile identifies a person, which makes it biometric data, a special category under GDPR that needs explicit consent. Without a profile a person gets a speaker label, never a name.
- Anyone can delete their profile and their segments' audio. Audio lives beside the log, so deleting a chunk leaves the log intact with a tombstone event; transcripts of a removed range are retracted the same way.
- A voice nobody consented for (found by the on-stop pass) is left out of the digest until someone adds them and asks, or removes their audio (canvas VoiceStop, marker 3).

## Done when
- Recording can't start without the consent events of the people present, and a late joiner is asked.
- Deleting a profile or one's audio leaves tombstones, retracts the transcripts, and keeps the log verifiable.
- An unconsented voice is excluded from the digest until decided.
