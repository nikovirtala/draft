# Design

How draft's window should look, feel and behave.

- [draft: Design Spec](draft-design-spec.md): vision, principles, tokens, where each colour and fill may appear, the anatomy of the window as built, motion and loading, accessibility, performance, lessons, decisions, drift and the roadmap of design slices.

The palette, its previews and the tokens are the design system's, in [docs/design-system](../design-system/README.md). The spec says where they may appear and how the parts are put together from them.

Skills that tell a coding agent how to apply the spec live in `.kiro/skills/` and, identical, in `.claude/skills/`: [draft-design](../../.kiro/skills/draft-design/SKILL.md) for colour, fills, focus, chips, stubs and blocks, the map, motion, loading, accessibility and the checklists before a renderer change merges, and [draft-block](../../.kiro/skills/draft-block/SKILL.md) for adding a new kind of item to the conversation.

This is a living guide, not an ADR. Decisions about architecture stay in [docs/adr](../adr/adr.toml).
