# Copilot CLI Desktop

[![CI](https://github.com/NikkelM/copilot-cli-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/NikkelM/copilot-cli-desktop/actions/workflows/ci.yml)

> [!WARNING]
> This project is still under development - expect bugs and changing behaviour.
> Development is AI-assisted.
> Windows installers are available in [Releases](https://github.com/NikkelM/copilot-cli-desktop/releases) - the app is still in development.
> This is an unofficial project and isn't affiliated with or endorsed by GitHub.

A low-footprint desktop shell for the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli).
You can browse existing sessions and their history without resuming them in the CLI.
Sending a message or changing runtime-owned settings resumes the session when needed.

## At a glance

- Browse sessions in active/favourite order with rich Markdown transcripts.
- Handle permissions and questions, queue messages, and use agents, skills and models.
- Preview and edit local wiki pages and plans.
- Review Git diffs, stage changes, commit and push.
- Notifications and support for signed app updates.

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

Those columns count only the Copilot processes on each side, which is the part that
grows with the number of sessions. The app also pays a fixed cost for its own window
that the plain CLI does not: about 509 MB working set / 518 MB commit across a Tauri
shell and six WebView2 processes. That figure is flat. It is the same whether the
sidebar lists two sessions or two hundred, and it is why the app is only worth running
past roughly three concurrent sessions.

A whole-tree measurement of both sides running side by side, with ten plain-CLI
sessions open for comparison. These were started from an installed binary rather than
through `npx`, so there is one resident process per session instead of the three-process
chain above:

| | Plain CLI, 10 sessions | This app, everything included |
|---|---|---|
| Processes | 11 | 9 |
| Working set | 3,276 MB | 733 MB |
| Commit charge | 10,800 MB | 918 MB |

The app column there was measured against a development build, whose renderer still
holds unminified modules and sourcemaps, so a packaged build should come in under it.

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

Tauri reuses the system WebView2/WebKit instead of bundling Chromium, which keeps the
binary small: the release executable is 6.5 MB, against the ~150 MB an equivalent
Electron bundle would ship. That is a download-size win, not a memory one. The web
engine still has to run, and its cost is the fixed UI figure in the table above.

The sidecar is Node rather than Rust because the SDK is TypeScript and ships
alongside the installed CLI, keeping SDK and CLI versions in lockstep.

## Requirements

To run the app, you'll need:

- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), installed and signed in
- Node.js 24+
- The system Microsoft Edge WebView2 Runtime on Windows

For source builds, you'll also need Rust and the platform-specific [Tauri v2 build prerequisites](https://tauri.app/start/prerequisites/).
You don't need Rust or the build toolchain to run an installed build.
Windows is the only validated installer and testing platform.
macOS and Linux haven't been manually validated.

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

#### Checking that a test would fail

Passing tests prove the code runs, not that anything asserts it is right. `scripts/mutate.ps1`
answers the second question: it swaps a snippet into a source file, reruns a chosen test
file, and reports whether the suite noticed. A mutation reported as `ALIVE` is a line the
tests execute but nothing checks.

```powershell
.\scripts\mutate.ps1 -Source src\lib\timeline.ts `
                     -Tests src/lib/timeline.test.ts `
                     -Mutations scripts\mutations.example.json
```

The mutation list is per change rather than permanent: write one while the code is fresh,
close the gaps it finds, then throw it away. `mutations.example.json` is kept as a worked
example of the format, not as a suite to run.

#### Probes

`scripts/probe-*.mjs` ask the real runtime what it does, rather than trusting the SDK's
typings. Each creates a throwaway session in a temp directory and prints what came back, so
none of them touch a real session. They exist because several of this project's assumptions
turned out to be wrong when checked: `assistant.intent`, for one, is declared by the SDK but
never actually emitted, and `probe-intent.mjs` is what established that.

Environment overrides, mostly for testing:

| Variable | Purpose |
|---|---|
| `COPILOT_HOME` | Point at a different `.copilot` directory |
| `COPILOT_CLI_PATH` | Use a specific CLI executable |
| `COPILOT_DESKTOP_NODE` | Node binary used to launch the sidecar |
| `COPILOT_DESKTOP_SIDECAR` | Path to the built sidecar entrypoint |
| `COPILOT_DESKTOP_DEV_PORT` | Enable the dev channel described below (development builds only) |

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

The channel binds to `127.0.0.1` only and never listens unless the variable is set. It
exists only in a development tree: `scripts/bundle-sidecar.mjs` leaves the module out of a
packaged app, so an installed copy has no socket code in it at all and logs that it has none
if the variable is set anyway.

`scripts/Capture-Window.ps1` captures the window to a PNG for visual checks. It reads
the window's own buffer with `PrintWindow`, so it never captures anything else on the
desktop and does not need focus. It also marks itself DPI aware, without which a scaled
display reports virtualised window coordinates and the capture comes out cropped.

```powershell
./scripts/Capture-Window.ps1 -Out shot.png
```

## Roadmap

I'm prioritising release validation and easier setup, with no delivery schedule.
Sessions must stay lazy to keep resource use low, and missing events or content must be recoverable.
Stable `v0.1.0` is published, with verified Windows `NSIS`/`MSI` packages and version-bound updater signatures.
The full installed update trial isn't complete yet - it covers the `0.1.0` -> `0.1.1` update, prereleases and rollback, including automatic/manual checks and downloads, immediate/next-launch installation, data preservation and recovery ([#121](https://github.com/NikkelM/copilot-cli-desktop/issues/121)).
[First-run setup](https://github.com/NikkelM/copilot-cli-desktop/issues/120) should detect missing `Node.js 24+` or Copilot CLI, explain sign-in and offer installation or updates with your approval.

Next are [terminal handover](https://github.com/NikkelM/copilot-cli-desktop/issues/88) without competing session owners, plus editor workspace and open-file context.
Plugin management needs install/update/remove and marketplace controls, with clear trust and scope before running third-party code.
Skills need installation and removal with clear project/user scope and source information.
Wiki settings should let you change the path without silently moving data.
Optional conversational setup should launch a session using an editable starter prompt.

Further out, [cross-machine sync](https://github.com/NikkelM/copilot-cli-desktop/issues/98) needs decisions on integrity, conflicts, privacy and session lifecycle.
Dictation and read-aloud remain exploratory - existing OS functionality and transcription/hosting tradeoffs need assessing, with no commitment to a bundled speech model.
Tell me which workflows you'd find useful in the [issue tracker](https://github.com/NikkelM/copilot-cli-desktop/issues).

## The wiki browser

If a folder exists at `~/.copilot/wiki`, the sidebar's **Wiki** button browses it as a
knowledge base: the notes worth keeping between sessions, read where the work is rather
than in another window. `/wiki` opens it too. Set `COPILOT_WIKI_DIR` to read from somewhere
else - a folder already synced, or already open in an editor, is a better answer than a
second copy under this app's directory.

Nothing about the layout is prescribed. Sub-folders become the tree, so whatever structure
you already keep is the structure you get.

| What | Behaviour |
|---|---|
| Entry page | `index.md`, `Home.md` or `README.md`, else the first page found |
| Frontmatter | Optional. `title` and `summary` are shown beside the page; without them a page is named after its file |
| Links | `[[wikilinks]]` and ordinary markdown links are both followed in-app |
| `_manifest.json` | Optional. Supplies titles and summaries when present; the filesystem always decides what exists |
| Ignored | `.obsidian`, `.git`, `assets`, `_templates` |

**Raw** shows a page as the file it is, and that view is editable; **Preview** switches
back. Preview renders unsaved edits too, so a page can be written, looked at, and saved
without leaving the browser - Ctrl+S saves from either view. The file is handed to the
editor and back whole, so saving never reformats anything it was not asked to touch, and
edits left unsaved survive walking to another page: the tree marks which pages are waiting.

Only pages that already exist can be written. Containment is judged by resolving the real
path, which a file that does not exist has none of, so creating pages needs a rule of its
own rather than falling out of that one. The same resolution is why a page cannot be read
or written from outside the wiki even when the root is a symlink.

Search ranks with the same weights as the wiki's own `Search-Wiki.ps1`, so a question asked
here and in a terminal answers the same way.

Nothing needs to be installed or generated for it. If the wiki has a `_manifest.json`, that
is what gets searched - the index is curated, leaving out README files, artifacts and
date-stamped output, and ranking should respect what its owner decided is worth finding. A
page written since that index was last built is therefore browsable but not findable, exactly
as from the terminal. Where there is no index, the pages themselves are searched and ranked
on what their own frontmatter declares, with headings read from the text.

Page titles work the same way: the index if there is one, then the page's own `title`, then
its first heading, then the filename. So notes kept as plain markdown with no frontmatter at
all still read as pages rather than as filenames.

With no wiki on the machine, the button explains what one is and offers to create it - a
folder and a first page, which is then editable in place.

## Session plans

When the selected session has a root `plan.md`, a recovered local draft, or a read/watch error, the **Plan** button appears beside Todos.
The panel renders Markdown and provides Edit, Preview, and Source views, plus Save and `Ctrl+S`.
Plan and wiki notes share the resizable right-hand column, so opening either view replaces the other.
Your plan and wiki drafts are kept when you switch views.

The app reads and writes the plan on disk without loading the CLI, and watches the selected session directory without polling.
Drafts stay in the app's sessions store when you close the panel, switch sessions, or restart the app.
Before saving, the app checks the disk content revision with SHA256 and rejects the save if the plan changed or was deleted; you can copy the preserved draft, or discard it after confirming.
Reload is available, and the panel only saves existing plans - it has no create or delete controls.

A successful manual save in the Plan panel automatically asks the agent to reread the plan, adapt its remaining work and preserve your edits.
The session resumes automatically if needed.
For safely located narrow edits, the sidecar appends compact heading paths and saved-revision line ranges, with limits of 6 diff hunks and 320 hint characters.
The prompt never includes the plan body.
Broad changes, renamed or deleted headings, and oversized or ambiguous documents use a whole-plan fallback.
If saving fails, no notification is sent; if sending fails, your file stays saved and a pending notice offers **Retry notification**.
Reading, typing, previews, reloads and agent file writes don't notify, avoiding feedback loops.
The existing file-conflict check still applies.

## Ordering active sessions

Reorder loaded or loading sessions in the `In memory` group by dragging the handle on the left and dropping before or after another active session.
You can also focus an active row and press `Alt+Up` or `Alt+Down`.
A newly activated session with no saved position is added at the top.
The saved order for a session persists across restarts, but expires after seven consecutive days without the session being loaded.
A loading active favourite stays in `In memory`, while inactive favourites remain in their own group.
Cold sessions keep their last-used order.
You can also reorder sessions in Favourites independently with the drag handle or Alt+Up/Down, and the order is saved.
Active favourites stay in In memory with their own order, then return to their saved position in Favourites when inactive.
Unfavouriting a session immediately removes its saved position; favouriting it again adds it to the end of the favourites list.

## Opening working directories

Use the **Open in {configured application}** button in the session header to open the working directory.
Choose an application in Settings > Interface; your choice is remembered globally and used by Open working directory in the session context menu.
The session view has no application dropdown or separate choice, and GitHub is unchanged.

In Settings > Interface, choose a default application, add one by selecting an executable in the native file picker, edit its name and arguments, or remove an entry.
Only installed or detected applications appear in the list.
Enter custom application arguments in the single-line field, using double quotes to keep arguments with spaces together; Windows-style backslash-before-quote handling is supported, and Save is disabled while a quote is unclosed.
`{cwd}` is replaced after parsing, so a folder path with spaces stays one argument; arguments are passed without shell execution or variable expansion.
Windows `.cmd` and `.bat` wrappers aren't launched; use the actual `.exe`.

If a saved application can't be found, you'll see an explicit failure rather than a silent fallback.
The Windows implementation has been tested; Linux and macOS discovery paths haven't been manually validated.

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
[#19](https://github.com/NikkelM/copilot-cli-desktop/issues/19)). Press `?` for the list,
and change any of them under Settings > Shortcuts
([#246](https://github.com/NikkelM/copilot-cli-desktop/issues/246)).

## Notes

You'll find startup and sidecar logs at `%LOCALAPPDATA%\com.nikkelm.copilot-cli-desktop\logs\copilot-cli-desktop.log`, including native panic details captured after startup logging is initialised.

Reads the CLI's own state directory, so existing instructions, agents, skills and
hooks apply unchanged. Session data is only ever read; the CLI remains the owner.

Not affiliated with GitHub. GitHub also ships an official
[Copilot app](https://docs.github.com/copilot/concepts/agents/github-copilot-app),
which is repository-centric; this project targets lightweight session management
across arbitrary folders, including ones that are not git repositories.

## Updates

Open `Settings > Updates` to check for updates.
The app checks automatically at startup, and automatic downloads are enabled by default; you can disable them through saved settings.
A manual `Check for updates` downloads a new update even when automatic downloads are off, and `Download update` is also offered for a discovered candidate.

A ready download opens a nonmodal prompt with `Install and restart` or `Later`; Settings also has an install button.
Installed Windows builds cache the signed package and install it on the next launch before the Node sidecar starts.
Development builds can check and download into a separate `updates-dev` cache, but can't install themselves.

Installation is blocked while sessions, subagents, loading, questions, queues, unsent or stashed messages, attachments, unsaved wiki edits or saves are present.
Save or discard settings changes before using the Settings install button.
Persisted app stores are flushed before installation; on failure, the runtime is unlocked and errors remain visible.

`Include prerelease updates` is off by default, so update checks only consider stable releases.
To try beta builds, enable it in `Settings > Updates` and save your settings.
The app then selects the highest eligible version across stable and prerelease releases, with prereleases clearly labelled.

If you're running a prerelease, turning the option off or choosing `Return to latest stable` offers a confirmation when a published stable release is available.
Confirmation turns prerelease updates off and downloads stable, even at a lower version; installation still waits for your choice or the next launch, with the usual safeguards and version-bound signature verification.
Normal updates don't allow arbitrary downgrades.
Opting out blocks cached prereleases from installing; opting back in cancels a pending return to stable.
Returning to stable changes the app binaries - it won't restore older copies of your files, and prerelease app data may be incompatible with stable.

Each update downloads the full compressed NSIS/MSI installer, without delta patches or a separate uncompressed 120 MB SDK download.
Existing installations without updater support need one manual updater-enabled NSIS install before future in-app updates can work.
Update checks discover releases through the public GitHub Releases API, excluding drafts and releases without `latest.json` updater metadata, then fetch the selected immutable version's `latest.json`.
Older stable clients continue to use `https://github.com/NikkelM/copilot-cli-desktop/releases/latest/download/latest.json`.

## Releases

Run the `Release` workflow manually through `workflow_dispatch` with a plain `X.Y.Z` version.
It defaults to `dry-run=true`, validates the version and that the new tag doesn't already exist, then stamps the npm, package-lock, Tauri and Cargo versions.
It builds installers, detached signatures and `latest.json`, and runs an explicit native integration test to verify the actual installers against the public key and signed app version.
Workflow artifacts are uploaded even on dry runs, which publish nothing.

Review the release notes in `CHANGELOG.md` between the `Releasenotes` markers before starting a non-dry run.
After the build, tests, updater signing and artifact verification succeed, a non-dry run creates and pushes the CI bot's version commit and tag, then automatically publishes the GitHub release.
Dry runs publish nothing and only upload workflow artifacts.

Enable the prerelease option with a base version such as `0.1.1` to generate `0.1.1-beta.N`, using the `Release` workflow's `GITHUB_RUN_NUMBER` for `N`; project versions and updater metadata are stamped automatically.
Use a new workflow run for each beta while keeping the same base - new runs get increasing numbers, with possible gaps after dry runs or stable runs.
Rerunning an existing run keeps its number, and existing tags are rejected; versions, tags and installers are immutable, so don't retag or replace published assets.
A successful non-dry prerelease run automatically publishes the beta with `--prerelease --latest=false`, making it discoverable by opted-in apps while keeping the stable Latest release unchanged.
Under [SemVer](https://semver.org/), `0.1.1` sorts above `0.1.1-beta.N`, and `+build` metadata doesn't advance update order.
For MSI packaging only, betas map to numeric `X.Y.Z.N` (`N` in `1..65534`) and stable builds to `X.Y.Z.65535`; the signed and displayed app version remains the resolved SemVer.

The updater keypair was generated outside the repository, with the private key and password stored in the repository's Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
Only the public key goes in `tauri.conf.json`.
Securely back up the original private key and password - losing them breaks signing continuity for existing installations.

> [!NOTE]
> Automatic updates require a public GitHub repository with published updater-signed installers and `latest.json`.
> Keep the private signing key outside the repository and configure the release signing secrets.
> You'll need to manually install an updater-enabled build once to bootstrap updates, then validate an update end to end against a published release.

### On signing

Updater signatures are free and separate from Windows Authenticode code signing.
There's no Windows code-signing certificate, so the first downloaded installer still triggers a Windows warning.

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
- [SignPath Foundation](https://signpath.org/apply.html) is a candidate to evaluate for CI code signing now that this GPL-3.0 repository is public.
  Eligibility and approval aren't guaranteed.

## Licence

Copyright (C) 2026 Nikkel Mollenhauer

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.
See [LICENSE](LICENSE).

Every dependency is permissively licensed - MIT, ISC, BSD, Apache-2.0 or MPL-2.0 -
so nothing here conflicts with that choice. Note that Apache-2.0 is compatible with
GPL version 3 but not version 2, which is one reason this is v3.
