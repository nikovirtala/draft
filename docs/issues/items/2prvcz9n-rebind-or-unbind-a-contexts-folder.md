# Rebind or unbind a context's folder

## Goal
A person can change or remove the folder a context's agent works in, with a new decision in the log.

## Notes
Today a folder is bound only through the trust step when it is opened; the registry holds the path and the log holds each decision (the latest is in force). Existing sessions keep their directory until they restart.

## Done when
- A context's folder can be changed or removed from its window.
- Each change is a decision event as the person.
- The agent's next session starts in the new place.
