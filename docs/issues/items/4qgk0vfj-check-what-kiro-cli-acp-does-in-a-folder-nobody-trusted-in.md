# Check what kiro-cli acp does in a folder nobody trusted in Kiro

## Goal
Run a real kiro-cli acp session in a freshly bound folder and record whether Kiro shows or enforces its workspace trust gate there.

## Notes
Kiro's docs describe the Trust this workspace screen for interactive V3 sessions and say non-interactive runs are not gated; they don't say what ACP does. ADR 1vey5j12 leaves Kiro's trust to Kiro and relies on its asking before shell and MCP calls.

## Done when
- The behaviour is written down in the ADR or implementation.md with the Kiro version.
- If ACP loads the folder's .kiro configuration without asking, an issue covers what draft does about it.
