# Move a log's half-written last line to a sidecar and open the log

## Context
q7hkbw4h keeps each context's raw log as append-only JSON Lines, never rewritten, and refuses to open a log that fails verification. A crash mid-write leaves a torn last line, so a log that only lost an unconfirmed write is refused as if it had been tampered with. A batch is one write then an fsync, so a line without its newline was never confirmed to anyone.

Options considered:

- Keep refusing and add a repair tool: the person has to act for an event nobody saw.
- Drop the torn bytes silently: loses evidence.
- Move the bytes aside, record that, and open.

## Decision
draft keeps each context's raw log in its own store: append-only JSON Lines, one event per line, written as received. Each event's hash is `sha256(prevHash + canonical JSON of the event without its hash)`, with 64 zeros before the first event. A batch is one write and one fsync. The store sits behind the `LogStore` interface in `packages/core`, so the ledger, or anything else, can replace it later. `verifyChain` walks the chain and names the first bad event, and the app refuses to open a log that fails it, with one exception:

- If the file doesn't end with a newline and every complete line before it verifies, the bytes after the last newline are written to `log.jsonl.torn-<time>-<hash prefix>` next to the log (and synced), the log is truncated to its last complete line, and a `log.recovered` event records the sidecar's name, the byte count and the sha256 of the bytes. Then the log opens as usual.
- Anything wrong before the last line (a torn line in the middle, an edited event, a broken chain) is still refused, and nothing is moved or cut.

The truncation removes only bytes that were never a complete event; no complete event is ever rewritten.

## Scope
The raw log of every context in draft: `packages/core/src/log.ts`, `verify.ts`, the envelope and hash in `events.ts`, and canonical JSON in `canonical.ts`.

## Consequences
- A crash mid-write no longer locks the person out, and the lost bytes stay on disk with a hash in the log.
- A tampered last line without a newline would be recovered rather than refused; its bytes are kept and recorded, and the sidecar shows them.
- Opening a log can now write to it (one event), so opening needs write access, as appending already did.
