# Keep the context log in draft's own hash-chained store

## Context
The design names ark's ledger (`@nikovirtala/ledger`) as the first candidate for the raw log: git-backed, event-sourced and backward compatible. The ledger is internal to ark and its API is unstable before 1.0.

The step 1 rule was: use our own log if one message's append is over 150 ms at p95, or if append-only events per conversation need contortions of ledger's state machine.

Measured with ledger 0.16.0 on Node 26.13.1 (200 message events, `writeEvents` plus `git add` per event, a commit every 20 events):

| What | p50 | p95 |
| --- | --- | --- |
| Append and stage one event | 4.3 ms | 5.0 ms |
| Commit a batch of 20 | 10.8 ms | 30.7 ms |
| Append and commit every message (50 runs) | 15.9 ms | 22.9 ms |

Amortized, one message costs 5.0 ms. Speed is not the problem. The fit is:

- The envelope's `actor.kind` is `human` or `agent`, so resolver and system events fail validation.
- `at` has one-second precision and there is no per-event hash chain: tamper evidence comes from git history, and a `prevHash`/`hash` pair would ride along as unknown fields ledger ignores.
- A conversation as a subject means a one-state machine where every message is a `to: null` event, and threads would be more subjects in the same pattern.
- The desktop app would need git at runtime and one file per event.

## Decision
draft keeps each context's raw log in its own store: append-only JSON Lines, one event per line, written as received and never rewritten. Each event's hash is `sha256(prevHash + canonical JSON of the event without its hash)`, with 64 zeros before the first event. A batch is one write and one fsync.

The store sits behind the `LogStore` interface in `packages/core` (`append`, `events`, `head`, `close`), so the ledger, or anything else, can replace it later without touching callers. `verifyChain` walks the chain and names the first bad event; the app refuses to open a log that fails it.

## Scope
The raw log of every context in draft: `packages/core/src/log.ts`, `verify.ts`, the envelope and hash in `events.ts`, and canonical JSON in `canonical.ts`.

## Consequences
- Appends are fast and need no git; verifying a log is one pass over it.
- Tamper evidence is per event and doesn't depend on git history. A truncated or edited line is named by position and id.
- draft owns a second event format next to ledger's. Moving to ledger later means mapping actors and timestamps, and ledger would need resolver and system actors, millisecond times and a chain (open question).
- No sharing or syncing comes for free from git yet; a context stays local to one machine.
- A crash mid-write leaves a torn last line, which verify reports; there is no repair tool yet.
