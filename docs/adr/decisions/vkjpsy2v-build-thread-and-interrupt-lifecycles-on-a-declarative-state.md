# Build thread and interrupt lifecycles on a declarative state machine module

## Context
Kinds are state machines (docs/model.md). The thread lifecycle and the interrupt lifecycle need states, actors allowed to fire each transition, terminal states with reasons, and a check that nothing has an open end. Kinds will need the same.

## Decision
packages/core/src/machine.ts holds a small declarative module: states (active, waiting with an owner and a timeout, terminal), transitions with a trigger and the actors who may fire them, standard ends (dismissed, superseded, withdrawn) that need a person and a reason, a checker that refuses a machine with an unreachable state, an open end, a wait without an owner or timeout, or a transition nobody may fire, and a replay that reports firings the machine does not allow. The thread and the interrupt machines are defined with it, and a thread folds its events through its machine on read.

## Scope
packages/core/src/machine.ts, interrupts.ts and thread.ts, and every future kind.

## Consequences
Lifecycle rules are data that can be checked and diffed. A firing the machine refuses is counted as a violation when the log opens, not applied. Guards and effects are not in the module yet; kinds add them. wrapped-up is terminal until closing on production use adds states after it.
