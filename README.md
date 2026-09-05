# Copilot CLI Desktop

A low-footprint desktop shell for the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli).

Sessions are listed in a sidebar ordered by last use. Browsing them costs nothing:
a session is only loaded into a running Copilot process when you actually send it a
message, so a week-old session you never open never consumes memory.

> Status: early scaffold. The session browser is the first milestone; the live
> session runtime is stubbed and lands next.

## Why

Running several sessions in the plain CLI is expensive, because each one is a chain
of three resident processes (`node` npm-loader → `copilot` relauncher → `copilot`
session). Measured on Windows with 8 sessions open, only 2 of them doing work:

| | Plain CLI, 8 sessions | One shared server, idle | Same server, 3 sessions resumed |
|---|---|---|---|
| Processes | 22 | 1 | 1 |
| Working set | 1,123 MB | 206 MB | 865 MB |
| Commit charge | 13,247 MB | 250 MB | 1,011 MB |

Idle sessions dominate that cost while contributing nothing.

## How it works

The CLI ships a version-matched TypeScript SDK (`@github/copilot-sdk`) that speaks
JSON-RPC to a single CLI server process. One server can host many sessions, and
individual sessions can be resumed and disconnected independently -
`disconnect()` frees memory but leaves on-disk state intact.

Two observations make the lazy design work:

1. `session-store.db` already holds every session's title, working directory and
   last turn, so the whole sidebar is one read-only SQLite query.
2. `~/.copilot/session-state/<id>/events.jsonl` stores history in the *same* shape
   the SDK emits live, so replayed and streaming events render through identical code.

Together these decouple *viewing* from *loading*:

| Action | Cost |
|---|---|
| List sessions | SQLite query, no process |
| Open a session and read its history | Read `events.jsonl`, no process |
| Send a message | `resumeSession()` in the shared server |
| Exceed the loaded-session cap | Least recently used session is disconnected |

Resuming takes roughly 1.5-6 s depending on history size, which is why it is
deferred until it is genuinely needed.

## Architecture

```
src/            React + TypeScript frontend
shared/         Wire protocol shared by frontend and sidecar
sidecar/        Node process; owns the SDK and all Copilot state
src-tauri/      Tauri v2 shell; spawns the sidecar, bridges JSON-RPC to the UI
```

Tauri reuses the system WebView2/WebKit instead of bundling Chromium, which keeps
the shell itself at roughly 40 MB rather than ~250 MB.

The sidecar is Node rather than Rust because the SDK is TypeScript and ships
alongside the installed CLI, keeping SDK and CLI versions in lockstep.

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), logged in
- Node.js 24+ (uses the built-in `node:sqlite`, so there are no native dependencies)
- Rust toolchain and a platform WebView, per the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/)

## Development

```bash
npm install
npm run app        # builds the sidecar, then launches the Tauri dev shell
```

Other useful scripts:

```bash
npm run typecheck      # frontend and sidecar
npm test               # vitest, or npm run test:watch
npm run build:sidecar  # compile the sidecar only
npm run tauri build    # production bundle
```

### Tests

Vitest, run in Node with no DOM. Coverage is deliberately concentrated on logic where a
mistake is silent rather than obvious:

- **Session index** runs real SQL against a temporary database built with the CLI's own
  schema. Every bug here so far has been about which column or file the data came from,
  which a stubbed data layer would not have caught.
- **Runtime** covers the memory rules the whole design rests on: lazy start, resume
  deduplication, LRU eviction, never evicting mid-turn, and settling permission requests
  on every teardown path, since the agent blocks on that promise.
- **Transcript** covers the event to entry mapping, including pairing tool calls and
  cancelling ones interrupted before they completed.
- **Ordering** covers the rule that the active group must not reshuffle while in use.

`RuntimeOptions.createClient` exists so the runtime can be exercised without spawning a
real CLI.

Environment overrides, mostly for testing:

| Variable | Purpose |
|---|---|
| `COPILOT_HOME` | Point at a different `.copilot` directory |
| `COPILOT_CLI_PATH` | Use a specific CLI executable |
| `COPILOT_DESKTOP_NODE` | Node binary used to launch the sidecar |
| `COPILOT_DESKTOP_SIDECAR` | Path to the built sidecar entrypoint |
| `COPILOT_DESKTOP_DEV_PORT` | Enable the dev channel described below |

### Driving the app during development

The app owns its sidecar over stdio, so it cannot be scripted from outside by default:
starting a second sidecar would start a second CLI server that the running app never
sees. Setting `COPILOT_DESKTOP_DEV_PORT` makes the sidecar also accept the same
JSON-RPC on loopback, so requests are handled by the app's own sidecar and its
notifications drive the real UI.

```bash
COPILOT_DESKTOP_DEV_PORT=8791 npm run app

node scripts/drive.mjs runtime.status
node scripts/drive.mjs sessions.send '{"sessionId":"<id>","prompt":"hello"}' 30000
```

The channel binds to `127.0.0.1` only and never listens unless the variable is set.

`scripts/Capture-Window.ps1` captures the window to a PNG for visual checks. It reads
the window's own buffer with `PrintWindow`, so it never captures anything else on the
desktop and does not need focus. It also marks itself DPI aware, without which a scaled
display reports virtualised window coordinates and the capture comes out cropped.

```powershell
./scripts/Capture-Window.ps1 -Out shot.png
```

## Roadmap

Work is tracked in [issues](https://github.com/NikkelM/copilot-cli-desktop/issues),
grouped under epics:

- [x] Zero-process session browser: sidebar and history replay from disk
- [ ] [#1 Live session runtime](https://github.com/NikkelM/copilot-cli-desktop/issues/1) - lazy resume on first send, LRU and idle eviction
- [ ] [#7 Rich transcript rendering](https://github.com/NikkelM/copilot-cli-desktop/issues/7) - markdown, tool calls, reasoning, usage meters
- [ ] [#14 Session interaction and control](https://github.com/NikkelM/copilot-cli-desktop/issues/14) - permissions, elicitation, queued messages, slash commands, model and mode
- [ ] [#21 Environment and configuration](https://github.com/NikkelM/copilot-cli-desktop/issues/21) - skills, agents, MCP servers, working directories
- [ ] [#27 Session lifecycle management](https://github.com/NikkelM/copilot-cli-desktop/issues/27) - create, rename, fork, delete, search
- [ ] [#31 Wiki browser](https://github.com/NikkelM/copilot-cli-desktop/issues/31) - browse the local `~/.copilot/wiki` with a markdown viewer
- [ ] [#36 In-app file diffs](https://github.com/NikkelM/copilot-cli-desktop/issues/36) - show only the changes the current agent made
- [ ] [#41 In-app git editor](https://github.com/NikkelM/copilot-cli-desktop/issues/41) - stage, commit and push

## Notes

Reads the CLI's own state directory, so existing instructions, agents, skills and
hooks apply unchanged. Session data is only ever read; the CLI remains the owner.

Not affiliated with GitHub. GitHub also ships an official
[Copilot app](https://docs.github.com/copilot/concepts/agents/github-copilot-app),
which is repository-centric; this project targets lightweight session management
across arbitrary folders, including ones that are not git repositories.
