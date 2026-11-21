# Test the whole loop end to end

## Goal
One end-to-end test that drives the full loop: a conversation launches a Kiro session, supervises it through its interrupts, and sees the result land.

## Notes
- Today's Playwright e2e covers the app against a scripted agent and a fake Kiro Remote, including a crash mid-step.
- The loop test needs the ACP runtime and a scripted Kiro session that moves through states.

## Done when
- CI runs the loop test on every pull request without real credentials.
