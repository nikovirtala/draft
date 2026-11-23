# Record what a person or an agent does as a command, apart from the states it causes

## Context
In the first picture of the causal trace, a person's act read "merged", the same as the pull request's new state. But what a person does (merge, send, launch, accept) is not a state of anything: it is the cause of a state. The same holds for what an agent does on the person's behalf. Drawn as states, the trace hides who acted, and the three notes Claude sent on 23 November 2026 were first shown as the person's.

## Decision
What a person or an agent does is recorded as a command: an imperative (merge, send, launch, accept), its actor (the person, or the agent and on whose behalf, as ARK_AGENT and ARK_ON_BEHALF_OF already say), its time, and the target it acted on. A command is a cause: the facts and transitions it leads to cite it. A command has no state and is never drawn as one; the causal trace shows it as a command with its actor beside it.

## Scope
draft's log, the facts recorded for the person's and the agent's acts in threads, acceptance and checks, and how the map and the causal trace draw them.

## Consequences
Easier: the trace answers "who did this?" without guessing from the actor of the state that followed, and the person's own share of a chain (the merges, the acceptances) can be counted.

Harder: acts recorded today as state changes with an actor have to be split into a command and the state it caused, read first, write later.

Risk: an act from outside draft (a merge in GitHub's web page) arrives as the state only; its command is reconstructed from the source's actor and marked as such, never invented.
