# Add threads and the panel

## Goal
A thread is a conversation with a parent message. Branch a thread off any message, continue it in the panel on the right, and leave a live thread stub where it branched off.

## Notes
- `conversation.created` already has `parent`, and every event names its conversation, so a thread needs no new envelope field.
- Placement (inline, minimized, panel, window) is view state in the per-device store (`apps/desktop/src/main/view-state.ts`), never in the log. This slice has inline and minimized only, and the stub shows only expand and minimize.
- Add the panel and pop-out icons to stubs once they work.
- One ACP session per thread: `AcpRuntime` already keys sessions by conversation address, and every session starts from `buildAgentContext` (ADR h89hcrk6), so switching a thread to another agent and forking a second opinion reuse it. Log the switch as an event.
- Design: "Core model: blocks and placements", "Threads" and "Multiplayer and audience" in [docs/model.md](../../model.md); the ACP client in [docs/implementation.md](../../implementation.md).

## Done when
- A thread can be started from any message and continues in the panel while the main conversation stays on the left.
- The main conversation keeps a thread stub with live state.
- Stubs show working panel and pop-out icons.
- Placements survive a restart and never appear in the log.
