# Build the desktop shell on Electron with electron-vite

## Context
The first prototype is a local, single-user desktop app in TypeScript. The design chose Electron for real windows and native web views (needed for the built-in browser, since many sites refuse iframes) and passed over Tauri, which adds Rust and makes embedding external sites in a panel rough. The build tool named was electron-vite 5 with Vite 8.1.

On 20 November 2026 electron-vite 5.0.0 supports Vite 5 to 7 only; electron-vite 6.0.0 is the latest stable and supports Vite 6 to 8.

## Decision
The desktop shell is Electron 45 built with electron-vite 6 on Vite 8.3 and React 19.3. The renderer runs sandboxed with context isolation and no Node integration, behind a strict Content Security Policy, and reaches the main process only through a small preload bridge that carries view state. Links never navigate the window. The domain lives in `packages/core`, which has no Electron dependency and is bundled into the main process from source.

## Scope
The desktop app in `apps/desktop`: its process model, build and renderer security.

## Consequences
- One language from the domain to the UI, and core stays usable by draft's own MCP server later.
- electron-vite 6 is used instead of 5, so the build follows Vite 8.
- Electron apps are large and need signing and notarization per platform, which this slice doesn't do yet.
- A native shell for version 2 stays an open question in the design.
