# Agent MCR

**Agent Mission Control Room.** A local harness for a group of coding agents on macOS or Windows.

- **Sessions.** The Claude Code and Codex sessions on this machine: active and inactive, who started whom, models, tokens, tool calls, and ticket mentions.
- **Live.** Claude Code, Codex and shell terminals running inside the app. They keep running when the app quits. Each shows what it is doing (working, idle, waiting for you), and the ones waiting for you are listed on top and raise a macOS notification. An earlier Claude or Codex session can be resumed here.
- **Supervisor.** A Supervisor session in the app, or an outside agent you allowed, creates and resumes sessions, gives them tasks and follows the results through an MCP server (below). It cannot answer permission prompts: those are yours.
- **Between sessions.** Every hosted agent gets the `mcr` tools: see its peers and their roles, message them, report to you that it needs you or that a piece of work is done, and leave notes for later sessions on a bulletin board.
- **Documents.** The agents' own Markdown (instructions, rules, memory, plans, skills) by the folder their sessions work in, with what changed since you last read it.
- **Planned.** A dependency graph, a git worktree per session, and memory shared between agents.

How it is built: [ARCHITECTURE.md](ARCHITECTURE.md). The design it grows towards and its decisions: [docs/AGENT_HARNESS_DESIGN.md](docs/AGENT_HARNESS_DESIGN.md).

## Status

Pre-release (0.1.0): no published builds. Windows support still needs validation on a real Windows machine. The app does not update itself.

## Build and run

Needs Node.js, Rust and read access to the private `teob-cc/teob-ui` repository on GitHub: `@teob/ui` is installed from it over HTTPS, pinned to a commit (signing in with `gh auth login` is enough).

On macOS, install the Xcode command-line tools:

```bash
npm ci
npm run tauri dev        # development
npm run build:app        # src-tauri/target/release/bundle/macos/Agent MCR.app
npm test                 # frontend tests
cd src-tauri && cargo test
```

On Windows 10 1903+ or Windows 11 (x86_64), install the Microsoft C++ build tools, Rust's MSVC toolchain and WebView2 Runtime. In PowerShell, from the repository root:

```powershell
npm ci
npm run tauri dev
npm run build:win       # per-user NSIS installer under src-tauri/target/release/bundle/nsis
npm test
cd src-tauri
cargo test
```

The Windows installer is unsigned; SmartScreen may warn. Its WebView2 bootstrapper downloads the runtime when needed. CI also needs the `TEOB_UI_SSH_KEY` repository secret to install the private dependency.

The app opens on **Sessions**. Reading transcripts is switched on in the app, after a native confirmation.

## Supervising from an outside agent

Give one Claude Code session outside the app the supervisor tools (the **Supervisor** button in the Live view copies this command with the right path):

```bash
claude mcp add --scope user agent-mcr-supervisor -- '/path/to/Agent MCR.app/Contents/MacOS/agent-mcr' --supervise
```

Then tick **outside agents** at the bottom of the Live view and confirm the dialog. Without it, only the Supervisor session inside the app has these tools.

It then has `session_create` (with `resume` for an earlier session), `session_resumable`, `session_list`, `task_assign`, `task_wait`, `terminal_read`, `attention_list` and the rest. The app doesn't have to be open: the tools start the harness service themselves.

To move a session you run in another terminal into the harness, close it there, then resume it from the Live view or with `session_create(resume: <id>)`.

## What is protected, and what is not

Every agent runs as your OS user. The harness limits what an agent can do through the harness; it can't wall one of your programs off from another.

- Terminals (`runner.sock`) take requests only from Agent MCR itself: the app and its harness service. Any other program, and anything started inside a hosted session, is refused. So is every other user.
- Starting, restarting and listing sessions (`harness.sock`) is the app's. A hosted session has the `mcr` tools and nothing else. A hook report counts for the session its process runs in, whatever it claims.
- The supervisor tools belong to the Supervisor session. Agents outside the app get them only while **outside agents** is ticked. A program that a hosted agent starts and detaches from its session looks like an outside one, so leave the box off while agents work in folders you don't trust.
- The Supervisor asks you before it types into a terminal (`terminal_write`), and it can't give a shell a task: both would run a command nobody approved. For the same reason a task can't start with `!`, `#` or `/`.
- These checks stop a plain command from reaching the sockets. They don't stop a program written to get around them, because it runs as you. A shell command you approve in one agent can still do whatever you can, including to other sessions.
- On macOS the two LaunchAgents (`~/Library/LaunchAgents/cc.lambdahouse.agent-mcr.runner.plist` and `.harness.plist`) do not start at login and remain after deleting the app. Remove them by hand. On Windows, the app starts detached background processes instead.
- A link inside an opened folder that points out of it is followed only to Markdown files and images.

## Where data lives

The config directory is `~/Library/Application Support/agent-mcr/` on macOS and `%LOCALAPPDATA%\agent-mcr\` on Windows. It holds:

- `access.json`: what you've allowed
- `sessions/index.sqlite`: the transcript index, which contains private transcript content
- `read-state/`: the "changed since you read it" copies of agent documents
- `analysis/mcp.sock`: the analysis MCP socket, while it's switched on
- `runner.sock`, `harness.sock` and their logs: the two background units that host terminals and track sessions
- `harness-state.json`: session states and tasks; `claude-hooks.json`: the hooks passed to hosted Claude sessions

Browser-side settings are stored per app.

## Analysis MCP

A local agent can query the session index read-only. See [docs/SESSION_ANALYSIS_MCP.md](docs/SESSION_ANALYSIS_MCP.md).
