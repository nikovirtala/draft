# Sign in to Kiro Remote with draft's own OAuth flow

## Context
Kiro Remote's MCP endpoint is `<base>/mcp`, a protected resource. A client finds the authorization server through `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, registers with Dynamic Client Registration at `/oauth/register`, and signs in with the authorization code flow and S256 PKCE. A registered loopback redirect `http://127.0.0.1/callback` matches any port (kiro-remote's `loopbackRedirectMatches`).

The Agent SDK's HTTP MCP server config takes `url` and static `headers` only; it has no OAuth settings for a host app.

## Decision
draft runs the OAuth 2.1 flow itself, as a native app, with the MCP TypeScript SDK's `auth()` and an `OAuthClientProvider` (`KiroOAuth`): Dynamic Client Registration with the loopback redirect, sign-in in the system browser, and a one-shot listener on 127.0.0.1 and an ephemeral port. The access token goes to the Agent SDK as an `Authorization: Bearer` header. draft's own resolver uses the same provider with the MCP SDK's Streamable HTTP client.

Tokens and the client registration are kept with Electron `safeStorage`, encrypted at rest, and refreshed when less than a minute is left. A refreshed token restarts the conversation's SDK session with the new header.

## Scope
Authentication to Kiro Remote from draft: `packages/core/src/oauth.ts`, `kiro-client.ts` and `apps/desktop/src/main/secrets.ts`.

## Consequences
- One sign-in serves both the agent and the resolvers, and no token is ever in config, logs or telemetry.
- Restarting the SDK session on refresh drops the agent's in-session context; it is rebuilt from the log.
- On Linux without a keyring, safeStorage is unavailable, and tokens last for one run only.
- Tested against a fake facade only. The real Cognito-backed flow still needs a first local run with real credentials.
