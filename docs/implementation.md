# draft: implementation

How draft is built right now. The model it implements, which stays true however it is built, is in [model.md](model.md). Technology choices will move into ADRs over time; this file summarises and links them.

## Agents over ACP

draft is an ACP client. It speaks the Agent Client Protocol (protocol version 1, through `@agentclientprotocol/sdk` 2.x) to whatever agent runs a conversation, so the agent is configuration, not code. Built in slice 2: `AcpRuntime` in `apps/desktop/src/main/acp/`.

- **Local Kiro is the default.** draft starts `kiro-cli acp --agent-engine=v3 --auth-method=cli`, and Kiro keeps its own sign-in, models and MCP servers, so draft never handles a credential ([Kiro: migrate an ACP client to CLI V3](https://kiro.dev/docs/cli/v3/acp-migration/)).
- **Claude runs through `claude-agent-acp`,** the ACP adapter for the Claude Agent SDK, with a Claude Console API key that the adapter reads from `ANTHROPIC_API_KEY` in the environment draft starts from ([claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)). draft stores no agent credential.
- **Any other ACP agent works** without changes to draft: `agent` and `agents` in `config.json`.
- **Sessions are keyed by conversation address,** so each thread can be its own ACP session, even on different agents. Every session starts from one projection of the log, never the agent's own memory (ADR h89hcrk6).
- **Every turn carries a note of what the agent could not see.** What a person decides in draft (accept, request changes, reject, and any other person-only settlement of a kind) and what draft resolves for the stubs a conversation references never pass through the agent, so the agent would go on calling a merged pull request open. `buildAgentNote` (`packages/core/src/agent-changes.ts`) reads the projection and returns what changed since the agent's last turn: `changesSince` gives typed entries, one `kind` per source (`settlement`, `stub`), and `renderChanges` is the one place they become text, through a renderer per kind (and per stub type). A settlement names who decided, what, its address and the person's own text (the note of a request for changes, the reason of a rejection), and for an accept or reject the step's result and the commit it merged or made. A stub entry is the latest state draft resolved, once per target however often it changed, with when: for a pull request its state, head, checks, mergeability and review; for a Kiro session its status, pending permission requests and repositories (and its linked pull requests, once the session's state carries them); for an ark issue, ADR or artifact page its state and title. Only stubs that a message the agent may read referenced count, and another context's items only once a person pulled them in (the audience rule of the context). The note is marked as draft's record, not the person's words, is capped (12 entries, 4,000 characters, decisions kept before stubs and the newest first) and says how many it left out and how to ask. It goes at the top of the prompt, before the person's text, on every turn, not only a session's first. It is also what `agent.turn_started` records: the event is written when the turn begins, after the message's references are made, with the note exactly as sent, and its place in the log is the "since" of the agent's next note. So what resolves while the agent answers is told next turn, a restart rebuilds the same "since" from the log and sends nothing twice, and an agent switched in later counts from its own last turn. A turn that fails before the agent reads its prompt has still used its note (at most once, never twice).
- **Every agent is made to ask.** draft switches Kiro's autopilot off and Claude's mode to `default`, without Claude's user settings or built-in tools, and won't start a session the agent won't take that on. Permission requests go through `decideTool`, so an approved call that changes something is a durable step before the agent proceeds. A call that runs without asking is logged as `agent.anomaly` and shown as an interrupt (ADR 06wp7907).
- **The agent runs where its context says.** Its working directory is the folder a person trusted for the context, or the context's own `agent-workspace` until then ([Contexts](#contexts)). It has no `fs` or `terminal` capability. Kiro Remote's tools are handed over in `session/new` over HTTP with a bearer header (or the `kiro-remote` stdio client when the agent has no HTTP MCP), and in a trusted folder draft's own file and shell tools come with them (next bullet).
- **The agent has no built-in tool that changes things, and gets draft's own instead.** Asking through `session/request_permission` isn't enough: with a user-wide `capability: all` allow rule Kiro never asks (the rule is the person's, on purpose), and draft saw a write or a shell command only afterwards, as a call without asking. So in draft's sessions the agent's own write and shell tools don't exist, and the file and shell tools it has are draft's (ADR on running the agent without built-in tools that change things, issues aefrmdf4 and 562p472b):
  - *One registry, one policy.* `DRAFT_TOOLS` and `toolPolicy(tool, input, context)` in `packages/core/src/agent-tools.ts`: `read_file`, `list_files`, `search_files`, `write_file`, `edit_file`, `run_command`. The policy is pure over a tool, an input and a context (the trusted folder and how paths resolve) and returns `read` (runs, is logged), `change` (a step: asks, runs only on yes) or `refused` (never runs). Every path is resolved to its real path first, so a symlink out of the folder is outside it. Writes under `.git`, `.kiro`, `.claude` and `.vscode` are refused. A command is `read` only if it is one plain command on the allowlist (`READ_ONLY_COMMANDS`: `git status`, `log`, `diff`, `show` and a few more, `ls`, `cat`, `rg`, `grep` and a few more) with every path argument inside the folder and none of the flags that write, run another program or follow a link out; anything else asks. New tools add an entry, never a second path.
  - *draft's own MCP server* (`apps/desktop/src/main/acp/draft-server.ts`) listens on 127.0.0.1, answers MCP over HTTP with JSON responses, and gives each session its own bearer token in `session/new` (a request with another token, another `Host` or an `Origin` is refused). A call is gated there, whatever the agent's rules say: the server applies the policy, the turn's mapper asks the person through the same interrupt as any step (`askAndBegin`) and begins the durable step, `FolderTools` runs it in the folder with the agent's environment (no sign-ins of the person's) and a time limit, and the step's settlement is the exit code, an output excerpt and the files changed (git's view of the folder). A request that arrives again with the same JSON-RPC id, tool and input within a turn gets the first result and nothing runs twice. When the agent also sends a permission request for one of these calls (Kiro does in a folder it hasn't trusted), draft answers it with the one-time allow and the person is asked once, by draft. The tools are offered only to an agent whose own are taken away (Kiro, Claude) that can reach an HTTP MCP server, and only in a trusted folder; in any other session the agent is told it has none.
  - *A call outlives its request* (`call-policy.ts`, `draft-session.ts`, adr:8rhwhgbw). The agent's MCP client gives up on a request after its own timeout (Kiro's `requestTimeout` is 120 s by default, the MCP TypeScript SDK's 60 s), and a person may take longer. Kiro documents `requestTimeout` only for a server in an agent file, not for one supplied in `session/new`, and no documented client resets its timeout on progress, so draft answers before the client gives up: after 105 s on Kiro (45 s for any other agent) the request returns a result, not an error, that says the user hasn't answered yet and to call the same tool again with exactly the same arguments. The call stays pending and the repeated call joins it, whatever its JSON-RPC id. "The same call" is the same tool, the same input after the policy has parsed it (defaults filled in, keys in any order) and the same turn. The person is asked once, and the call runs once. It runs only while a request is waiting for it, so a change is never made when the agent isn't there to be told; a yes that comes when none is waiting is kept until the next request. A request that leaves (the client's timeout, `notifications/cancelled`, a closed connection) ends its wait and not the call. A result written to a request that the client cancels within 10 s is given to the next request for the same call, so a client that timed out a moment before the result isn't left without it. A call ends when a request collects its result, when its turn ends or is cancelled, or 30 minutes after it began; then a late yes starts no step and runs nothing, so no step is left open. The prompt of an ended call stays on screen until answered, and the answer does nothing. The briefing tells the agent to call again.
  - *Kiro* starts with draft's own agent (`kiro-agent.ts`), named `draft-` and 16 random hex digits kept in `<data>/kiro-home/agent-name`, so a project's own agent can't have its name: `tools: ["@mcp"]` (no built-in tool), `includeMcpJson: false`, and deny rules for `fs_write`, `shell` and `subagent`. Kiro CLI V3 reads agents from `~/.kiro/agents`, a trusted workspace's `.kiro/agents` and `$KIRO_HOME/agents`, and `session/new` picks one with `_meta.kiro.modeId`; `kiro-cli acp` takes no `--agent` in V3 ([ACP client migration](https://kiro.dev/docs/cli/v3/acp-migration/), [custom agents](https://kiro.dev/docs/custom-agents/)). draft writes the agent in `<data>/kiro-home/agents/draft.json` and starts Kiro with `KIRO_HOME=<data>/kiro-home`, so no file of the person's is edited. A permission rule decides what a tool may do and not which tools exist: "The tools field decides which tools the agent can see and call; the permissions field decides what those tools may do when called" ([configuration reference](https://kiro.dev/docs/custom-agents/configuration-reference/)), so the person's `capability: all` allows nothing the agent doesn't have. The cost of `KIRO_HOME` is that Kiro's configuration, sign-ins and sessions move with it ([settings reference](https://kiro.dev/docs/reference/settings/)): the person's permission rules, MCP servers, steering and skills don't reach draft's sessions, and Kiro is signed in there once (`KIRO_HOME=<data>/kiro-home kiro-cli login`, which draft says when Kiro isn't signed in). If the session doesn't report that name as its agent, draft doesn't start it. A project's `.kiro/agents` is still read over ACP (see [Contexts](#contexts)), but its agents have other names and `includeMcpJson: false` keeps the project's MCP servers out of draft's agent.
  - *Claude* starts with `_meta.claudeCode.options` `{ settingSources: [], tools: [], disallowedTools: [...] }`: no user settings that could allow tools, no built-in tools, and Bash, the file-writing tools, Agent and the web tools denied by name as a second lock. A bare name in `disallowedTools` removes the tool from the model's context and a deny rule holds in every permission mode, `bypassPermissions` included ([Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions#allow-and-deny-rules)).
  - *What the agent is told* is derived from the same registry (`toolsBriefing`): the tools the session offers and that changes ask, or that it has none. It is also told that a tool of its own that changes something without asking is a fault: such a call is still recorded as `agent.anomaly` and shown as a call without asking.
  - *Kiro's own calls still carry no structured identity.* Kiro's documentation names one only for MCP tools (`_meta.kiro.mcpTool`) and says never to derive a built-in tool's identity from its title ([ACP client migration](https://kiro.dev/docs/cli/v3/acp-migration/)), so "Tool Load" is still recognized by its shape (issue 562p472b).
- **The agent's process doesn't get the person's sign-ins.** It runs as the person's operating-system user, so `agentEnvironment` (`apps/desktop/src/main/acp/environment.ts`, ADR zan5vjwz, issue xh46a2ks) builds its environment from the person's: draft's own settings, GitHub, git, SSH, AWS and npm credentials are withheld by name, and gh, git, ssh, aws and npm are pointed at empty files in `<data>/agent-env` and a PATH with an `ssh` stand-in first, so they find nothing. HOME, PATH, locale, `KIRO_*` and `XDG_*` pass, so Kiro keeps its own sign-in. `agents.<name>.passEnv` in `config.json` hands one variable through on purpose. The agent's status shows "Your GitHub, git, SSH, AWS and npm sign-ins are withheld from the agent", with the names on demand and any `passEnv` exception, and the session's `agent.session_started` event carries the same report, names only. draft's own process keeps using the person's git and gh for acceptance. This stops casual use, not a process that reads the person's files; see [Contexts](#contexts) for what the agent can still reach.
- **ACP updates stream into the conversation.** The log's actor names the agent and the model it reports. Usage is what the agent reports (token counts, Kiro's credits, context fill); a turn that reports nothing says so in its span.
- **draft builds on standard ACP.** Agent-specific extensions, such as Kiro's `_kiro/...` methods, are used only when the agent advertises them, so draft never turns into a single-agent client.

Two connections, kept apart:

| Connection | What it's for | How |
| --- | --- | --- |
| draft's own agent | The conversation: answers, actions, artifacts | ACP over stdio, to a local agent process |
| Hosted coding agents | Kiro cloud sessions that draft supervises | Kiro Remote: live stubs and interrupts from draft's resolver, and Kiro Remote as an MCP server for the local agent, so it can launch and steer sessions |

## Architecture sketch

Everything goes through one append-only log per context, and everything on screen is computed from it. Each open context has its own copy of everything below the registry, and a window of its own. It has two outward connections, kept apart: ACP to its own agent, and Kiro Remote to the hosted coding agents it supervises.

```mermaid
flowchart TB
    ui["UI shell<br/>blocks from view state; placement per device"]
    win["Electron windows<br/>per context: a main window, one per block placed in a window, plus the panel"]
    reg[("Context registry<br/>contexts.json: names, folders, last activity;<br/>device-local, in no log")]
    subgraph main["Electron main process, one set per open context"]
        acp["ACP client (AcpRuntime per agent)<br/>one session per conversation address,<br/>started from one projection of the log;<br/>permission requests → decideTool → steps"]
        conv["Workspace<br/>main conversation and threads: turns, audience,<br/>pause/play, interrupts, attention per conversation"]
        dev[("Device view state<br/>layout, focus, window bounds, move record;<br/>never in the log")]
        log[("Context log<br/>append-only, hash-chained;<br/>actor and trace ID on every event")]
        proj["Kinds and projections<br/>SQLite views, agent context"]
        res["Resolvers<br/>live stubs, snapshots"]
    end
    agent["Local agent process (ACP over stdio)<br/>kiro-cli acp by default, claude-agent-acp,<br/>or any ACP agent; cwd is the context's trusted folder,<br/>else its own agent-workspace"]
    kr["Kiro Remote<br/>hosted Kiro sessions"]
    artifact["artifact<br/>raw HTML views over SSE"]
    ui <--> conv
    reg --> win
    reg -. "folder, trust step" .-> acp
    ui <--> dev
    dev --> win
    conv --> log --> proj --> conv
    conv <--> acp
    acp <-- "JSON-RPC on stdio" --> agent
    agent -- "MCP (HTTP with bearer, or kiro-remote stdio)" --> kr
    res -- "MCP, no model" --> kr
    res --> log
    ui -.-> artifact
```

- **UI shell** renders blocks from view state. Placement and focus are stored per device, apart from the log, in the device's view-state store: the layout, focus, window bounds and a record of every placement change (block, kind, from, to, when, why). The rules are a pure state machine (`apps/desktop/src/shared/placement.ts`). Only a person's gesture changes the layout: the agent can't.
- **Contexts** are listed in the registry and opened one window each; see [Contexts](#contexts).
- **Windows** are real Electron windows. Each block placed in a window gets one, titled with what it is and where it came from, with its bounds kept per device. Closing one returns the block to the place it came from. The panel is a column of the main window.
- **Threads** are conversations with a parent message. The `Workspace` runs the main conversation and every thread over one log, each with its own turns, interrupts and agent session. The agent is chosen when a thread starts (the default, or another configured agent) and can be switched later; the switch is logged as `agent.selected` and the new session starts from the projection (ADR h89hcrk6).
- **Focus** is a layout state on the device. It minimizes every open block except the focused one and its thread, filters the attention count by conversation ("N in focus, M elsewhere") and restores the layout exactly when it ends. It is entered by a gesture (Ctrl or Cmd + period on the selected block) and left with Esc or the same gesture.
- **ACP client** keeps one ACP session per conversation address (so one per thread), starts each from the log's projection, streams the agent's updates into the conversation, turns its permission requests into prompts and steps, and writes everything to the log.
- **Local agent** is a separate process speaking ACP over stdio: `kiro-cli acp` by default, `claude-agent-acp` or any other ACP agent by configuration. It reaches its tools over MCP, Kiro Remote included.
- **Context log** is the raw layer: append-only and hash-chained, with an actor and a trace ID on every event. Slice 1 built draft's own log; the ark ledger was measured fast enough and stays an option. A torn last line is moved to a sidecar and recorded (ADR 4gwyn86q).
- **Kinds and projections** extract things and edges, build the graph and view state, and run reprocessing generations.
- **Resolvers** turn references to outside things into live stubs, with no model involved, and take a snapshot whenever one is referenced. See [Resolvers](#resolvers).
- **Interrupts** are what needs a person, derived from the log, in one attention order. See [Interrupts and attention](#interrupts-and-attention).
- **State machines** (`packages/core/src/machine.ts`) hold the thread and interrupt lifecycles. See [The state machine module](#the-state-machine-module).
- **artifact** is the escape hatch for raw HTML views, with reload over SSE. Windows are real Electron windows now, not synced tabs.

The agent describes a view using a fixed set of components (a JSON description), not raw HTML. That keeps the grammar stable, makes views safe to render, and lets them update live from references. Raw HTML through artifact is only for what the components can't express.

## Contexts

A context is a log with its projections and view state, a permanent name, and, on this device, maybe a folder its agent works in ([model.md](model.md), "Contexts and the universe"). Decisions: ADRs 17gtag9n (contexts and the registry), 1vey5j12 (where the agent runs, and Kiro's trust), 4e115peq (a window per context) and gw4vxvw4 (references across contexts).

**On disk**, under the data directory (`DRAFT_DATA_DIR`, else Electron's `userData`):

```text
contexts.json                the registry: device-local, written atomically
log.jsonl views.db device.db agent-workspace/      the context "local", where it always was
contexts/<name>/{log.jsonl, views.db, device.db, agent-workspace/}
```

- **The registry** holds per context its name, title, the folder it is bound to, a folder that was asked about and isn't trusted, the name its log's own addresses carry, its last activity (updated on every write) and which contexts were open at exit. A device with no registry gets one holding only `local`; the files already there are not touched. A registry that can't be read is moved aside and rebuilt from `contexts/*/`.
- **Names** are address segments, unique on the device and permanent. A new context is named from its folder (`longplay`, then `longplay-2`); `local` is never handed out.
- **Per context:** log, projection, device view state, window bounds, agent processes and polling. Nothing is shared but the identity, the Kiro Remote connection and the resolvers.

**Binding a folder.** Opening a folder nobody trusted for a context shows a trust step with its real path and git remote (read from the repository's config file, credentials removed, without running git). The answer is `context.folder_decided` in that context's log, with the person as actor: the decision, the remote and a SHA-256 of the path, never the path. The path is kept in the registry only. Declined or unanswered, the context opens without a folder and the agent stays in its own workspace; opening the same folder again asks again.

**Where the agent runs.** The working directory of the agent process and of each session is the trusted folder's real path, read when a process or session starts, so a change applies to new sessions. If the folder is gone, the agent stays in its own workspace and the header says so. The agent is told the folder's name, not its path. draft doesn't mark the folder trusted for Kiro, and over ACP Kiro's own trust doesn't keep the folder's configuration out. Kiro's own configuration of the folder (its agents, MCP servers, skills) is therefore still read; draft's sessions pick draft's own agent by an unguessable name and it takes no MCP server from the folder (see [Agents over ACP](#agents-over-acp)). Checked on 22 November 2026 with kiro-cli 3.5.0 on macOS, in a folder Kiro had never opened: Kiro started the MCP server defined in the folder's `.kiro/settings/mcp.json` and listed the folder's `.kiro/skills`. Its "Trust this workspace?" screen guards interactive sessions only. Whether Kiro asks before a call is decided by the person's own Kiro rules as well as by draft's `autopilot` off: with a user-wide `capability: all` allow rule in `~/.kiro/settings/permissions.yaml`, Kiro wrote a file without `session/request_permission`, and draft saw it only afterwards, as a call without asking (?35).

**What the agent's process gets.** The agent runs as the person's operating-system user, in the trusted folder, with the person's environment minus their credentials (see [Agents over ACP](#agents-over-acp)). It gets no `GH_TOKEN`, `GITHUB_TOKEN`, `AWS_*` credentials or profile, npm token or `SSH_AUTH_SOCK`; `gh` is given a token GitHub refuses (an empty config folder alone would leave the keychain's token reachable, because gh falls back to the keychain entry stored without a user name); git has no system config, no credential helper, no prompts and the identity `draft agent <agent@draft.invalid>`; git over SSH and `ssh` offer no key, agent or configuration. What it can still reach is what the person's files and the keychain hold: `~/.aws`, `~/.ssh`, `~/.npmrc`, `~/.config/gh`, the keychain through `security`, `/usr/bin/ssh` by its path, a credential helper named for one URL in the folder's own git config, and anything else the person can read. The boundary against those is a sandbox for the agent's shell. Kiro's local command sandbox (Seatbelt on macOS, off by default) is switched on only through the person's `sandbox.json` or `/sandbox`: Kiro's ACP documentation offers no per-session option, and draft never writes the person's Kiro files, so draft doesn't turn it on.

**Opening a context.**

- *By sentence.* "open longplay" (a context on this device) and "new context for ~/code/x" are recognised by draft, posted for people only, and become one action to confirm. The agent can't open anything. Confirming records `context.crossed` (`opened`, via sentence).
- *From the recent list* in the title bar, with "Open a folder…" and "Import a data directory…".
- *With a path at launch.* `draft <folder>` opens or makes that folder's context. A second launch hands its folders to the running app (single-instance lock) and exits. From the dev script, use absolute paths, because the app runs in `apps/desktop`: `pnpm --filter @nikovirtala/draft-desktop dev -- "$HOME/code/longplay"`. Packaging is issue cwrr4ff1. With no path, the contexts open at the last exit open again, else `local`.
- *Importing a `DRAFT_DATA_DIR` setup.* `draft --import <dir>` or the menu. The old log is verified and copied byte for byte into a new context (the original is only read), and importing the same directory again finds the context. The old log says `local` in its addresses and can't be rewritten, so the registry's name for it differs from the name its addresses carry; people use the registry name. If its `agent-workspace` was a symbolic link, its target is offered through the trust step.

**Across contexts.** An address of another context's item typed in a message (`<context>/<conversation>/<item>@1`, copied with "Copy ref") becomes a reference with a snapshot of its context, address, title, version and event hash, taken by draft from the other log (read only, verified) and never polled. Snapshots are in the referencing log; the agent's context leaves them out until a person pulls one in, which ends the conversation's running session so the next starts from the log with it. Referencing, following, pulling in and opening are `context.crossed` events. Only a person's own messages create references; the agent's words never make draft read another log.

**Windows.** One main window per context; opening an open context focuses it. Closing a context's window ends that context; the last one ends draft (not on macOS).

**Work in the folder.** In a context bound to a trusted folder the agent has draft's file and shell tools, confined to that folder, and no built-in tool of its own that changes things ([Agents over ACP](#agents-over-acp)). A read runs and is logged, a write, an edit or a command off the allowlist is a step the person answers before it runs, and its settlement says what it did. A context with no trusted folder, or with a folder that has gone, has none of these tools and is told so.

**Left out:** sharing contexts, contexts the agent suggests, the universe view in the map and rebinding or unbinding a folder. See the issues opened with this slice.

## Resolvers

One `Resolver` per reference type, each with a version, `detect` (candidate ids in text), `fetch` (the target's state, `null` when it doesn't exist, a throw when it can't tell) and, optionally, `interrupts` (what in that state needs a person, a pure function of the state). A snapshot is taken when a target is first referenced; `status.observed` is written only when the state changes; polling covers only the stubs on screen, doubles its interval while nothing changes (to a maximum), resets on a change, and a failure is counted in telemetry and never polled sooner than the source asks. The target of each type is in the view schema (`STUB_TYPES`).

| Type | A reference is | The state carries |
| --- | --- | --- |
| `kiro-session` | a 26-character session id | title, status, pending permission requests with their options |
| `pull-request` | `owner/repo#12` or a pull request link; id `owner/repo/pull/12` | check runs and statuses with conclusions, review decision and each reviewer's verdict, requested reviewers, mergeable state, head commit |
| `ark-issue` | `<source>:<id>` (`draft:15cxvdep`, the source names are `arkSources` in `config.json`) or a link to the issue's files | status and resolution folded from the event files, the events with their times |
| `adr` | `owner/repo:adrid`, a configured source name (`draft:9p8jj6p5`) or a link to a decision's files; id `owner/repo:adrid` | status folded from the event files, read at the head of the open pull request in the same repository that touches them (else the default branch), that pull request's checks and head, and the result of `adr verify` there |
| `artifact` | a link to a page on the configured artifact server | title, current version, versions, update time |

An ADR's proposal usually lives on a pull request's branch, so the resolver searches the open pull requests (at most 30, newest first, files listed with ETags) for the one that touches the decision. `adr verify` runs in draft's own clone at that head, once per commit, through the person's tools (below); without a verifier its evidence never turns green.

GitHub: `GITHUB_TOKEN` from the environment, else `gh auth token`, else public access with a note in the main conversation. The client only sends GET and sends the ETag it saw, so an unchanged resource answers 304 (proposed ADR 9p8jj6p5). The artifact server comes from `artifactUrl` (default `http://localhost:4400`, `ARTIFACT_TOKEN` as the bearer).

## Interrupts and attention

An interrupt is something that needs a person, in the conversation it belongs to. Some are computed from other events (a step that started and never finished, a step that failed, a call that ran without asking); the rest are raised by a resolver (`interrupt.raised`, with the time it arose, so its age is derivable from the log) and cleared by it when the source stops needing anyone (`interrupt.cleared`, with a reason). A person settles one with `interrupt.settled`, as themselves; the agent can't, and `kiro_answer_permission` is refused by the tool policy.

- **Order.** Blocking permission requests; then failures (failed checks, merge conflicts, changes requested, failed steps, calls that ran without asking); then acceptance requests (ready work waiting for a yes: after something broken, because a failure may make it moot, and before the rest, because it is what the process is stopped at; ADR ytmnx1br); then what is left to resolve (interrupted steps, a conclusion to confirm); then reviews requested. Oldest first within each, then by place in the log. One count in the title bar, with the whole list under it.
- **Where they belong.** A hosted session's interrupts go to the conversation whose step launched it (the step's result names the session), else the conversation that first referenced it, else the main conversation. Other targets go to the conversation that first referenced them, else the main one.
- **Settling.** A hosted permission request is allowed or denied: draft writes a step of the person's own, calls Kiro Remote as them, and then writes the settlement. An interrupted step is settled as done, failed or retry, naming the started step; retry writes the settlement and a new step (new key, `retryOf`) together, then runs it. The old step is never run again. A failed step is acknowledged or retried. PR events and calls that ran unasked are acknowledged.
- **Keys.** A check's key includes the commit and the check's name, a conflict's the commit, a review's the review, so a new push is a new interrupt and a settled one stays settled while the source reports the same thing.

## Acceptance

One pattern for every human gate (docs/model.md, "Acceptance"), built on the interrupt, the state machine and the step. The ADR and the pull request are the first two kinds of record (`packages/core/src/acceptance.ts`, `adr.ts`, `pull-request.ts`).

- **A kind declares** its evidence (`subject`), what accepting and rejecting do (`effect`, with steps) and the inverse of each (reversible or compensable with a named step, irreversible with a reason). The UI draws whatever evidence a request carries.
- **Ready means green.** The resolver's `interrupts` is pure, so the request exists exactly while every item of evidence is green and is cleared, with the item that went red named, when one does. Its key includes the commit it was judged on: a new push is a new request, an answered one stays answered, and a red-then-green same commit is a new episode.
  - ADR: proposed at the head of an open pull request of its own repository; `adr verify` clean at that head; every check of that pull request passed.
  - Pull request: open, not a draft, every reported check passed, GitHub's mergeable state is clean (which counts the repository's required checks and reviews), no review asks for changes. draft cannot see which checks are required without admin rights, so it asks for all of them.
- **Three answers.** Accept: the ADR's accept commit is made as the person, signed, on the proposing branch; merging that pull request is a second acceptance, a pull request merges by rebase at the head the person saw. Request changes: the note becomes a message to the agent in the thread and the request waits for new evidence. Reject: with a reason, `adr reject` (signed, on the branch) or the pull request closed with a comment.
- **A step of the person's.** Accept and reject look at the target again first and refuse, doing nothing, if the evidence is no longer the green evidence shown. Then `step.started` (key), the action, `step.completed` with the resulting commit or merge SHA, the evidence as it was and the declared inverse, then `interrupt.settled` as the person. Nothing executes an inverse yet.
- **Only a person.** The kind's machine marks accept, reject and request-changes person-only; `proveOnlyPersonFires` proves every other actor is refused from every state. The tool policy refuses any tool, from any MCP server, whose name accepts, rejects, approves or merges (`isPersonOnlyTool`), without asking.
- **The write path.** The read client stays read-only (ADR 9p8jj6p5). Writes are `PersonTools` (`packages/core/src/person-tools.ts`, ADRs wkcnp3zr and k8af6zrg): the person's own `git` (identity, signing key and credential helper from their config; draft turns signing on for the commit and does not push an unsigned one), `gh api` (REST, gh's own sign-in) and `adr`, started without `ARK_AGENT` and `ARK_ON_BEHALF_OF`. The git work is in clones under `<data>/acceptance`, as detached worktrees at the commit judged, never in the person's working copies or a context's trusted folder, and beside `contexts/`, not in it (the clones serve repositories, not contexts; a request's events, steps and interrupts go to the log of the context whose conversation it lives in); the push is never forced, so a branch that moved is refused. draft never reads a key or a write token. `config.json` takes `gitRemotes` for repositories that are not on GitHub.
- **Local prompts have an age.** `agent.permission_asked` is written before a local permission prompt shows, and the prompt takes its time.
- **Idempotency keys.** Each step's key goes to a Kiro Remote tool that changes something when that tool's input schema advertises `idempotencyKey`. Only calls draft makes itself carry it (the person's own steps); a real ACP agent builds its own calls.

## Thread lifecycle

A thread is open, concluding (its agent drafted a conclusion and it waits for a yes), wrapped up, superseded or withdrawn. "Wrap this up" (or the Wrap up button) makes the thread's agent draft a conclusion; draft records it as `thread.conclusion_proposed` with citations (the thread, its branch point, its message count and what it produced). One confirmation, `thread.wrapped_up` as the person, returns it to the conversation the thread branched off, shown at the thread's stub and given to that conversation's agent. Declining reopens the thread. Superseded and withdrawn need a reason. Closing on production use comes later.

## Colour, and the indicator that draft is working

A colour means one thing everywhere, so a person learns it once. The palette is the one in [docs/design-system](design-system/README.md): `docs/design-system/tokens.json` is the source of truth for the colours, the type families, the spacing, the radii and the line widths, and `apps/desktop/src/shared/palette.ts` reads it (it adds only the job of each colour token). `pnpm --filter @nikovirtala/draft-desktop palette:sync` writes the tokens into the `:root` of `renderer/src/styles.css` and the table below, and a test fails when either differs from the file, when a rule outside `:root` writes a colour, or when a component names a custom property the `:root` doesn't define. `docs/design-system/components/*/preview.html` show how each part should look; the app is checked against them by eye, with the same previews beside the app's screenshots in the pull request.

States are pastel fills; the strong colour appears only in small, thin marks and in words. A failure has no colour of its own: it is the waiting fill with a dashed hairline, a cross and its words, and an open loop is a dashed ring and its words, so meaning never rests on colour alone. Purple is layered, after the Wisteria Lily theme: `moved-fill` for what moved or is under the pointer, `moved-selected` for the selected option (with ink words), `moved-mark` for icons, arcs, arrows and the working ring, `moved-word` for pastel words on the page, and `moved-strong` for a small count badge and a moved chip's word.

Each token has a job, and a test fails when one is used for another: words (`color`) take text tokens, hairlines and marks (`border`, `outline`, `stroke`, shadows) take line tokens, areas (`background`, `fill`) take fill tokens, and a mark may also fill a dot. Every line around a box is the hairline (`--hairline`, 0.5px) and every dashed one the dashed hairline (`--hairline-dashed`, 0.75px); a strong mark is never thicker than 2.5px. Every text pair reaches 4.5:1 except the two the README accepts on purpose, which the contrast test allows by name: `moved-word` on the page and `moved-strong` on `moved-fill`.

<!-- palette:start -->
| Meaning | Fill | Mark | Words |
| --- | --- | --- | --- |
| Moved, the agent's activity | `moved-fill` #ebe2fd, `moved-selected` #d7c5fb | `moved-mark` #9e6ef7 | `moved-word` #b18bf8, `moved-strong` #8c42f6 |
| Done, settled | `done-fill` #d7f2e4 | `done-mark` #009456 | `done-word` #007a47 |
| Under way elsewhere | `review-fill` #dcefff | `review-mark` #0a7fd1 | `review-word` #0069b0 |
| Waits on you, and a failure | `waiting-fill` #fbecc9 | `waiting-mark` #b87700 | `waiting-word` #8a5a00 |
| Not started, an open loop | | `idle-line` #b9c4c4, `loop-mark` #929ea0 | `muted` #5d6b6d |
| The ground and its hairlines | `page` #fef8ec, `surface` #f9f1e1, `raised` #fffdf7, `titlebar` #f0e9d6 | `line` #ece2cc, `line-strong` #e6d7b2, `edge` #cdcbb2 | `ink` #005661, `text` #44585a |
<!-- palette:end -->

The board's word colours are 3.2 to 3.8:1 on their fills, so words use the same hues darkened only as far as 4.5:1 needs (`*-word`); the board's own values stay for marks (`*-mark`), which aren't text. A word token is listed only for the surfaces it is drawn on.

In the graph, a cluster is a disc in `surface` with a `line-strong` hairline and, when something waits on you, `waiting-fill` with a `waiting-mark` hairline; the settled share is a thin `done-mark` arc; items are small discs in their state's fill with a hairline in its mark; an open loop is a dashed `loop-mark` ring; edges and tethers are `edge`; a cascade is a `moved-mark` arrow. The map's legend is chips, and its switches follow the Switch preview: the selected option is `moved-selected` with ink words.

**The chip.** Every state pill and chip is the design system's StateChip: a pastel fill, the word in the same hue, no outline (a transparent border), `radius-chip` corners, the `chip` type style (500 weight at 12.5px/1) in draft's own font, and a hover that darkens it a little and outlines it in its own colour. The one rule in `styles.css` that gives the geometry (`.pending, .chip, .thread-chip, …`) is shared, so a pill cannot drift from another, and a test reads the type style, the padding and the corners from `tokens.json`. Only "not started" has a solid hairline (`idle-line`: a closed pull request, a thread's plain chip, an empty cell of the map), an open loop a dashed one (`loop-mark`), and a failure a dashed one (`waiting-mark`) with its word and a cross. The map's cells follow the recipe by state class (purple active, green terminal, amber waiting on you). A pull request's state in its stub is such a chip: open is blue with a ring, merged is green with a check, and closed without merging is "not started" (no fill, a hairline) with a cross.

**The indicator.** `Working` (`components/Working.tsx`) is the one look for "draft is working": a purple ring that turns, and without motion stays half drawn. It appears `WORKING_DELAY_MS` (500 ms) after the work starts and goes the moment it ends, so quick work never flickers, and it is named in words for a screen reader (`role="status"`). It shows where the work shows: an agent turn at the foot of its conversation (`ConversationState.busy`, and the thread stub's chip), a stub being read next to its title (`ConversationState.resolving`, from `StubPoller.inFlight`), the map reading GitHub in its bar and its minimized line (`MapSnapshot.reading`, from `ArkMap.reading`), and a window opening its context while it boots. One quiet place, `GlobalWorking`, says whether an agent is working or statuses are being read anywhere in the window, beside the agent's state until the footer's `footer-activity` slot is there.

## The state machine module

`machine.ts` declares a machine as data: states (active, waiting with an owner and a timeout, terminal), transitions with a trigger and the actors who may fire each, and standard ends (`dismissed`, `superseded`, `withdrawn`) that need a person and a reason. `checkMachine` refuses a machine with an unreachable state, an open end, a wait without an owner or timeout, a way out of a terminal state or a transition nobody may fire. `Machine.next` checks the trigger, the actor and the reason, and `replay` runs a log through a machine and reports what it didn't allow (counted as `draft.machine.violations`). The interrupt machine of each kind and the thread machine are built on it; kinds will be.

## The map

The map (docs/model.md, "The map") is one projection of the log: `foldMap` in `packages/core/src/map.ts` folds a context's records, up to a position, through a registry of kinds, and returns rows (kinds) by columns (states) with counts, the items in each cell, which cells wait on the person, and the transitions in a time window with their times. It is a pure function of the records, so "now" is the latest position and a past moment is the same fold stopped earlier (`position`). Each item carries its context id, so projections of several contexts can be combined later.

- **A kind is a row by registering.** `KindRegistry.register` takes a `KindDecl`: an id, a label, its states in order (each `active`, `waiting` on an actor, or `terminal`), `items(input)` that lists items from the log with the path of states each went through, whether the row shows with no items (`alwaysShown`; no kind of this build does, so the empty map is the sentence `emptyMapText` writes from the registry's kinds, and a kind appears when it has an item), and where its states come from: `source: "machine"` (taken from a state machine with `statesOfMachine`) or `source: "derived"` with a `derivation` that says how, for a kind with no machine yet. A kind that can't be drawn (no states, a wait with no owner, no terminal state) is refused; a kind whose `items` throws or names an undeclared state is reported in `problems` and the rest is still drawn. `map-kinds.ts` registers today's kinds; a kind from ?8, ?41 or ?9 registers the same way, with no map code (`test/map.test.ts` proves it with a test kind).
- **Today's kinds.** Threads, interrupts by kind and acceptance requests take their states from their machines. Steps and the stubs have none, so they derive: a step is running, failed, interrupted (unfinished and not running in this process, which `Workspace.map` knows and the log doesn't), completed or settled; a Kiro session's state is the status Kiro Remote reports; a pull request's is the first rule that applies of merged, closed, failing, changes requested, draft, ready (the acceptance evidence is green), review requested, checking, open (`pullRequestMapState`).
- **The ark kinds.** Decisions, issues and the deployments of every repository a context covers are kinds too (`map-ark.ts`), registered in the context's own fork of the registry. A context covers the configured ark sources (`draft:`, `ark:`) and the GitHub repository of its trusted folder's remote. `ArkRecords` (`ark-records.ts`) reads them through the read-only GitHub client in the main process, and only while a map is on screen: one git tree per repository (listing every event file with its blob sha; when the tree sha is unchanged nothing under it is read), a file only when its blob sha is new, the open pull requests once and a pull request's tree once per head sha (for decisions proposed on a branch), and each repository's GitHub Deployments with statuses read only for a run that is new, moving, or last seen as a success. Requests carry ETags, so an unchanged refresh is four 304s per repository. States come from the resolvers' own folds (`foldStatus`, `foldIssueStatus`) applied to each prefix of a record's events; a closed issue's resolution is a note on its cell. A deployment row exists for each repository and environment, in the order of the repository's environments (below). A failed or errored run waits on the person only while it is the newest deployment of its environment (by `created_at`, then id): @nikovirtala/deployment leaves a failure as `failure` for good, so a later success in the same environment settles it as "Failed, then succeeded" and any other later run as "Failed, then replaced", both terminal. The success settles it through an edge, not a flag: `supersessions` in `map-ark.ts` is the one rule that says which run fixes which failure (the first later success of the same repository and environment), and both the settled state and the `supersedes` edge, from the fixing run to the failure it fixes, read it. The kinds read the records from `KindInput.sources`, so the fold stays pure, and a kind's `freshness` says when a rate limit or an unreadable repository leaves its counts from before: the row shows "from before" and the problems list says why, each message once however many kinds report it (`problemLines`). Ark kinds show the repositories as they are now, whatever the position.
- **Environments.** A project's environments are standing (docs/model.md, "Facts, kinds and standing"): which it has, and which follow which, holds until a decision changes it. draft has no standing store yet, so `environments.ts` keeps the topology in the one shape a standing item can take over, `EnvironmentTopology`: for a repository, its environments, each with the ones it follows (`after`) and where it was read from. Staging then production is production `after` staging; regions that deploy together follow nothing; where nothing says, each stands alone. `ArkRecords` reads it from where it lives, once per refresh and as conditional requests: GitHub's list of the repository's environments (`GET /repos/{repo}/environments`, which names them and says nothing of their order) and the environment `[project] environment` of the `deploy.toml` at the repository root (the file is in the tree already read; its blob is fetched once). `ArkSnapshot.environments` carries it. Names match as GitHub matches them, ignoring case, and a deployment is matched to its environment as the topology spells it. `environmentOrder` gives the order the rows are registered in (`KindDecl.order`, `MapRow.order`, `ClusterNode.order`: group, index, of), and the layout seeds the clusters of one repository along a line in that order, so the graph draws them as deployed. An environment that GitHub won't list (no access) is as its deployments name it.
- **Grouping and window.** `MapGrouping.columnOf` says which column a state is in: `BY_STATE` (the default) and `BY_CLASS` exist. A delivery lens will pass a grouping that puts states into phases. `window.since` and `until` bound the transitions returned; counts are always the state at the position.
- **The view.** `Workspace.map` folds the log with the running steps, and announces `{ type: "map", head }` when the log head moves; a map block asks again. A sentence such as "show the map" (`isMapRequest`) is posted for people only and becomes a `map` block of the timeline, derived from the message. The block is placed like any other (inline, minimized to a line, panel, window). Which cell is open is kept per block in the device's `map_cells` table, never in the log (ADR mxngvxkw). A cell lists its items, and an item opens its thread or stub.

### The map as a graph

The map opens as a graph, with the grid as a second layout of the same nodes ("By state", the switch beside the lenses). Three pieces make it, none of which folds the log again.

- **Edges are declared by kinds.** `KindDecl.edges(input)` lists the references a kind owns, as `from rel to` between items (`EdgeDraft`), next to `items(input)`. `foldMap` keeps an edge when both ends are items of the map, once, in a fixed order, and returns them as `MapSnapshot.edges`; a kind whose `edges` throws is a problem of that kind and the rest is drawn. `KindDecl.targetType` names the resolver type whose references are a kind's items, so a kind can point at another's items without knowing it. Only what the log or a source says is an edge; nothing is inferred. Built: a thread's mentions (`reference.made` from a thread's messages), what its confirmed conclusion produced, the thread it branched from; an acceptance request to what it asks about; a decision's supersedes (read from the proposal's `supersedes` and from the old decision's `superseded`) and links; an issue's parent (part-of) and links (depends-on, relates-to, implements a decision); a deployment to the pull request whose merge commit it deployed (`PullRequestState.mergeCommitSha`, set once merged, so only pull requests the log saw merged after this field exists are linked). A deployment that fixes a failed one of its environment supersedes it (`supersedes`, from the fixing run to the failure). `ArkRecords` reads the files of those events (once each, by blob sha, inside the refresh's budget). Left out: references from the main conversation (it is not an item), the other interrupt kinds' targets, and edges of the suggested kind.
- **A projection.** `projectGraph(snapshot, zoom)` in `map-graph.ts` is a pure function; the zoom is plain data (`context`, `kind`, `item`). At the context level each kind with items is a cluster (count, share settled, waiting on the person); an item that moved in the window (a change of state; an appearance is not a move) or waits on the person steps out as a node of its own, tethered to its cluster, up to `MAX_STEPPED_OUT` (waiting first, then the latest moves). Edges are bundled by direction with counts per relation; a bundle that carries a reference between two moved items is a cascade. An item is an open loop when something settled leads to it by a reference that is not weak (`WEAK_RELS`) and it is not settled itself. At the kind level the items lie along the kind's states, and the kinds they refer to stand at the edge; a kind with more than `MAX_OPEN_ITEMS` items shows its count by state and the stepped-out items only. At the item level it is the item and its neighbours.
- **A layout that stays put.** `layoutGraph(graph, previous)` in `map-layout.ts` seeds each node from a hash of its id (a stepped-out item around its cluster, an item in its state's lane), keeps every node the previous layout has where it was (pushed at most `MAX_SHIFT` if a neighbour grew into it) and places new nodes at their seed or the nearest free place. It is a function of the graph and the layout before it, computed outside React; the view keeps the last layout of each zoom. No layout library is used: a simulation (d3-force) re-settles every node when anything changes, and a layered layout (elkjs) is a large dependency for a graph of tens of nodes.

- **Moving about.** The viewport is a transform of the world, `screen = k * world + t`, in `map-viewport.ts`, and no function in it takes a layout, so zooming and panning can't move a node. Every input is data (`ViewportInput`: zoom about a point, pan, fit) and `applyInput` is the one place that turns it into a viewport, kept within reach of the graph so it can't be lost. The buttons, Cmd or Ctrl with plus, minus and 0, a pinch (a wheel with the control key down), the arrow keys, Space held while dragging, and a two-finger scroll all end there. A view the person hasn't moved follows the fit of the graph as the map fills in; moving it takes it over and "Fit" gives it back. A change of semantic zoom (context, kind, item) fits the new level. A scroll pans only once the view has been moved, so a page that has a graph in it still scrolls.

`MapGraph.tsx` draws it: SVG for circles, rings and edges, and a real button over each node (named, focusable), so the zoom works from the keyboard (Enter on a cluster or an item, Escape or a crumb to go out). The zoom and the layout switch are state of the open block and are not kept across restarts.

## Data model

JSON inside, markdown at the edges. Everything draft derives is stored as polymorphic JSON. Markdown is a rendering: an export, a view, the agent's working format, and ark's format in git. It is never the stored data.

Why:

- **Stable identity.** References, comments, snapshots and edges point into documents. Markdown has no stable IDs, so a reference into a paragraph breaks when the text moves. A JSON document tree gives every node an ID that survives edits.
- **Kinds need typed fields.** State machine guards check fields, not prose.
- **Structural diffs.** Generation diffs, revert and audit need "this node changed", not a line diff.

### The envelope

Every item has the same envelope, and its kind carries the body. Items are a Zod discriminated union on `kind`, built from the kind registry, so a new kind brings its own schema.

```json
{
  "id": "…",
  "kind": "assumption",
  "kindVersion": 2,
  "context": "ark",
  "actor": "kiro-local",
  "trace": "1b64…",
  "state": "load-bearing",
  "body": {
    "statement": ["document nodes, each with an id"],
    "evidence": []
  }
}
```

Rich text inside a body is a document tree: paragraphs, headings, lists, and references as inline nodes, each with its own ID.

### Rules

- **Raw stays raw.** An imported file keeps its original bytes, markdown included, because reprocessing with a new kind needs the original. Everything derived from it is JSON.
- **ark records stay markdown in git.** PR diffs, GitHub and agents read markdown well, and git is the source of truth for records. draft keeps a JSON mirror and writes markdown out deterministically; an edit made in git comes back through import, parsed into nodes and diffed. Identity across that round trip is the identity spike in the prototype plan.
- **The agent works in markdown.** It sees a markdown projection with references as tokens and writes markdown back, which draft parses into nodes. The model gets the format it handles best; the store keeps the structure.
- **Versioned bodies.** Every body carries `kindVersion`. Old versions are upcast on read; the log is never rewritten.
- **Canonical JSON for the hash chain.** Events are canonicalized (RFC 8785, JCS) before hashing, so key order can never break the chain.
- **Unknown kinds are kept.** An item whose kind this build doesn't know is stored intact and shown as a generic block, so older clients and other contexts lose nothing.
- **Plain SQL on top.** Items live in SQLite as JSONB, with generated columns and indexes on the envelope fields, so process invariants and the map stay plain SQL.

### Facts, kinds and standing

The three categories from [model.md](model.md#facts-kinds-and-standing) are an envelope field, so most checks are a query over the one log, not code that knows every kind.

- **Category beside kind.** The envelope's `kind` names an item's schema; a new `category` field (fact, kind or standing) says which store it belongs to. The kind registry declares the category of each schema, so Measurement and Usage are facts with no states, and Term is standing.
- **Standing fields.** A standing item carries `decision` (the accepted decision it came from), `tripwire` (the reopening condition, as text plus an optional predicate over facts), `scope` (universal, workspace, a context, or path globs as in `adr for <path>`), `rung` (principle, guideline or check) and `restsOn` (dated findings, each with `checkedAt` and `validUntil`).
- **Guards name what they read.** A transition guard references standing by id, and the registry records which guards read which standing, so "unread" is a query, not a judgement.
- **Fitness checks are a registry of pure functions** from a graph snapshot to findings, reusing ark's finding shape (severity, a `<area>/<name>` rule, a message, a subject): `fact/unsourced`, `standing/orphaned`, `kind/open-end` and so on. Every run appends its findings as facts. A failure with no open instance opens one, keyed by rule and subject, so a rerun never duplicates it; the instance closes when a later run shows the finding gone, with that run as evidence.
- **Three triggers.** The intake gate checks the candidate and its neighbours synchronously. Every append rechecks the subjects it touched. A scheduled sweep, a durable timer, catches expiry, timeouts and evidence that no longer resolves.
- **Acceptance is enforced in the machine.** Accepting standing or a new kind requires a person as the actor; an agent's attempt is refused by the transition, not hidden by the UI.
- **The importer is source adapters plus a review.** Agent files are split by heading and bullet into candidates; lint, commitlint and CI configuration are parsed into checks; ADRs and issues come through the `adr` and `issues` JSON views; pull request sections come from GitHub; facts from git. A candidate's key is a hash of its path and canonicalized span, so reruns are idempotent. Links between a guideline and the check that enforces it are proposed edges, reviewed like anything else. A dry run reports counts by category and writes nothing; only applying a review writes.
- **longplay is the golden test.** The classified candidates from a pinned longplay commit are a committed fixture; a change to intake shows up as a diff to it.
- **Axioms live in code,** in one module outside the registry, each with a test, so changing one is a code review, not a decision in the log.

## Testing the process

The invariants are in [model.md](model.md). This is how they run.

- **As queries.** Invariants are recursive SQL over the SQLite log and edge tables, not a new query language.
- **On fixtures.** A recorded log is a fixture. Rehydration is deterministic even though the conversation wasn't, so golden logs replay the same way every time.
- **End to end.** One scripted loop with a fake ACP agent and a fake factory runs conversation → candidate → ADR → issue → session → PR → acceptance → release → signal → answer, and asserts that the cycle closes.
- **In production.** The same queries run continuously in draft. A broken invariant is operational feedback for the component that owns it, and goes up the ladder like any other.

## Built-in feedback loop

The tool improves itself the same way ark does: friction gets reported where it happens, and a papercut is fixed before the next session runs into it. Its own development is a context inside the tool, so the loop runs on the tool's own grammar.

```mermaid
flowchart LR
    friction["Friction<br/>you, the agent, implicit signals"]
    kind["Friction kind<br/>picks it up, replays history"]
    report["Redacted report<br/>references where it came from"]
    triage["Triage and promotion gate<br/>untrusted input; big changes come to you"]
    issue["ark issue<br/>(adr for decisions)"]
    factory["Software factory<br/>fix, bake time, rollback"]
    release["Release"]
    friction --> kind --> report --> triage --> issue --> factory --> release
    release -- "posted where the papercut was reported" --> friction
```

When a release fixes a papercut, the message is posted in the conversation where it was reported, as a reference to that spot.

Where reports come from:

- **You**, in plain conversation ("this is annoying"). No separate feedback button: a friction kind picks it up.
- **The agent**, instructed to report its own papercuts: a failing tool, a missing kind, a reference it couldn't resolve. Same practice as ark's agents.
- **Implicit signals** that nobody has to report:
  - views that fall back to raw HTML, which means the component set is missing something
  - placements you undo right away
  - extractions you keep correcting
  - resolver errors
  - threads that stall

How it fits the rest of the design:

- **Friction is a kind.** Introducing it replays the whole history, so papercuts felt before the kind existed get found too.
- **Reports cross a context boundary**, so a report is a redacted snapshot with a reference back to where it came from. Nothing else from that context leaks out.
- **Reports are untrusted input.** They can carry prompt injection, so they go through the same triage and promotion gate as in ark, and dramatic changes still come to you.
- **The development context uses ark directly:** issues for papercuts, adr for decisions, and the software factory for fixes, with bake time and rollback on release.
- **New kinds and components come from the same loop.** Repeated raw-HTML fallbacks suggest a component; repeated corrections suggest a better kind version.

Open question: what counts as a papercut automatically, and what needs your confirmation first?

## Non-functional requirements: observability and audit

The implementation must be fully observable (usage and diagnostics) and auditable. Most of the audit comes from the design itself, because every change is already an event in an append-only log. Observability has to be built in from the first commit.

### Audit

- **The context log is the audit trail.** Messages, decisions, agent actions, tool calls, permission answers, page reads, reprocessing runs and promotions are all events in it. Nothing changes state outside the log.
- **Every event has an actor:** you, the agent of a given thread (with model and version), a kind (with version), a resolver, or the factory. The agent never acts under your identity.
- **Every agent action records its grounds:** the references it loaded as context, the tools it called and their results. "Why did it do that?" is answered from the log, not by guessing.
- **Cross-boundary access is recorded:** each read across contexts, each web page read, each report sent to the development context.
- **The log is tamper-evident.** Events are hash-chained, which the git-backed ledger gives for free, so a rewritten history shows.
- **Interpretations are auditable too.** Every extracted item names its raw source, kind version and model, and every generation promotion records what changed and who approved it.

### Observability

- **One trace per turn.** A trace ID follows a message from the UI through the ACP session, the agent's tool calls and permission requests, resolvers and kinds. The same ID is stamped on the log events the turn produced, so diagnostics and audit join up.
- **OpenTelemetry for traces, metrics and logs,** exported to whatever backend is at hand. Locally a collector is enough; on AWS the usual managed services.
- **Usage is measured:** placements, references, threads, kinds in use, feedback signals. These metrics also feed the built-in feedback loop.
- **Cost is measured:** tokens and model time per turn, thread, context and reprocessing generation, as far as the agent reports them over ACP, checked against the configured budgets.
- **Health is measured:** latency per step, resolver freshness, failed and retried tool calls, raw-HTML fallbacks, reprocessing backlog.
- **Telemetry carries IDs and numbers, never content.** Message text, artifacts and page contents stay in their context's log, so observability never becomes a way around the context boundary.
- **Usage carries its version.** Usage metrics have the running SHA as a dimension beside route, operation, event name and flag, so a change can be matched to its use. Few versions run at once, so the extra dimension is cheap.

## Deploy provenance

The pipeline stamps, draft reads. The model is in [model.md](model.md), under "From running code back to its thread".

- **In the telemetry.** The deploy pipeline sets OpenTelemetry resource attributes: `service.version`, `vcs.ref.head.revision` (the commit SHA), `vcs.repository.url.full` and `deployment.environment.name`. The VCS attributes are still in Development status in OpenTelemetry's semantic conventions, so their names may change ([VCS attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/)).
- **On AWS.** CloudWatch Application Signals emits deployment events at startup and every 24 hours, enriched by `OTEL_AWS_SERVICE_EVENTS_GIT_COMMIT_SHA`, `OTEL_AWS_SERVICE_EVENTS_GIT_REPO_URL`, `OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_ID`, `OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_TIMESTAMP` and `OTEL_AWS_SERVICE_EVENTS_DEPLOYMENT_URL`. It supports Java, Python and Node.js and is disabled in Lambda, where the resource attributes do the job ([Application Signals service events](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ServiceEvents.html)).
- **The deployment ledger.** CI creates a GitHub deployment for the SHA and environment and sets its status. draft's deployment kind reads deployments and deployment statuses through a resolver ([GitHub deployments API](https://docs.github.com/en/rest/deployments/deployments)).
- **The deployment range.** The commits between the previously deployed SHA and the new one, and the PRs they belong to.
- **Diff to signal.** A kind maps a PR's changed files and functions to the routes, handlers, events and flags they affect, so the matching usage on the new SHA can be found. Where the diff maps to nothing observable, the agent proposes a named signal or "close on deploy".
- **The factory needs nothing new.** It merges as it does today.

### Line-level evidence

Three tiers, trading cost against precision:

| Tier | How | Gives | Cost and caveats |
| --- | --- | --- | --- |
| Function level, always on | Spans carry the stable code attributes `code.function.name`, `code.file.path` and `code.line.number`, plus the version | Which changed functions ran on the new SHA | Cheap; covers only code that has spans |
| Line level, sampled | The OpenTelemetry profiles signal: sampled stacks, linked to the active trace and span, with the version | Hit lines per SHA on hot paths | Low cost; a hit is proof, a miss isn't. The signal is in public alpha (March 2026) and not yet for critical use |
| Line level, precise, on a slice | V8 precise block coverage (`Profiler.startPreciseCoverage`) on one instance or a share of invocations, for a window after the deploy, then off | Exactly which blocks of the changed code ran | Bounded overhead during the window, like a canary |

- **Source maps.** Runtime lines are JavaScript; every release ships its source maps so hits map back to the TypeScript lines in the diff.
- **The timeout's evidence.** At the usage timeout, changed executable lines with no hit in any tier trigger the agent's question; [model.md](model.md) has the rule.

Sources: [code attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/), [profiles signal](https://opentelemetry.io/docs/concepts/signals/profiles/), [V8 code coverage](https://v8.dev/blog/javascript-code-coverage).

## Technology choices

The first live prototype is a local, single-user desktop app in TypeScript, built mostly from parts that already exist. Versions are the latest major releases as of 20 November 2026.

| Layer | Choice | Version | Why |
| --- | --- | --- | --- |
| Runtime for tooling | Node.js | 26 LTS | The current LTS line. The app itself runs on the Node that Electron bundles (24.22 in Electron 45). |
| Language | [TypeScript](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) | 7.0 | The native Go compiler: 8 to 12 times faster builds. |
| Package and tool versions | pnpm, mise | pnpm 12 | The existing setup. |
| Desktop shell | [Electron](https://releases.electronjs.org/) | 45 | Real windows and native web views for the built-in browser, TypeScript all the way down. |
| Build | electron-vite with Vite | 6 with 8.3 | What slice 1 found current on 20 Nov 2026. |
| UI | [React](https://react.dev/blog/2026/09/09/react-19-3) | 19.3 | Renders the fixed component set from view descriptions. |
| Schemas | Zod | 4 | View descriptions, events and tool inputs. |
| Agent protocol | [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) (`@agentclientprotocol/sdk`), client side | 2.8 (ACP protocol version 1) | One protocol for every agent, one session per conversation address. Slice 2. |
| Agents | Kiro CLI (`kiro-cli acp --agent-engine=v3 --auth-method=cli`), and Claude through [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) | Kiro CLI 3.5, claude-agent-acp 0.109 | Local Kiro by default, with its own sign-in; Claude by configuration, with a Console API key from the environment. |
| Hosted coding agents | Kiro Remote | current | Live stubs and interrupts from draft's resolver, and an MCP server for the local agent. |
| GitHub and artifact pages | REST API, read only; the artifact server's JSON API | 2022-11-28 | Pull request, ADR and ark issue stubs; no SDK, `fetch` with ETags. Writes only through the person's own `git`, `gh` and `adr`. |
| The tool's own MCP server | MCP TypeScript SDK | 1.32 | Exposes contexts to other agents and to Claude. |
| Raw log | draft's own append-only, hash-chained log | slice 1 | The ark ledger measured about 5 ms per message and stays an option; slice 1's PR records why draft started with its own. |
| Views and graph index | SQLite through [node:sqlite](https://nodejs.org/docs/latest/api/sqlite.html) | built in (release candidate) | No native module to rebuild for Electron. |
| Telemetry | [OpenTelemetry JS SDK](https://opentelemetry.io/blog/2026/otel-js-sdk-3-0/) | 3.0 | Traces, metrics and logs are all stable in JavaScript. A local collector for now. |
| Raw HTML views | artifact | v1 | The escape hatch, with reload over SSE. |

Left out of the first prototype: sharing contexts, imports of other sources, kinds and reprocessing, AWS deployment and sign-in.

Native Swift stays the candidate for version 2, once the grammar has settled. Tauri was passed over because it adds Rust and embedding external sites inside a panel is still rough there.

## Claude and claude.ai

Claude is one of draft's agents. It runs through claude-agent-acp, the ACP adapter for the Claude Agent SDK, with a Claude Console API key. Anthropic's docs say apps built on the Agent SDK must not offer claude.ai sign-in unless Anthropic has approved it, so the API key is the way ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).

What could carry over by itself: on the Agent SDK, Claude loads skills, memory files and plugins from `~/.claude` and from the project's `.claude` folder, the same way Claude Code does. Slice 2 launches the adapter with `settingSources: []`, because those settings can also allow tools without asking (ADR 06wp7907), so none of it loads yet. Loading skills and memory without the permission settings is a follow-up; once it lands, the skills in `nikovirtala/skills` work in the tool as they are.

What doesn't carry over: claude.ai memory, past chats, artifacts and claude.ai connectors. They live in claude.ai and can't be reached through the API. Three bridges cover the gap:

- **The tool as an MCP server for Claude.** It exposes contexts as tools: read, search, reference, append. Locally it's added to the Claude desktop app. Later it runs on AWS with OAuth 2.1, like Kiro Remote, as a custom connector, so Claude on any device works in the same contexts.
- **Claude's history as a source.** The claude.ai data export is imported into a context as raw data, and a conversation kind turns past chats into threads and references. This is the import pipeline doing its normal job.
- **Shared tools.** Your own MCP servers (Kiro Remote, ark, Longplay) connect to both the tool and claude.ai, so both see the same sessions, issues and decisions.

Going forward, the context graph replaces memory inside the tool, with better guarantees: everything has a source, a version and an actor.

## Prototype plan

The first job to test: supervising the software factory's Kiro sessions from one conversation, without opening Kiro, GitHub or anything else. It has real stakes, clear interrupts and daily use, so it shows quickly whether the mental load actually drops.

1. **Diary week.** Use Claude with the Kiro Remote MCP and artifacts as a rough version of the tool. Write down every moment you have to leave, or lose track. That list becomes the spec, and the first run of the feedback loop.
2. **Slice 1: log and live Kiro session stubs.** Built in draft PR #1, proven against fakes: the hash-chained log with an actor and trace ID on every event, projections, the Kiro session resolver, the conversation UI and telemetry. Its agent ran in-process on the Agent SDK.
3. **Slice 2: agents over ACP. Done.** One ACP client runtime: local `kiro-cli acp` by default, `claude-agent-acp` as the alternative, sessions keyed by conversation address and started from one projection of the log, permission requests as steps, unasked calls as interrupts. The Agent SDK runtime is gone. Every message carries its audience, and the agent can be paused and played. A half-written last line of the log is moved aside instead of refusing the log. Proven against a scripted ACP agent over stdio, and in one real turn with kiro-cli.
4. **Slice 3: blocks, placements and focus. Done.** Inline, minimized, panel and a real Electron window, threads branched off any message with their own agent session and a live stub at the branch point, and focus. Placement and focus are per-device view state and survive a restart. Proven on two scripted ACP agents in Electron.
5. **Interrupts and attention. Done.** Kiro Remote permission requests, PR events, failed and interrupted steps arrive in the thread they belong to, in one attention order with the local agent's own requests, and are settled there as you. Live stubs for pull requests, ark issues and artifact pages. A thread wraps up and its conclusion returns to the main conversation. Thread and interrupt lifecycles run on one state machine module. Proven against a fake Kiro Remote, a fake GitHub and a scripted ACP agent in Electron.
5a. **Contexts bound to folders.** Several contexts on one device, each with its own log, view state, agent and window, listed in a device-local registry. A folder a person trusted is where the context's agent works; the existing log stays as `local`. Opened by sentence, from a recent list, with a path at launch or by importing an older data directory. References across contexts keep a snapshot and are recorded as crossings. Proven in Electron on the scripted ACP agent.
5b. **Acceptance. Done for ADRs and pull requests.** An interrupt kind ranked after failures, shown only with green evidence its kind declares, answered as you with your own git identity, signing key and gh sign-in: accept (an ADR is a signed commit on its pull request's branch, merging is a second acceptance), request changes (a message to the agent) or reject with a reason. Person-only transitions proven by the checker, every effect with its declared inverse, an ADR resolver, step idempotency keys where Kiro Remote advertises them, and an age in the log for local permission prompts. Proven against a local bare git repository and a fake GitHub with a test identity and SSH key, and in Electron. Left for later: accepting issues, drafting records from conversations, executing reverts.
6. **Graph, linear view, import.** The identity spike comes right before the first kinds: decision, task and design candidates from conversations, promoted into ark records, with a replay over the existing history.
7. **Multiplayer.** A shared, hosted log, identities and sign-in, the driver role and personal notes.

Each step is usable on its own, and the diary week may reorder the rest.

## Open questions

- [ ] The prototype runs on Electron. Does version 2 move to a native shell, close to Two Voices, once the grammar has settled?
- [ ] Can the ark ledger hold both the conversation log and the interpretation events?
- [ ] How do extracted items get stable IDs: derived from the source, or a matching step after extraction?
- [ ] What's the cost budget for reprocessing, and does it run only when a context is opened?
- [ ] What does draft show for cost when an agent doesn't report token usage over ACP? Slice 2 records only what is reported (Kiro reports credits and context fill, not tokens) and shows nothing yet.
- [ ] Where does the shared log live for multiplayer?
