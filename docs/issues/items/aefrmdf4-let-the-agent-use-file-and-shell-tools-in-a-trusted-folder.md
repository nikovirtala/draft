# Let the agent use file and shell tools in a trusted folder, as asking steps

## Goal
In a context bound to a trusted folder, the agent's own read, edit and shell tools can run, each one that changes something asking first and recorded as a durable step.

## Notes
The working directory is the folder now, but decideTool still refuses every tool except Kiro Remote's (ADR 06wp7907, refined by 1vey5j12), so the agent can't yet do project work. Needs a decision on which tools, how they are identified without trusting titles, and how Kiro's own workspace trust interacts.

## Done when
- A call that changes a file or runs a command in the folder asks, is a step before it runs, and is refused outside the folder.
- Reads inside the folder run without asking and are logged.
- An untrusted context keeps today's policy.
