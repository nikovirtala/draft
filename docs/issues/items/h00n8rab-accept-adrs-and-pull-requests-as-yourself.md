# Accept ADRs and pull requests as yourself

## Goal
Show an acceptance request as an interrupt, only with green evidence, and let the person accept an ADR or merge a PR as themselves.

## Notes
Next slice. The PR resolver's snapshot has check runs, reviews and mergeability; the ark issue resolver has status and events; the attention order takes a new kind with a rank. Needs an ADR resolver.

## Done when
- An acceptance request appears only when its evidence is green.
- Accepting runs as the person's git identity and is logged with them as actor.
