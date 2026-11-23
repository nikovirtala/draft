# Bring a check only the person can do into draft, with its steps

## Goal
A step only Niko can do (try a three-minute wait on his Mac, then accept an ADR) waits on him in draft, with its steps written out and what he should see, instead of living in a pull request's description and in chat.

## Notes
- Niko on 23 Nov 2026: "Ideally, I should be seeing this in draft, right?", about testing ADR 8rhwhgbw's pending tool call before accepting it.
- A person's check is a kind (ark docs/05-factory-v1.md, The factory's state is data): requested → passed or failed, closed by the person, with a reminder as its timeout. Its source is a merged pull request's "After deploy" section, which every prompt now asks agents to write as full steps.
- Each step is shown with what he should see, a command copies or runs in the context's folder with one action, and passed or failed is recorded as a fact with his note. A check that gates an ADR links to it, so passing offers the ADR's acceptance right there.
- The map already lists proposed ADRs as waiting on him; the check is what makes the wait actionable.

## Done when
- After a pull request with an "After deploy" section merges, its check appears in draft as waiting on Niko, opens to its steps, and records passed or failed.
- A check linked to a proposed ADR offers its acceptance once passed.
