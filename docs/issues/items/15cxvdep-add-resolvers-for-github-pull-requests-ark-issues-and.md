# Add resolvers for GitHub pull requests, ark issues and artifact pages

## Goal
Render pull requests, ark issues and artifact pages as live stubs, each through its own resolver behind core's `Resolver` interface, and route their interrupts into the conversation.

## Notes
- `Resolver` (`packages/core/src/resolver.ts`) has one implementation per reference type: `detect`, `fetch` and a version. What a resolver observes enters the log as `status.observed`, only when it changes.
- The view component set has only `text` and `status-stub` with a `kiro-session` target; each new type needs its target in the Zod schema.
- Interrupts (permission requests, PR events) are step 5 of the prototype plan.

## Done when
- PR, ark issue and artifact references show live stubs with snapshots at mention.
- Each resolver polls only while its stubs are on screen, with backoff.
- Resolver failures are counted in telemetry.
