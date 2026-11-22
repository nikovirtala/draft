# draft

A desktop app where everything folds around one conversation. The design is in two parts: [the model](docs/model.md), which stays true however draft is built, and [the implementation](docs/implementation.md), how it is built now.

One context, one conversation. You type, an agent answers over ACP with the Kiro Remote MCP tools at hand, and every Kiro session mentioned shows up as a live one-line stub. The agent is local `kiro-cli` by default, or Claude through `claude-agent-acp`. Anything that changes something asks you first and is recorded as a step before it runs. Asides (Option+Enter) are for people only, and the agent can be paused. Everything that happens is an event in an append-only, hash-chained log, and the conversation comes back from the log alone after a restart.

## Layout

- `packages/core`: the domain, with no Electron dependency: addresses, events, the log and its verify, SQLite projections, the agent context, references, resolvers, the agent interface and telemetry. `@nikovirtala/draft-core/testing` has a fake Kiro Remote MCP server.
- `apps/desktop`: the Electron app (electron-vite, React). `src/main/acp/` is the ACP client; `test/fake-acp-agent.ts` is a scripted ACP agent for the tests.

## Run it

Tools come from `mise.toml` (Node 26, pnpm). Install [Kiro CLI](https://kiro.dev/docs/getting-started/installation/) and sign in with `kiro-cli login`.

```sh
pnpm install
DRAFT_KIRO_REMOTE_URL=https://<kiro-remote-host> pnpm --filter @nikovirtala/draft-desktop dev
```

`dev` compiles as it starts and reads `draft-core` from its source, so nothing needs building first; `pnpm check` and the end-to-end tests build. To open a project, pass its absolute path after `--`: `pnpm --filter @nikovirtala/draft-desktop dev -- "$HOME/src/my-project"`.

For Claude instead, install the adapter (`npm install -g @agentclientprotocol/claude-agent-acp`), set `"agent": "claude"` in `config.json` (or `DRAFT_AGENT=claude`), and start draft with `ANTHROPIC_API_KEY` set. draft stores no agent credential: Kiro keeps its own sign-in, and the key is read from the environment draft starts from and passed only to the Claude adapter.

The first Kiro Remote call opens the browser to sign in (OAuth 2.1 with PKCE); tokens are kept with Electron safeStorage and handed to the agent as a bearer header.

`config.json` in the data directory:

```json
{
  "kiroRemoteUrl": "https://<kiro-remote-host>",
  "agent": "kiro",
  "agents": { "kiro": { "command": "/full/path/to/kiro-cli", "args": ["acp", "--agent-engine=v3", "--auth-method=cli"] } }
}
```

`agents` overrides how a built-in agent starts, or defines any other ACP agent (`command`, `args`, `env`, and optionally `kind` to configure it like `kiro` or `claude`).

| Variable | Meaning |
| --- | --- |
| `DRAFT_KIRO_REMOTE_URL` | Kiro Remote's base URL; the MCP endpoint is `<base>/mcp`. Also `kiroRemoteUrl` in `config.json`. |
| `DRAFT_AGENT` | The agent: `kiro` (default), `claude`, or one defined under `agents`. Also `agent` in `config.json`. |
| `DRAFT_AGENT_COMMAND`, `DRAFT_AGENT_ARGS` | The selected agent's command and its arguments (a JSON array), for tests and one-off runs. |
| `ANTHROPIC_API_KEY` | Claude's Console API key, read by `claude-agent-acp`. |
| `DRAFT_ACP_TRANSCRIPT` | A file to record the ACP traffic in, with header and env values redacted. |
| `DRAFT_DATA_DIR` | Where the log (`log.jsonl`), views (`views.db`), device view state (`device.db`), secrets and the agent's working directory (`agent-workspace/`) live. Default: Electron's userData. |
| `DRAFT_KIRO_AUTH=none` | No sign-in, for a local fake Kiro Remote. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export traces, metrics and logs over OTLP/HTTP; otherwise they go to the console. |

## Check it

```sh
pnpm check        # typecheck, lint, unit tests, build
xvfb-run -a pnpm test:e2e   # Electron end to end with the fake ACP agent and fake Kiro Remote
DRAFT_REAL_AGENT=kiro pnpm --filter @nikovirtala/draft-desktop exec vitest run test/real-agent.test.ts   # one real turn
```

Without a display, the end-to-end test runs Electron with `--ozone-platform=headless`.
