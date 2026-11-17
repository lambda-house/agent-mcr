# Changelog

## Agent MCR 0.1.1 (2026-11-17)

- A session pointer (copied, or dragged into a terminal) is `mcr:<id> '<name>'`: the name is in single quotes and loses quotes, `$`, backticks, backslashes and control characters, so a name set by an agent cannot run a command when the pointer lands in a shell.
- A session name chosen by the Supervisor and the text of bulletin notes lose control characters.

## Agent MCR 0.1.0 (2026-11-17)

- Agent MCR has its own identity: app name, bundle id `cc.lambdahouse.agent-mcr`, binary `agent-mcr` and config folder `agent-mcr`.
- Opens on Sessions. It doesn't register as the handler for Markdown files and doesn't offer updates. Builds are published as GitHub pre-releases, not signed with a Developer ID and not notarized.
- macOS only.
