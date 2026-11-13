# Agent MCR

**Agent Mission Control Room.** A local harness for a group of coding agents on a Mac.

- **Sessions.** The Claude Code and Codex sessions on this machine: active and inactive, who started whom, models, tokens, tool calls, and ticket mentions.
- **Planned.** The agents' terminals running inside the app and surviving app restarts, a dependency graph, an attention list for everything that waits on you, tools agents use to talk to each other, a supervisor surface for an external agent, and infrastructure tools through a local [agentgateway](https://agentgateway.dev).

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

## Where data lives

`~/Library/Application Support/agent-mcr/` holds:

- `access.json`: what you've allowed
- `sessions/index.sqlite`: the transcript index, which contains private transcript content
- `history/` and `read-state/`: inherited from the viewer
- `analysis/mcp.sock`: the analysis MCP socket, while it's switched on

Browser-side settings are stored per app, separate from MDViewer's.

## Analysis MCP

A local agent can query the session index read-only. See [docs/SESSION_ANALYSIS_MCP.md](docs/SESSION_ANALYSIS_MCP.md).
