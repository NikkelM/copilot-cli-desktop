# Copilot CLI Desktop

[![CI](https://github.com/NikkelM/copilot-cli-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/NikkelM/copilot-cli-desktop/actions/workflows/ci.yml)

A low-footprint desktop shell for the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli).

Sessions are listed in a sidebar ordered by last use. Browsing them costs nothing:
a session is only loaded into a running Copilot process when you actually send it a
message, so a week-old session you never open never consumes memory.

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
| Leave a session untouched for ten minutes | It is disconnected, freeing its memory |

Resuming takes roughly 1.5-6 s depending on history size, which is why it is
deferred until it is genuinely needed. There is no cap on how many sessions may be
loaded at once: how many are worth keeping is your judgement, and the idle timer
reclaims whatever you stop using.

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
npm run app        # builds the sidecar, stages its bundle, then launches the Tauri dev shell
```

The first launch stages the sidecar's runtime dependencies into `src-tauri/sidecar-bundle`,
which takes about thirty seconds and 120 MB. Later launches cost nothing: the compiled tree is
refreshed and the dependencies are left alone unless `sidecar/package.json` changed.

That directory is declared as a bundle resource, which means **tauri-build refuses to compile
the crate without it** - so `cargo check` and `cargo clippy` in `src-tauri` need
`npm run bundle:sidecar` to have run at least once.

Other useful scripts:

```bash
npm run typecheck      # frontend and sidecar
npm test               # vitest, or npm run test:watch
npm run build:sidecar  # compile the sidecar only
npm run bundle:sidecar # stage the sidecar and its dependencies for packaging
npm run tauri build    # production bundle
```

### Tests

Vitest, run in Node with no DOM. Coverage is deliberately concentrated on logic where a
mistake is silent rather than obvious:

- **Session index** runs real SQL against a temporary database built with the CLI's own
  schema. Every bug here so far has been about which column or file the data came from,
  which a stubbed data layer would not have caught.
- **Runtime** covers the memory rules the whole design rests on: lazy start, resume
  deduplication, eviction on idle, never evicting mid-turn, and settling permission requests
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

## Design constraints

Two rules that outrank any single feature:

**Idle sessions cost nothing.** Browsing, searching and reading history are disk reads.
Only sending a message, or changing something that belongs to a running session, resumes
one.

**Everything is reachable from the keyboard.** This replaces a terminal, and anyone coming
from one should not have to reach for the mouse. Buttons and menus are welcome, but no
capability may exist only as a click target: whatever a widget does must also be invocable
by keyboard, and in time by slash command
([#72](https://github.com/NikkelM/copilot-cli-desktop/issues/72),
[#19](https://github.com/NikkelM/copilot-cli-desktop/issues/19)).

## Notes

Reads the CLI's own state directory, so existing instructions, agents, skills and
hooks apply unchanged. Session data is only ever read; the CLI remains the owner.

Not affiliated with GitHub. GitHub also ships an official
[Copilot app](https://docs.github.com/copilot/concepts/agents/github-copilot-app),
which is repository-centric; this project targets lightweight session management
across arbitrary folders, including ones that are not git repositories.

## Releases

Built by the `Release` workflow, started by hand with a version number. The tag is created
only after the build has passed its tests, so a tag here always names something that built.
Run it as a dry run first: it produces the installers as workflow artifacts and publishes
nothing. Release notes come from `CHANGELOG.md`, between the `Releasenotes` markers.

### On signing

The installers are **not signed**, so Windows warns on first launch.

SignTool is not the missing piece - Tauri already calls it, through
`bundle.windows.certificateThumbprint` for a certificate in the Windows store, or
`bundle.windows.signCommand` for anything else. What is missing is a certificate, and the
options are worse than they used to be:

- **Self-signed** costs nothing and signs happily, but Authenticode only trusts a chain
  ending at a root the machine already trusts. Anyone else still sees an unknown publisher,
  which reads worse than no signature at all.
- **A bought OV certificate** cannot be used from CI. Since June 2023 the CA/Browser Forum
  requires the private key to live on FIPS 140-2 Level 2 hardware, so there is no `.pfx` to
  put in a secret - signing means a USB token in a machine, by hand.
- **EV certificates** have the same hardware requirement and cost more, but carry SmartScreen
  reputation immediately, which OV does not: an OV signature still warns until the download
  count builds reputation.
- **[SignPath Foundation](https://signpath.org/apply.html)** signs open source projects for
  free, from CI, via `signCommand`. It requires an OSI-approved licence, which GPL-3.0 is,
  and a **public** repository, which this is not yet. That is the route worth taking if this
  ever goes public.

## Licence

Copyright (C) 2026 Nikkel Mollenhauer

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.
See [LICENSE](LICENSE).

Every dependency is permissively licensed - MIT, ISC, BSD, Apache-2.0 or MPL-2.0 -
so nothing here conflicts with that choice. Note that Apache-2.0 is compatible with
GPL version 3 but not version 2, which is one reason this is v3.
