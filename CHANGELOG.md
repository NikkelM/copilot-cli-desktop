# Changelog

## Unreleased

<!--Releasenotes start-->
Copilot CLI Desktop remains in development; this beta focuses on update discovery and installation on Windows.

### Release notes

- `Settings > Updates` now has independent `Installed release notes` and `Available release notes` controls.
  Each expanded block begins with `Version X.Y.Z`, with more space below its button.
- `Installed release notes` is shown only when GitHub release discovery finds an exact published release matching the running version after validating draft status, prerelease flags, `latest.json`, version metadata, and the expected repository URL.
  Empty or unpublished notes aren't shown.

### Update checks and downloads

- `Check for updates` now only discovers and displays an update for the channel currently shown in `Settings > Updates`, and never downloads it.
  Use `Download update` for an explicit manual download, even when automatic downloads are enabled.
- Saved automatic downloads continue to apply to startup checks.
  Manual downloads remain in `Settings > Updates` and don't open the startup modal.

### Install and restart

- The modal `Install and restart` confirmation now uses normal accent styling rather than destructive red.
- Intentional sidecar shutdown during updater exit no longer flashes a red stopped-runtime error, while unexpected sidecar failures remain visible.

### Windows installation

- Current-user NSIS updates run silently, without an installer or progress window.
- Per-machine MSI updates use passive mode so Windows can request UAC and show progress.
  Standalone installers keep their normal behaviour.
<!--Releasenotes end-->

## v0.1.1

### Added

- Added the `Open logs folder` action under a new `Debug` subsection in `Settings > Updates`; it remains searchable using diagnostics terms.

### Changed

- Changing `Include prerelease updates` now checks the displayed channel immediately, whether you turn it on or off, without saving first.
  Manual `Check for updates` and `Download update` use that displayed state, while `Save` controls whether the choice persists and whether prerelease installation remains allowed after you leave Settings or restart.
  Rapid changes only queue the newest requested channel, and saving a channel that was already checked doesn't repeat the check.
- Updates downloaded automatically during startup now open a modal with `Install and restart` or `Later`.
  Manual checks and downloads stay in Settings and don't open this prompt, while installer failures remain visible.
- Increased the size of the main update action buttons, set 12px gaps between them and added more space before the next-launch note.
- Beta numbering now increments independently per base release version using remote beta tags, replacing the `Release` workflow's `GITHUB_RUN_NUMBER`.

## v0.1.0

The first release worth installing.

### What it does

- **Browsing costs nothing.** Every session the Copilot CLI has ever created is listed from
  its own history database, with no Copilot process running. A session is only loaded when a
  message is actually sent to it, so a week-old session you never open never costs memory.
- **Sessions sleep on their own.** One left untouched for ten minutes is disconnected and its
  memory reclaimed. There is no cap on how many may be loaded at once.
- **The transcript**, with markdown, syntax highlighting, mermaid diagrams, tool calls that
  can be expanded, and copy buttons for a whole reply or a single code block.
- **Send, queue and interrupt.** Messages sent during a turn are queued rather than refused,
  and a turn can be stopped with Esc Esc or Ctrl+C.
- **Permissions and questions** from the agent are answered in the app, with an allow-all
  switch per session.
- **The model, its reasoning effort and its context size** are chosen per session, with token
  budgets and prices shown from the catalogue.
- **Attachments** picked from a file dialog.
- **The working directory** opens in a file manager, a new VS Code window, or on GitHub -
  the last only when the checkout actually has a GitHub remote.

### Why it exists

The plain CLI with eight sessions open, only two of them working, measured on Windows:

| | Plain CLI, 8 sessions | This app, idle | This app, 3 sessions loaded |
|---|---|---|---|
| Processes | 22 | 1 | 1 |
| Working set | 1,123 MB | 206 MB | 865 MB |
| Commit charge | 13,247 MB | 250 MB | 1,011 MB |

### Before installing

Needs [Node.js](https://nodejs.org) 24 or newer and the
[GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), signed in. The
installer is unsigned, so Windows will warn the first time it runs.
