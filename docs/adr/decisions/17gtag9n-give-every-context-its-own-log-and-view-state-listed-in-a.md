# Give every context its own log and view state, listed in a device-local registry

## Context
draft has one context today: the log at `<dataDir>/log.jsonl`, written as context `local`, with the views, device state and the agent's workspace beside it. A person works on several projects, and model.md ("Contexts and the universe") says a context is a bounded graph that owns its log. Later work builds on that: the map lists contexts with their names, folders and last activity; sharing happens at the context boundary, and placement is per device; kinds reprocess one context's raw log and revert walks one context's graph.

Constraints found in the code: every address starts with the context name and addresses never change (address.ts), so a name is permanent; the log of `local` is hash-chained and must stay byte for byte as it is; and a log written on one device must not carry a path that means nothing on another.

Options considered:

- One log for everything, with a context field per event: nothing to migrate, but it breaks "a context owns its log", sharing at the boundary and per-context reprocessing.
- A directory per context under the data directory, with a device-local registry: what is chosen.
- Move the existing log into the new layout: tidier, but it touches the one log that must not change.

## Decision
Every context has a permanent name, its own log, its own projections and its own device view state. The name is the first part of every address, a lowercase address segment, unique on the device.

- **On disk.** New contexts live under `<dataDir>/contexts/<name>/` with `log.jsonl`, `views.db`, `device.db` and, until a folder is trusted, `agent-workspace/`. The existing log stays where it is as the context `local`, unbound to any folder; its bytes and hash chain are never rewritten by the upgrade.
- **Registry.** `<dataDir>/contexts.json` is a device-local registry: per context its name, title, the folder it is bound to (if any), a folder that was declined, the last activity, where its files are, and which contexts were open when draft quit. It is written atomically and holds no secret. It is not in any log.
- **Folder binding is device-local.** The first time a folder is opened, draft shows its path and git remote and asks to trust it. The answer is an event in that context's log, `context.folder_decided`, with the person as actor, the decision, the folder's git remote (credentials removed) and a SHA-256 of its real path. The path itself stays in the registry, so another device has nothing to share and decides for itself.
- **Importing a DRAFT_DATA_DIR setup** copies its log into a new context and verifies the copy is byte-identical. The old setup's log says `local` in every address and cannot be rewritten, so the registry keeps the name draft shows (unique on this device) apart from the context name the log's own addresses carry. Addresses typed by a person use the registry name.
- **Opening** is by sentence ("open longplay", "new context for ~/code/x"), from a recent list, with a folder path at launch, or by import. draft recognizes the sentence itself and shows one action to confirm. The agent has no way to switch contexts.

## Scope
Contexts on disk, the registry and the folder binding: `apps/desktop/src/main/contexts/`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/config.ts`, and the `context.folder_decided` event in `packages/core/src/events.ts`.

## Consequences
- The existing log opens unchanged, and any new context can be copied, shared or reprocessed on its own.
- Two names exist for an imported log, the registry name and the log's own, until sharing needs one rule; the gap is recorded as an issue.
- Losing `contexts.json` loses the folder bindings and recents, not the logs; draft can list `contexts/*/` to rebuild names. Re-trusting a folder writes a second decision event.
- A path hash of a guessable path can be guessed. The log never holds the path, which is what a shared log must not carry.
- Older builds keep `context.folder_decided` as an event they don't understand and show it as a generic block.
