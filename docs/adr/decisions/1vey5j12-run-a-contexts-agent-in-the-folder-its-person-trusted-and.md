# Run a context's agent in the folder its person trusted, and leave Kiro's own trust to Kiro

## Context
Today the agent always starts in `<dataDir>/agent-workspace`, so it can't be told about a project. ADR 06wp7907 (proposed) fixed that on purpose: draft's first slices ran one conversation with Kiro Remote, and a user repository was a risk with nothing to gain. With contexts bound to a folder the person trusted, the agent should start in that folder.

What Kiro's own documentation says about folders ([Permissions, Workspace trust](https://kiro.dev/docs/permissions/)):

- An untrusted workspace loads no custom agents, steering, skills, workspace MCP configuration or workflows, asks before every shell command and every MCP call even when a rule allows it, and a deny rule still wins.
- Trust is `workspaceTrusted` in `~/.kiro/workspace-roots/<hash>/permissions.yaml`, outside the repository. Kiro's own scope refuses the agent's writes there. It is revoked by editing that file by hand; there is no command.
- `--trust-workspace` trusts one V3 launch without saving. It also loads everything the folder carries, so it removes the protections above for that launch.
- The documented gate is the interactive V3 screen; non-interactive runs and V1 and V2 sessions are not gated. The docs don't say what `kiro-cli acp` does.

Options considered for Kiro's trust:

- Mark the folder trusted for Kiro when the person trusts it in draft (write the file, or pass `--trust-workspace`): the person says yes once. The hash that names the file isn't documented, the flag loads a repository's own agents and MCP servers, which draft's tool policy (06wp7907) doesn't account for, and there is no clean way to revoke.
- Leave Kiro asking: what is chosen.

## Decision
A context's agent starts in the folder its person trusted in draft, and draft does not mark that folder trusted for Kiro.

- **Where it runs.** The working directory of the agent process and of every ACP session of a context is the real path of its trusted folder. A context with no trusted folder, because the folder was declined or none was given, runs in its own `agent-workspace` as before. `local` keeps `<dataDir>/agent-workspace`. The directory is read when a session starts, so a change applies to new sessions.
- **Policy unchanged.** `decideTool` and the ask-first configuration of ADR 06wp7907 apply as they are: only Kiro Remote's tools are allowed, and a call that changes something asks and is a durable step before it runs. draft declares no `fs` or `terminal` capability. The agent's own file and shell tools are still refused by that policy, so moving the folder does not by itself let it edit a project; that is a separate decision (issue).
- **Kiro's trust stays Kiro's.** draft's trust step is about draft: which folder a context may work in. It writes nothing under `~/.kiro` and passes no `--trust-workspace`. Kiro keeps asking before every shell command and MCP call there and loads nothing from the folder's `.kiro` until the person trusts the folder in Kiro itself, where Kiro owns the record and the revocation.
- **The briefing says where it is.** The agent is told the folder's name (not its path), that it is the project the person trusted, and that anything that changes something asks first.

## Scope
The agent's working directory and trust: `apps/desktop/src/main/acp/runtime.ts`, `apps/desktop/src/main/acp/registry.ts`, `apps/desktop/src/main/config.ts`, and how `apps/desktop/src/main/index.ts` starts a context.

## Consequences
- The agent can reach a project folder's location, and nothing more than before: its tools are the same.
- A person who wants Kiro to load a repository's agents and steering trusts the folder in Kiro too. Kiro's file stays outside draft, and draft never needs to read or write it.
- Whether `kiro-cli acp` shows or honors the trust gate isn't documented; the real-agent check in the sandbox should confirm it (issue).
- The part of 06wp7907 that says the agent never runs in a user repository no longer holds; the rest of it does.
