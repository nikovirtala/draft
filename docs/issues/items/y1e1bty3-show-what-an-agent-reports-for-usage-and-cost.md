# Show what an agent reports for usage and cost

## Goal
Show each turn's reported usage in the conversation: tokens where the agent reports them, Kiro's credits, context fill.

## Notes
- Slice 2 records reported usage on the turn spans (`draft.usage.*`, `gen_ai.usage.*`) and says `draft.usage.reported: false` when nothing was reported. Nothing is estimated.
- Open question in implementation.md: what draft shows for cost when an agent reports no tokens.

## Done when
- A turn shows the usage its agent reported, and "not reported" otherwise.
