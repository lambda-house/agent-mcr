# Agent MCR

**Agent Mission Control Room.** A local harness for a group of coding agents on a Mac.

- **Sessions.** The Claude Code and Codex sessions on this machine: active and inactive, who started whom, models, tokens, tool calls, and ticket mentions.
- **Live.** Claude Code, Codex and shell terminals running inside the app. They keep running when the app quits. Each shows what it is doing (working, idle, waiting for you), and the ones waiting for you are listed on top and raise a macOS notification. An earlier Claude or Codex session can be resumed here.
- **Supervisor.** An outside agent creates and resumes sessions, gives them tasks and follows the results through an MCP server (below). It cannot answer permission prompts: those are yours.
- **Planned.** A dependency graph, tools agents use to talk to each other, a git worktree per session, and infrastructure tools through a local [agentgateway](https://agentgateway.dev).

The architecture and its decisions are in [docs/AGENT_HARNESS_DESIGN.md](docs/AGENT_HARNESS_DESIGN.md).

Agent MCR is built on [MDViewer](https://github.com/lambda-house/mdviewer-mj) and still contains its Markdown viewer (**Documents**). MDViewer's own README is kept at [docs/MDVIEWER.md](docs/MDVIEWER.md). Viewer fixes are merged from the `upstream` remote.

## Status

Pre-release (0.1.0): macOS only, no published builds and no updates. It runs alongside an installed MDViewer without sharing settings, data or file associations.

## Build and run

Needs Node.js, Rust and the Xcode command-line tools.

```bash
npm ci
npm run tauri dev        # development
npm run build:app        # src-tauri/target/release/bundle/macos/Agent MCR.app
npm test                 # frontend tests
cd src-tauri && cargo test
```

The app opens on **Sessions**. Reading transcripts is switched on in the app, after a native confirmation.

## Supervising from an outside agent

Give one Claude Code session outside the app the supervisor tools (the **Supervisor** button in the Live view copies this command with the right path):

```bash
claude mcp add --scope user agent-mcr-supervisor -- '/path/to/Agent MCR.app/Contents/MacOS/agent-mcr' --supervise
```

It then has `session_create` (with `resume` for an earlier session), `session_resumable`, `session_list`, `task_assign`, `task_wait`, `terminal_read`, `attention_list` and the rest. The app doesn't have to be open: the tools start the harness service themselves.

To move a session you run in another terminal into the harness, close it there, then resume it from the Live view or with `session_create(resume: <id>)`.

## Where data lives

`~/Library/Application Support/agent-mcr/` holds:

- `access.json`: what you've allowed
- `sessions/index.sqlite`: the transcript index, which contains private transcript content
- `history/` and `read-state/`: inherited from the viewer
- `analysis/mcp.sock`: the analysis MCP socket, while it's switched on
- `runner.sock`, `harness.sock` and their logs: the two background units that host terminals and track sessions
- `harness-state.json`: session states and tasks; `claude-hooks.json`: the hooks passed to hosted Claude sessions

Browser-side settings are stored per app, separate from MDViewer's.

## Analysis MCP

A local agent can query the session index read-only. See [docs/SESSION_ANALYSIS_MCP.md](docs/SESSION_ANALYSIS_MCP.md).
