# Changelog

## Unreleased

<!--Releasenotes start-->
### Added

- Added an 'Open logs folder' button in Settings > Updates so you can access the app's logs for troubleshooting.

### Changed

- Beta numbering now increments independently per base release version using remote beta tags, replacing the `Release` workflow's `GITHUB_RUN_NUMBER`.
<!--Releasenotes end-->

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
