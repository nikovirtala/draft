# draft

A desktop app where everything folds around one conversation. See the [design](docs/00-draft-v1.md).

This first slice: one context, one conversation. You type, Claude answers with the Kiro Remote MCP tools at hand, and every Kiro session mentioned shows up as a live one-line stub. Everything that happens is an event in an append-only, hash-chained log, and the conversation comes back from the log alone after a restart.

## Layout

- `packages/core`: the domain, with no Electron dependency: addresses, events, the log and its verify, SQLite projections, references, resolvers, the agent interface and telemetry. `@nikovirtala/draft-core/testing` has a fake Kiro Remote MCP server.
- `apps/desktop`: the Electron app (electron-vite, React).

## Run it

Tools come from `mise.toml` (Node 26, pnpm).

```sh
pnpm install
pnpm build
ANTHROPIC_API_KEY=… DRAFT_KIRO_REMOTE_URL=https://<kiro-remote-host> pnpm --filter @nikovirtala/draft-desktop dev
```

The first Kiro Remote call opens the browser to sign in (OAuth 2.1 with PKCE); tokens are kept with Electron safeStorage. The API key is read from the main process environment only.

| Variable | Meaning |
| --- | --- |
| `DRAFT_KIRO_REMOTE_URL` | Kiro Remote's base URL; the MCP endpoint is `<base>/mcp`. Also `kiroRemoteUrl` in `config.json` in the data directory. |
| `DRAFT_MODEL` | The model, `claude-opus-5-5` by default. Also `model` in `config.json`. |
| `DRAFT_DATA_DIR` | Where the log (`log.jsonl`), views (`views.db`), device view state (`device.db`) and secrets live. Default: Electron's userData. |
| `DRAFT_AGENT=fake`, `DRAFT_FAKE_SCRIPT` | A scripted agent instead of Claude, for tests. |
| `DRAFT_KIRO_AUTH=none` | No sign-in, for a local fake Kiro Remote. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export traces, metrics and logs over OTLP/HTTP; otherwise they go to the console. |

## Check it

```sh
pnpm check        # typecheck, lint, unit tests, build
xvfb-run -a pnpm test:e2e   # Electron end to end with the fake agent and fake Kiro Remote
```
