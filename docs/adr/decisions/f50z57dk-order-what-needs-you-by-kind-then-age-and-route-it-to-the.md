# Order what needs you by kind, then age, and route it to the conversation it belongs to

## Context
Permission requests from hosted Kiro sessions, pull request events and interrupted steps all need a person. They must arrive where they belong and in one order, or the count tells nothing about what to do first (docs/model.md, "Threads", "Acceptance").

## Decision
Every interrupt has a kind with a rank: blocking permission requests, then failures (failed checks, merge conflicts, changes requested, failed steps, calls that ran without asking), then what is left to resolve (interrupted steps, a conclusion to confirm), then reviews requested. Within a rank the oldest comes first, then its place in the log. A hosted session belongs to the conversation whose step launched it (its step.completed result names the session), else the conversation that first referenced it, else the main conversation. Other targets belong to the conversation that first referenced them, else the main one. Only a person settles an interrupt; the source clears one that no longer applies, with a reason. Acceptance requests will join as a kind with a rank.

## Scope
packages/core/src/interrupts.ts, the Projection.ownerOf rule and the attention list in the desktop app.

## Consequences
One count and one list for all conversations. Failures outrank interrupted steps even when the step is older. Which kind a new interrupt has is a decision each time. A key that was settled stays settled while the source keeps reporting the same thing (same check on the same commit).
