# Record each fact's cause from the source that knows, and never infer one

## Context
The map is meant to show how things that happen lead to others: a merge fires a wait, the woken session rebases, the next pull request merges, an issue closes. It shows items by kind and state instead, because the facts draft folds keep no cause; a cascade can only be guessed from timing, and timing lies (two events in the same second need not be related, and a cause can be hours old).

The causes already exist at their sources: kiro-remote's change feed names the pull request whose merge fired a wait (ark ADR 9t6n5jc6), a commit's trailers name the issue it closes, a GitHub deployment names its commit, and draft knows which message or step started a session. Some events have no recorded cause: on 23 November 2026 a Kiro session was deleted and three queued notes were lost, and no source says why.

## Decision
Every fact and every transition in a context's log carries its causes: zero or more addresses of the events that led to it, taken from the source that records them. A transition can have more than one cause (a merge follows both the checks that passed and the command to merge).

When no source records a cause, the fact says the cause is unknown. draft never infers a cause from timing, order or similarity. A person can supply one later as a new fact that cites the old one, never by editing it.

The map draws cascades and the causal trace only from recorded causes.

## Scope
draft's log (fact envelope), every fold that reads a source (kiro-remote's feed, GitHub, ark's ledgers, draft's own steps and messages), and the map's cascades and causal trace.

## Consequences
Easier: "what led to this, and what did it lead to?" is answered from the log, and the gaps are visible as unknown causes rather than hidden behind a plausible guess; an open end (an effect that led nowhere) can be found by a query.

Harder: each reader has to map its source's own cause field to an address, and the fact envelope changes, so it ships read first, write later. A source with no cause field leaves its facts with unknown causes until it gains one, which is the pressure to add it (as kiro-remote did).

Risk: a source that records a wrong cause is believed. Causes keep their source, so a wrong one can be traced to where it came from.
