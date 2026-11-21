# Fork a second opinion from a thread

## Goal
"Ask Claude about this" opens a sub-thread with another agent, seeded with the same projection; its answer comes back as a reference and the original agent keeps its context.

## Notes
Reuses Workspace.branch with an agent and buildAgentContext (ADR h89hcrk6). Design: "Threads" in docs/model.md.

## Done when
- A sub-thread starts on another agent from the parent thread's projection.
- Its answer returns to the parent thread as a reference.
