# Check an agent's work with a second agent before acceptance

## Goal
Before an acceptance request for an agent-produced record appears, a checker agent in its own session reads and tests its claims, and its verdict becomes an evidence row.

## Notes
- Design: docs/model.md, "Acceptance". The checker reads and tests and never changes the work; its yes is evidence, never the acceptance.
- Open question there: every record, or only above some size or risk.

## Done when
- A request with a claim the checker can't confirm isn't shown, and the claim is listed struck through with the reason.
- The checker's session starts without the producing session's context; a test reads what it was given.
- Proven against the scripted ACP agent with one claim that holds and one that doesn't.
