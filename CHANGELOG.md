# Changelog

## Unreleased

- The app asks before it installs and starts its two background processes (the runner and the harness service), in a native dialog that says what they do. Until then nothing is installed, and no agent or outside supervisor can start them.
- **Background** in the Live view (the footer line) shows both processes, since when they run and their LaunchAgent files, with **Stop everything** (ends every session and both processes; nothing restarts them until you allow it) and **Remove background items** (also deletes the LaunchAgent files).
- Quit from the menu or with Cmd-Q says how many sessions keep running, and offers **Quit and Stop Them**. Quitting from the Dock does not ask.
- `agent-mcr --stop-background [--uninstall]` does the same from a terminal, without the app.

## Agent MCR 0.1.1 (2026-11-17)

- A session pointer (copied, or dragged into a terminal) is `mcr:<id> '<name>'`: the name is in single quotes and loses quotes, `$`, backticks, backslashes and control characters, so a name set by an agent cannot run a command when the pointer lands in a shell.
- A session name chosen by the Supervisor and the text of bulletin notes lose control characters.

## Agent MCR 0.1.0 (2026-11-17)

- Agent MCR has its own identity: app name, bundle id `cc.lambdahouse.agent-mcr`, binary `agent-mcr` and config folder `agent-mcr`.
- Opens on Sessions. It doesn't register as the handler for Markdown files and doesn't offer updates. Builds are published as GitHub pre-releases, not signed with a Developer ID and not notarized.
- macOS only.
