# Open one main window per context

## Context
draft runs one main window with real windows for blocks placed out of it. All per-device state (layout, focus, window bounds, the move record) lives in a context's `device.db` and is keyed by block address, which starts with the context name (mxngvxkw). With several contexts open, either each gets its own main window or one window switches between them.

Options considered:

- One window that switches: a single place to look, but the layout, focus, block windows and bounds of every context would share one frame, and a block window would have to say which context it belongs to.
- One main window per context: layout, focus, attention and block windows are already per context; a window shows one context and nothing else. Chosen.

## Decision
Each open context has its own main window. Opening a context that is already open focuses its window. A context's block windows belong to it.

- **State.** Each open context has its own workspace, layout service, view-state store, agent processes and window manager. An IPC call is answered for the context of the window it came from.
- **Placement.** Window bounds are kept per context, per block, in that context's `device.db`; the main window's bounds are kept the same way.
- **Closing.** Closing a context's main window closes its block windows, its agent processes and its context; the others stay open. draft quits when the last main window closes, except on macOS. What was open when draft quit opens again at the next start, each where it was.
- **Single instance.** A second launch hands its folder path to the running draft, which opens or focuses that context.

## Scope
How windows map to contexts: `apps/desktop/src/main/windows.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/contexts/`.

## Consequences
- Placement, focus and attention never cross contexts, which matches the model; the attention count of a context doesn't include another's.
- Moving a block between contexts, or one view over every context, is not possible in a window; the universe view in the map comes later.
- More windows are open with more contexts; each runs its own polling timer.
