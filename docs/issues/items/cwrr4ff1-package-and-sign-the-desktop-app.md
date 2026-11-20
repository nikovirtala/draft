# Package and sign the desktop app

## Goal
Build installable, signed draft apps for macOS, Windows and Linux.

## Notes
- The Agent SDK's platform binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, about 370 MB) must be unpacked from the asar archive; `packagedClaudeExecutable` in `apps/desktop/src/main/agent-sdk.ts` already points at `app.asar.unpacked` in a packaged app.
- macOS needs signing and notarization, including the unpacked Claude Code binary.
- Decide where the Anthropic API key comes from in a packaged app (today: the main process environment); safeStorage is the likely home.

## Done when
- CI produces signed installers for each platform.
- A packaged app starts the agent with the unpacked binary.
- The API key can be entered once and is kept encrypted.
