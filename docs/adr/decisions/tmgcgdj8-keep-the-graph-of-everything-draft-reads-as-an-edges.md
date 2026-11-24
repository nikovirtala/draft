# Keep the graph of everything draft reads as an edges projection in SQLite, and add a graph engine only when a measured query needs it

## Context
The map, the causal trace (cqwg12zy) and the commands behind it (p6hx9jdv) walk a graph: an event's causes back to its root and its effects forward, open ends, cascades, supersedes chains, waits and links. The same walks answer the person's questions about the whole line (ark's factory design, One graph of the line): what led to this rollback, where a fix waited on its way to latest, how many wakes were done by hand. Those cross systems, and draft is the tool that already reads each of them for the person: the ark ledgers through GitHub, kiro-remote's change feed, pull requests, checks and deployments. The factory is not a product with its own runtime; its capabilities sit in the tools where they apply, and the person's lane is draft.

The truth is each context's hash-chained log (q7hkbw4h) and each source's own published log; every other store is a projection rebuilt from them (t8bp85a7). An embedded graph engine in the desktop app means a native module per platform built against Electron's ABI and signed, and the obvious one, Kùzu, was archived in October 2025.

## Decision
draft keeps one graph of everything it reads as a projection in SQLite: an edges table (from, to, kind, source) keyed by event address and indexed both ways, for causes, references, supersessions, waits and links, within a context and across the person's contexts. Traversals are recursive SQL behind one small interface in packages/core (causesOf, effectsOf, openEnds, and the measures as named queries), so callers never write a query against the table.

The graph answers people. Anything that runs unattended (a dispatcher, a breaker, a promotion gate) reads its own source and never this projection.

A step up (DuckDB embedded, its SQL/PGQ extension, or a graph engine) is taken only when a measurement asks for it: a traversal over 100 ms within one context, a measure over months across contexts over a second, or a walk with conditions on the nodes in its middle that recursive SQL can't express readably. The step changes the projection behind the interface, not the model or its callers, and is recorded as its own decision.

## Scope
The edges projection and the traversal interface in packages/core; the map's cascades, the causal trace and the measures draft shows; the readers that fold each source's causes into it.

## Consequences
Easier: no new service and no new native dependency; one place answers both "what led to this" in a context and the measures across them; the projection rebuilds from the sources like every other.

Harder: draft's store holds months of events from several systems, so the cache and projection need a size bound and a test of a measure at that size; each new edge kind has to be written by its fold, and a test should fail when the registry declares an edge kind the table never receives.

Risk: draft becomes the only place a measure is computed. Each measure is a named query in core, testable on fixtures, so another reader could run the same query if one is ever needed.
