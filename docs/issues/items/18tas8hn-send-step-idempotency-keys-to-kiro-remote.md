# Send step idempotency keys to Kiro Remote

## Goal
Pass each step's idempotency key to Kiro Remote on `kiro_launch_session` and `kiro_send_prompt`, so a retried call can't launch or prompt twice.

## Notes
- Every step already records a fresh `idempotencyKey` in `step.started`.
- kiro-remote's REST API deduplicates POSTs by `Idempotency-Key` for 24 hours (packages/api/src/idempotency.ts), but its MCP tools take no key: the tool input schemas have none, the in-process `/mcp` transport calls the service directly, and the stdio client makes a fresh key per call (packages/mcp/src/http-client.ts).
- Needs a change in kiro-remote first: an optional key in those tools' input, forwarded to `withIdempotency`.

## Done when
- kiro-remote accepts an idempotency key on launch and prompt tools.
- draft sends the step's key, and a repeated call with the same key returns the first result.
