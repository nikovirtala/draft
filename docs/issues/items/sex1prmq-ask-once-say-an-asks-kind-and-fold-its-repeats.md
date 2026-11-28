# Ask once: say an ask's kind and fold its repeats

## Goal
Every interrupt starts with its kind (Do, Decide, Stuck), and the same ask raised again folds into the open one with its count and its age from the first time.

## Notes
- Design: docs/model.md, "Asking once". Roadmap slice 10 in the design spec; the PromptAndInterrupt preview changes first.
- Keys stay as they are: a settled ask raised on new evidence is a new ask.

## Done when
- Raising the same key three times shows one ask with a count of three and the age of the first raise; the log keeps all three.
- Every interrupt kind maps to one ask kind, and a test fails for one that doesn't.
- A notification outside draft, when there is one, is sent once per ask.
- Proven in Electron against the fake Kiro Remote and the scripted ACP agent.
