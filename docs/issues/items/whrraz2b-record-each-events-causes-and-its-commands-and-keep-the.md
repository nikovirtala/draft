# Record each event's causes and its commands, and keep the graph as an edges projection

## Goal
Facts and transitions in a context's log carry the causes their sources record, a person's or an agent's act is recorded as a command, and views.db holds the graph of everything draft reads as one edges table walked through causesOf, effectsOf and openEnds. This is the data the causal trace and the line's measures draw; the views are later issues.

## Notes
Decisions: cqwg12zy (causes, never inferred), p6hx9jdv (acts as commands), tmgcgdj8 (one edges projection in SQLite across contexts; a step up only when measured). Picture: docs/design-system/components/CausalTrace. Sources and their cause fields: kiro-remote's change feed (a wake's cause and pull request, wait.removed's reason), commit trailers (the issue a commit closes), GitHub deployments (their commit), ark ledger events once their envelope carries causes (ark av67nbza), draft's own steps and messages. The envelope change ships read first, write later.

## Done when
- Every fact written after this lands carries causes: zero or more event addresses with their source, or the mark that its cause is unknown. A test fails for a writer that sets neither.
- A person's or the agent's act is a command fact (imperative, actor, on whose behalf, target, time) and the states it led to cite it.
- The readers of kiro-remote's feed, GitHub and the ark ledgers map their source's cause fields to addresses; a fixture of the 23 November chains (the #50 cascade and the lost notes) folds to the edges the CausalTrace preview draws, the unknown cause included.
- views.db has an edges table (from, to, kind, source) rebuilt with the projection, across the person's contexts; causesOf, effectsOf and openEnds answer from it, and a test fails when the registry declares an edge kind the table never receives.
- Measured in tests: each traversal under 100 ms within a context the size of draft's and ark's ledgers, and one measure (wakes done by hand) under a second over a fixture of three months across three contexts.
