# Local agent harness: architecture

**Status:** design, revision 5 (2026-11-13); built so far: see "What is built" below. Decisions D1–D12, D14 and D15 are signed (below). Home: `lambda-house/agent-mcr` (Agent Mission Control Room), a private repository carrying mdviewer-mj's history; viewer fixes merge from `upstream` (`lambda-house/mdviewer-mj`). Derived with the Outside-In method: every mechanism cites the requirement it serves (traceability map at the end).

**Goal.** MDViewer becomes the local harness for a group of coding agents. It runs their terminals and connects them to each other, to infrastructure tools (Atlassian now, TEOB memory later) and to two kinds of supervisor: the human operator in the app, and an external agent that creates sessions and assigns them tasks. It must not depend on any one agent.

## Decisions

| | Decision | Signed |
|---|---|---|
| D1 | Agents survive quitting or updating the app. The part that runs agents is separate from the view and controls | 2026-11-13 |
| D2 | Asynchronous work between agents and supervisors uses MCP's async mechanism: the Tasks extension of revision 2026-07-28 | 2026-11-13 |
| D3 | Atlassian, TEOB memory and other infrastructure tools are MCP servers behind a local gateway (agentgateway). Every hosted agent gets all of them | 2026-11-13 |
| D4 | macOS only for now | 2026-11-13 |
| D5 | A local supervisor gets root access: every internal of the harness, with no separate grant or limits. It's all local | 2026-11-13 |
| D5a | Amends D5 after the security review of 2026-11-15. Root stays, with three limits: an outside agent has the supervisor tools only while the operator's "outside agents" setting is on (default off, native confirmation); `terminal_write` is not pre-approved for the hosted Supervisor, so the operator is asked each time; tasks are refused for shell sessions. The runner takes requests only from this program outside any hosted session, the service's control requests likewise, and a hook is attributed by its process, not by the id it sends | 2026-11-15 |
| D3a | Revision for 1.0 (MCR-24, 2026-11-15): the gateway of D3 and its prerequisite D11 are not built and are not part of 1.0. The app holds no third-party credentials: the Connections dialog (Jira, TEOB memory) is removed, ticket keys found in transcripts are shown as text. Memory and infrastructure tools come back as a later layer (MCR-3) | 2026-11-15 |
| D6 | Only the human answers permission prompts. A session waiting on the human must be clearly visible, never quietly stalled | 2026-11-13 |
| D7 | Launch profiles carry the agent's own permission mode (Claude `acceptEdits`, Codex `workspace-write` with `on-request` approvals), so prompts are limited to shell commands and network | 2026-11-13 |
| D8 | `session_create` takes `worktree: true`. That's the default when another live session already uses the same repository. It creates `../<repo>-<session>` on a new branch, and the graph shows the branch. Removing a worktree is a human or supervisor action, never automatic | 2026-11-13 |
| D9 | Sessions belong to named groups (for example a supervisor's task force). `list_peers` and messaging cover the group by default, and the whole machine only with a flag. The graph collapses by group | 2026-11-13 |
| D10 | The harness is built in a separate repository: `lambda-house/agent-mcr` (private), with mdviewer-mj's history and mdviewer-mj as `upstream`. MDViewer itself stays a Markdown viewer | 2026-11-13 |
| D11 | agentgateway is a prerequisite installed with Homebrew, found on `PATH` or configured, with a version check | 2026-11-13 |
| D12 | Local builds are the gate: `npm run build`, `npm test`, `cargo clippy --all-targets` and `cargo test` on the Mac. GitHub CI stays Linux-only and checks what compiles there; macOS-only modules are behind `cfg(target_os = "macos")` | 2026-11-13 |
| D14 | Slack is connected natively by the harness service (MCR-26). It ships in 1.0 as a preview (owner, 2026-11-17, with executors and memory; MCR-25): off until connected, and marked Preview in the app. Amends D3a for Slack only: the Slack bot token and app-level token are held on this Mac, in the macOS Keychain. Posts go out as a bot, never as the user. A post that its channel's policy does not allow automatically is approved by the operator only (D6 extended), in the app or in a Slack direct message from the bot. A message from the operator's own Slack account is the operator's request to the session that receives it; messages from other listed senders are data. D13 is reserved for the store-app decision of MCR-16 | 2026-11-17 |
| D15 | Sessions form supervisor/executor trees (MCR-41). Any agent session can have executors: the operator creates one or connects an existing session in the app, and a hosted agent can create its own with `executor_create`. A supervising session gets the task tools (`task_assign`, `task_wait`, `task_status`, `session_status`, `session_result`, `terminal_read`) for its executors and theirs, and for nobody else; it never types into a terminal and never answers a permission prompt (D6). An executor's reports reach its supervisor as well as the operator. An agent starts executors only in its own folder or below it; anywhere else is the operator's action. The tree is bounded (5 levels, 12 executors per session). A supervisor that ends leaves its executors independent, and nothing attaches them again by itself. This widens D5a: creating sessions is no longer limited to the supervisor surface. The root Supervisor stays as it is. A session registers what it waits for outside itself (`wait_register`); a wait that runs past its time goes to the session's supervisor, or the root Supervisor, and after as long again to the operator (a mark on the session and a notification; when the session already waits on the operator for something else, the notification alone). What the session wrote about its wait is passed on quoted, as its words. A wait is at least five minutes, and one session's waits wake somebody at most four times an hour. A supervising session may end an idle executor it started itself (`executor_end`, MCR-46). Executors have no switch: they are always available and marked Preview in 1.0. D9 (groups) is not built; a supervisor's tree is the group for these tools | 2026-11-17 |

### What is built (revision 5)

Milestone: every current agent session can run in the harness, with one supervisor outside.

| Part | State |
|---|---|
| Runner, Live view, terminals, launch profiles, image paste | Built |
| Harness service (`--harness`, LaunchAgent): session registry, state, tasks, attention | Built |
| Session state from Claude hooks and Codex `notify`, passed per launch | Built, checked live with Claude Code 2.1.323 and Codex 0.167.1 / 0.169.0 |
| Attention list in the Live view, macOS notification when a session starts waiting | Built. The notification is posted with `osascript`, so it appears under Script Editor's name, not the app's |
| Resume an earlier Claude or Codex session in the harness (Live view and `session_create(resume)`) | Built, checked live |
| Supervisor MCP (`--supervise`): sessions, tasks, terminals, attention | Built, checked live with an outside Claude Code |
| D6: the supervisor is refused input while a session waits on the human | Built, checked live |

What differs from the design for now, and why:

| Design | Now | Trigger to close the gap |
|---|---|---|
| D2: MCP 2026-07-28 with the Tasks extension | The supervisor MCP speaks the older revisions (up to 2025-11-25). `task_assign` returns at once; `task_wait` and `attention_wait` are tool calls that wait up to 10 minutes | Step 4, where `listen` needs Tasks to wake an idle agent |
| `harness.sqlite` | `harness-state.json` (session states and at most 500 tasks, rewritten atomically) | Step 4: messages need queries and receipts |
| Notifications under the app's identity | `osascript` | Icon and cosmetics pass |
| D8 worktrees, D9 groups | Not built | Step 4 |
| Finder file paste, drag and drop onto a terminal | Not built | Next step-1 leftovers |

Three findings from the live runs changed the design. None of them is reported by a hook:

- **Start-up questions.** Claude Code asks whether to trust a new folder before any hook fires. The service raises an attention item when a Claude session has printed something, gone quiet for 4 s and reported no hook 10 s after starting.
- **Other threads in a Codex terminal.** Codex calls `notify` for the turn that writes the session title and for subagents. Only the session's own thread ends its turn. The first thread seen is taken as its own unless its prompt is the title writer's.
- **Typing into the wrong prompt.** A Codex session reports nothing until its first turn ends. A task typed before that can land in a start-up question: in the test it accepted Codex's update offer. A task for such a session now waits until the terminal shows Codex's input box, and the operator is told after 15 s if it doesn't.

### What revision 3 changed

| Change | Claim that expired | Re-checked | Untouched |
|---|---|---|---|
| D5: root access | The supervisor needs a scoped grant with limits | Supervisor surface, trust, map row R15 | Identity from peer credentials (still used, for attribution) |
| D6: human approves, waiting is visible | A task may sit in `working` with only a status message | New attention processor, views, failure ladder, zero-tolerance counts, map row R16 | Task tracker, delivery |

### What revision 2 changed

| Change | Claim that expired | Re-checked | Untouched |
|---|---|---|---|
| D1 signed, and "separate running from view" | One daemon is enough | Runtime units, failure ladder, coupling | Data classes, clipboard, adapters |
| D2: MCP Tasks | A notice inside the next tool result is the main wake-up signal | Delivery, harness tools | Message store (still receipt-acknowledged) |
| D3: agentgateway | The app holds Atlassian/TEOB credentials | Connections, trust, runtime units | The Sessions view's ticket links |
| D4: macOS | Windows and Linux transports | Process identity now uses macOS kernel peer credentials | — |
| New client: super-supervisor | — | New surface, trust, ladder rows, map rows R12–R15 | Everything else |

### Facts the revision depends on (checked 2026-11-13)

- The current MCP revision is **2026-07-28** (MCP TypeScript SDK 2.0 implements it). The core protocol became stateless: no `initialize` handshake, capabilities travel in each request's `_meta`. Tasks became the extension `io.modelcontextprotocol/tasks`. A tool call may answer with a task (`working`, `input_required`, `completed`, `failed`, `cancelled`). The client polls `tasks/get` and answers input through `tasks/update`. A server may return a task only when the request declares the extension.
- **Claude Code** supports MCP Tasks in public beta from v2.1.304, in the terminal CLI (installed here: 2.1.323). When a task completes while Claude is idle, Claude starts on the result unprompted. **This is the wake-up signal.** Claude Code channels (push messages) are a research preview and don't work for servers on 2026-07-28, so they stay a recorded option.
- **Codex CLI** (installed: 0.167.1) doesn't support the Tasks extension yet (open request openai/codex#48617).
- **agentgateway** 1.4 supports 2026-07-28 and translates between spec versions. It merges local stdio and remote MCP servers into one endpoint with tool-name prefixes, validates JWTs, and filters tools with CEL policies. **Unverified:** whether it passes Tasks through, and whether it can do Atlassian's upstream OAuth on the agents' behalf.

## 01 · Outside

### Clients

| Client | What it does | Tolerances |
|---|---|---|
| **Operator** (you) | Watches, drills down, types and pastes into terminals, **is the only one who approves**, directs | Keystrokes reach the terminal with no noticeable lag. Liveness labels are never wrong (*verified*, *observed* and *inferred* stay distinct). Pasting never submits a half-typed prompt. **Every session waiting on you is visible within seconds, whether the app is open or not** |
| **Super-supervisor** (an external local agent: Claude Code or Codex in a terminal) | Creates sessions, assigns tasks, follows progress, reads results, interrupts, ends sessions | A task assignment is accepted or refused, never "maybe". Completion arrives without the supervisor having to poll by hand (Tasks) or through a status tool it polls (no Tasks). Works while the app's window is closed |
| **Hosted agent** (a CLI the harness started) | Runs in a terminal; uses harness tools and gateway tools; talks to peers | Never blocked by viewers. A message is durably accepted or refused |
| **External agent** (started elsewhere) | Writes transcripts | Visible and read-only |
| **Subagent** | Runs inside its parent's process | A node in the graph, no terminal |
| **Upstream tool servers** (Atlassian, TEOB memory, others behind the gateway) | Serve tools | Their quotas, their outages. Credentials never reach agents or the app's store |

### Views and freshness bounds

| View | Bound |
|---|---|
| Terminal output of a hosted session | Real time; scrollback survives the app quitting |
| Liveness, hosted | Exact |
| Liveness, external | ≈ 5 s, labelled *observed* |
| Session state (working / idle / waiting for approval) | 2 s with an adapter signal, otherwise *inferred* |
| Dependency graph | 2 s for harness edges |
| Task status, for the supervisor | One poll interval (Claude Code: 2 s by default, 0.25–30 s allowed) |
| **Attention queue**: sessions waiting on the human | 2 s with an adapter or terminal signal. A macOS notification when the app is closed or the session isn't on screen. Repeated while it stays unanswered |
| Inactive sessions, history, usage | Existing index |

### What a client still gets when something fails

| Failure | Operator | Supervisor | Hosted agent |
|---|---|---|---|
| App quits, crashes or updates | Reopen: terminals reattach (*correct*) | Unaffected | Unaffected |
| Harness service restarts or updates | Terminals pause, then reattach | Calls fail for seconds, then succeed. Task ids survive (*correct but slower*) | Harness tools fail for seconds; the agent keeps running |
| Runner dies | Sessions shown **ended unexpectedly**, with resume (*absent but signalled*) | Task fails with a typed reason | Agent ends |
| Gateway down | Shown in the harness panel | — | Gateway tools fail with a typed error; harness tools still work (*correct but less*) |
| Message target ended | Shown | Told the target's state | Message kept pending, sender told (*pending but signalled*) |
| Agent without an adapter | Terminal only; state **unknown** | Task completion can't be detected; `task_assign` is refused for that profile | — |

### Operating envelope

One user, one Mac. One repository (`agent-mcr`, D10), one binary. agentgateway is third-party software, accepted as an organisational choice (D3); it isn't derived here. Lifecycle: a prototype becoming your daily tool. Colleagues build from source.

## 02 · Load

Measured over the last 14 days of transcripts on this machine unless labelled *assumed*.

| Figure | Value | Provenance | Used at |
|---|---|---|---|
| Transcripts | 637 (486 Claude, 151 Codex); 350 subagent | measured | 01: subagents are nodes, not terminals |
| Most open at once | 21, of which 14 human-started (upper bound: spans include idle time) | measured | 08: about 15–20 terminals |
| Transcript volume | 105 MB/day ≈ 1.2 KB/s; largest file 88 MB | measured | 04: existing index is enough |
| Terminal output burst | ≤ 1 MB/s per session | **assumed** | 04, 08 |
| Scrollback per session | 2–5 MB | **assumed** | 08 |
| Peer messages | ≤ 1/min per session | **assumed** | 05: rate-limit defaults |
| Supervisor task assignments | ≤ 1/min | **assumed** | 05: limits |

One node suffices; the stop rule is taken.

## 03 · Data

| Data class | Source of truth | Write acknowledgement | Invariants |
|---|---|---|---|
| **Running processes and terminal state** | Runner memory | **Completion** for spawn, signal and resize | One entry per child; a child never blocks on viewers |
| **Session registry**: harness id, adapter, profile, cwd, runner id, transcript link, who created it (operator / supervisor), exit | Harness store | **Completion** | A row marked live always has a live runner child (reconciled on every service start) |
| **Tasks**: id, session, text, assigned by, status, result summary | Harness store | **Receipt** on assignment (the task id comes back); completion is reported later through Tasks | One open task per session at a time. Assigned text is delivered once |
| **Peer messages, questions, replies, declared dependencies** | Harness store | **Receipt** | Sender identity comes from kernel peer credentials, never from arguments |
| **Scrollback** | Runner memory | none (lossy) | — |
| **Transcripts and index** | Agent files / existing SQLite (derived) | n/a | Existing rules |
| **Harness grant** (turning the harness on; there is no separate supervisor grant, D5) | `access.json` | Completion | Granted only after a native dialog |
| **Attention items**: session, kind, since, signal source, answered/dismissed | Harness store (raised from state signals) | Receipt | An item closes only when the session leaves the waiting state, or when the human dismisses it. Never closed by a timeout |
| **Gateway config and upstream credentials** | agentgateway config / macOS Keychain | n/a | Never in the app's store, exports or agent environments, except each session's own short-lived gateway token |

## 04 · Runtime units, channels and technology

### Runtime units (one binary, one repository)

| Unit | What it holds | Why it's separate |
|---|---|---|
| **Runner** `mdviewer --runner` | PTYs, child processes, scrollback, exit codes. No policy, no MCP, no SQLite | D1: agents must outlive everything that changes often. Its protocol is small and changes rarely, so the service and UI can be updated while agents run. Only a runner update needs the agents stopped |
| **Harness service** `mdviewer --harness` | Session registry, tasks, messages, adapters, state resolver, harness MCP server, supervisor MCP server, gateway supervision, token issuer | D1 and "separate running from view": the brain can be restarted or updated without killing agents. It serves the supervisor while the app is closed |
| **App** (existing UI) | Views and controls, terminal panes, the transcript index and the analysis MCP | — |
| **agentgateway** (third-party, supervised by the service) | Infrastructure MCP servers behind one endpoint | D3 |
| **stdio bridges** `--mcp`, `--harness-mcp`, `--supervise`, `--harness-hook` | Connect an agent's stdio to the service's socket | Agents speak MCP over stdio; hooks are shell commands. `--mcp` exists already |

The runner and service are started by launchd as per-user LaunchAgents, outside the app's process group. This is what lets them survive quitting the app. Every runner protocol change must stay readable by service N−1, and every service change must stay readable by the app N−1.

### Agent adapters: the agent-independence contract

A terminal is the minimum. Adapters add precision.

| Capability | Generic CLI | Claude Code | Codex |
|---|---|---|---|
| Launch | argv from a profile | `claude --session-id <uuid> --mcp-config <file> --settings <hooks>` | `codex -c mcp_servers.…` |
| Link to transcript | none | exact | by cwd and spawn time, unique only (**to verify**) |
| State signal | *unknown* | hooks: Stop, Notification (permission), UserPromptSubmit | `notify` hook and transcript `task_complete` events |
| Turn finished (needed for `task_assign`) | not available | Stop hook | `notify` / transcript |
| Deliver a task or prompt | — | Type into the terminal when idle (bracketed paste, then Enter); the first task goes in argv | same |
| Async wake-up | — | **MCP Tasks** (an open `listen` or `ask` task completes) | Fixed notice typed into the terminal when idle (D2 fallback) |
| Interrupt | Ctrl-C | Esc | Ctrl-C or existing daemon `turn/interrupt` |
| Resume | — | `claude --resume <id>` | `codex resume <id>` |
| Image paste | path | Ctrl-V passed through, or path | path (**to verify**) |

Nothing is written into the user's own agent config files. MCP servers and hooks are passed per launch.

### MCP surfaces

| Surface | Served by | Who calls it | Tools |
|---|---|---|---|
| **Analysis** (exists, read-only) | App | Any local agent with the analysis grant | the 7 existing tools |
| **Harness** (agent tools) | Service, via `--harness-mcp` | Hosted agents only (identity from peer credentials) | `whoami`, `list_peers` (own folder first, with roles), `send_message`, `ask` → task, `reply`, `listen` → task, `read_inbox`, `set_status` (with role), `report` (needs the human / work done / status: where a session or its executors stand, with no notification, replaced on the Board by the session's next one), `bulletin_read` / `bulletin_post` / `bulletin_remove` (notes for later sessions, with expiry), `declare_dependency` / `resolve_dependency` |
| **Supervisor** (root, D5) | Service, via `--supervise` | Any local agent that isn't a hosted session (hosted ones only with a profile flag) | Everything the harness has. Sessions: `profiles_*` (read and edit), `session_create(profile, cwd, name, task?)`, `session_list`, `session_status`, `session_result(id)`, `session_send`, `session_interrupt`, `session_end`, `session_resume`. Tasks: `task_assign(session, text)` → task, `task_status`. Terminals: `terminal_read(id, lines)` and `terminal_write(id, input)`. State: `attention_list`, `attention_wait` → task, `messages_*`, `graph`, `registry`, `audit`, `gateway_status`. **The one exception is answering permission prompts (D6)**: `terminal_write` is refused while a session waits on a permission prompt |
| **Gateway** | agentgateway | Hosted agents (per-session JWT) | Atlassian, TEOB memory, others, with prefixed names |

All harness-owned surfaces speak MCP **2026-07-28**, with legacy negotiation for older clients (Codex). A tool returns a task only when the request declares the Tasks extension. Otherwise it answers immediately with an id, and the caller polls `task_status` or reads its inbox.

The harness tools stay a separate MCP server instead of sitting behind the gateway, for two reasons: the harness must know exactly which session is calling, and Tasks passthrough in agentgateway is unverified. If agentgateway is shown to forward Tasks and a caller identity the harness can trust, moving the harness behind it is a recorded option.

### How async delivery works

- **`task_assign`** (supervisor → agent): stored with a receipt. Typed into the session when the adapter reports it idle. The task completes when the adapter reports the turn finished, with the last assistant message as the result. A permission prompt during the task raises an attention item. The task stays `working` with the status message "waiting for operator: approve `<tool>` — `<summary>`, since `<time>`", so the supervisor sees exactly what's blocking. It is never `input_required`, because the supervisor can't answer it (D6).
- **`ask(peer, question)`** (agent → agent): a message plus a task that completes on `reply`.
- **`listen()`**: a task that completes with the next unread message. An idle Claude Code session wakes when it completes, handles the message and calls `listen` again. This is the inbox subscription for agents that support Tasks.
- **Without Tasks** (Codex today): unread counts in every harness tool result, plus a fixed notice typed into the terminal when idle (no message body). Per pair of sessions, typing notices can be switched off.

### Channels

| Edge | Sync | Guarantee / ordering | Backpressure | Departure |
|---|---|---|---|---|
| **E1** child ⇄ runner (PTY) | stream | exact, ordered per session | The runner reads continuously into scrollback and drops the oldest output when full | Child exit recorded. Runner exit → children get SIGHUP |
| **E2** runner → app terminal output | async | at most once per view; scrollback replay on attach | Watermarks from xterm.js write callbacks; only views on screen are streamed | Detach has no effect on the child |
| **E3** app → runner input and paste | async, ordered per session | exact | Writes split into chunks on a writer thread | — |
| **E4** service ⇄ runner control | sync, completion | — | — | On service start: list runner children and reconcile the registry |
| **E5** app ⇄ service control | sync | — | — | Protocol N−1 |
| **E6** agent → harness MCP | sync; receipt for messages; tasks for long work | Caller identified by peer credentials | Rate limit per session and per pair | Bridge exit leaves stored messages and tasks intact |
| **E7** supervisor → supervisor MCP | sync; receipt plus task | Ordered per session | Grant limits: max sessions, max open tasks, rate | A task outlives the supervisor's connection; the supervisor resumes polling by id |
| **E8** agent → gateway | sync, HTTP on localhost | — | Gateway rate limits | Gateway restart: calls fail, then succeed |
| **E9** service → transcripts of hosted sessions | tail | ordered | — | Only hosted sessions' files; the app keeps the full index |

### Technology

- **PTY:** `portable-pty`. **Terminal UI:** xterm.js (fit, WebGL, unicode11), lazy-loaded.
- **Sockets:** Unix sockets in the config dir (`0700`): `runner.sock`, `harness.sock`. Control messages as JSON lines, terminal data as binary frames.
- **Caller identity:** `LOCAL_PEERPID` on the socket, then walk parent pids up to a runner child. A process that descends from a hosted session is that session; anything else is external.
- **Harness store:** `harness.sqlite` (`sqlx`). It holds truth, so it stays separate from the derived index that revoking access clears.
- **MCP:** keep the hand-written JSON-RPC layer (`session_mcp.rs`) and extend it to 2026-07-28 and Tasks, unless the Rust SDK `rmcp` covers 2026-07-28 (**to check**).
- **Gateway:** agentgateway, supervised by the service with a generated config. The service mints a short-lived JWT per session (the service is the issuer; the gateway validates it against the service's local key). CEL policies can then limit tools per profile.
- **Scrollback replay:** raw bytes. At ≤ 5 MB against xterm.js parsing tens of MB/s, replay takes under 0.5 s. A screen snapshot inside the runner (`alacritty_terminal`) is a recorded option. Trigger: a measured reattach slower than 1 s.

### Clipboard (Cmd-V / Ctrl-V)

| Gesture | Clipboard content | What reaches the terminal |
|---|---|---|
| Cmd-V | text | Bracketed paste when the agent enabled it, so a multi-line paste never submits early; long text split into chunks |
| Cmd-V | image | Saved as PNG to `harness/attachments/<session>/`; the quoted path is pasted |
| Cmd-V | files copied in Finder | Quoted paths |
| Ctrl-V | anything | Passed through as `^V`: Claude Code reads the clipboard image itself |
| Drag & drop | files | Quoted paths |
| Select / Cmd-C | — | Copy. Agent OSC 52 clipboard writes allowed; OSC 52 reads refused |

The native Edit menu with Paste, which WKWebView needs for Cmd-V, exists already.

## 05 · Trust

| Boundary | Risk | Enforcement |
|---|---|---|
| **Webview → service/runner** | Injected script would act as the operator | Existing `html:false`, CSP and navigation guard. Sessions start only from **launch profiles** held in the service (profile id + cwd, never raw argv); the cwd must be an opened folder or a directory from session history |
| **Hosted agent → harness MCP** | Impersonating a peer | Identity from kernel peer credentials and process ancestry. It can't be forged by passing a different id or token |
| **External agent → supervisor MCP** | — (D5: root access, all local) | No grant or limits beyond turning the harness on. What's kept serves *visibility*, not restriction: peer credentials attribute each call; every action is audited; sessions show **created by supervisor**, with an edge in the graph. Hosted agents are refused the supervisor surface unless their profile sets nested supervision, so an ordinary worker can't take over the harness by accident |
| **Peer content** | Prompt injection spreading; message loops | Message bodies are returned as data labelled with the sender, marked untrusted. A notice typed into a terminal is fixed harness text. Rate limits per pair and a hop count on `ask` chains |
| **Agent → gateway** | Credential spread; one agent using another's identity | Upstream credentials stay in the gateway and Keychain. Each session gets its own short-lived JWT. CEL policies per profile |
| **Permission prompts** | An agent approving dangerous tool use in another agent | Only the human approves (D6). Enforced in the service: input from the supervisor or a peer is refused while the target waits on a permission prompt. Only the app's terminal pane can type into it |

**Finding: the harness can't isolate agents from each other at the operating-system level.** Agents run shell commands as your user, so any of them can reach the sockets, read other processes' environments and start `claude` directly. Identity from peer credentials keeps *cooperative* agents honest and gives correct attribution. Against a *hostile* agent, the boundary is your OS user. Real isolation would need a sandbox per agent that denies access to the harness directory (Seatbelt, or the agents' own sandbox modes). That is a recorded option. Trigger: you run agents you don't trust.

For the same reason, root access for the supervisor (D5) adds no OS power a local process doesn't already have. By the same reasoning, the D6 refusal binds cooperative agents, not hostile ones.

## 06 · Derivation

| Processor | Type | Rule |
|---|---|---|
| **State resolver** | stateful, per session | Adapter signal (*verified*) > transcript (*inferred*) > terminal heuristic (*guessed*). A weaker signal never overrides a stronger one |
| **Identity linker** | stateful | Exact ids first; cwd+time only with exactly one candidate; ambiguity stays visible |
| **Task tracker** | stateful | `working` → typed into the session when idle → `completed` on the adapter's "turn finished", with the last assistant message → `failed` if the session ends |
| **Attention processor** | stateful, per session | Raises an item for: **permission prompt** (Claude Notification hook, Codex approval event); **question to the human** (elicitation, an agent asking in its own words); **turn finished, awaiting instructions**; **stalled** (state *working* but no output or transcript growth for 10 min, labelled *guessed*); **ended unexpectedly**. Agent-independent signals from the terminal stream: BEL, and OSC 9 / OSC 777 notifications (Claude Code and Codex both emit these when configured). Delivery: badge on the session and in the toolbar; ordered attention list at the top of Sessions; a macOS notification (sent by the service) when the app is closed or the session isn't on screen; Dock badge count; repeated every 5 min while unanswered. Priority: permission > question > ended unexpectedly > stalled > turn finished |
| **Graph projector** | stateless | Edges with their source: *spawned* and *forked* (transcripts); *created by*, *assigned task*, *asked / waiting on*, *messaged*, *declared dependency* (harness); *same ticket*, *same worktree* (weak). Active nodes expanded; inactive ones collapse |

## 07 · Failure: how each promise is reached

| Promise | Mechanism | Test |
|---|---|---|
| Agents outlive the app | Runner and service are LaunchAgents | Quit the app mid-output, reopen, scrollback continues |
| Service update keeps agents alive | Service restart reconciles against the runner | Restart the service under load; terminals and tasks continue |
| Runner crash is signalled | Service marks orphaned rows **ended unexpectedly** and offers resume | `kill -9` the runner |
| No double writer | Resume only when no live process (hosted or observed) holds the session | Observed process blocks resume |
| Assignment never "maybe" | Receipt = commit before return; a client-supplied id deduplicates retries | Duplicate `task_assign` |
| Supervisor survives reconnecting | Tasks are stored; `tasks/get` and `task_status` work across connections | Kill the supervisor mid-task, poll again |
| No message loops | Pair rate limit plus hop count, then a typed refusal | Two fake agents ping-pong |
| Gateway outage doesn't stop agents | Separate process; typed errors | Stop the gateway |
| No session waits on the human unseen | Attention processor in the service (so it works with the app closed); macOS notification; supervisor sees the item in `task_status` and `attention_list` | Trigger a permission prompt with the app closed: notification within 2 s; repeated after 5 min |
| The supervisor can't approve | Service refuses supervisor and peer input while a permission prompt is open | Test: `terminal_write` during a prompt is refused |

## 08 · Placement and capacity

One runner and one service per user. The service starts agentgateway as its child. Capacity: about 20 sessions × ≤ 1 MB/s bursts (assumed), against PTY reads of hundreds of MB/s — not binding. Memory: 20 × 5 MB ≈ 100 MB of scrollback (assumed), with the size configurable.

## 09 · Operations

Zero-tolerance counts, shown in the harness panel: rows shown live without a live process · messages or tasks accepted then lost · peer-credential identity mismatches · **a session waiting on the human with no attention item raised** (checked by comparing each adapter's waiting state against open items) · **permission input accepted from anything but the app's terminal pane**. The audit view covers harness, supervisor and gateway calls. Flags: the `harness` grant is a permission flag; the "type notices into terminals" setting per pair of sessions and the notification repeat interval are operations toggles.

## 10 · Traceability

| Requirement (testable) | Mechanism | Verified by |
|---|---|---|
| R1 See active local sessions, labelled verified / observed / inferred | runner, registry, process sampler, state resolver | spawn/kill tests; external `claude` appears within 5 s |
| R2 See inactive sessions | existing index | existing tests |
| R3 See who depends on whom | graph projector | fixture with ask, subagent, fork, supervisor-created |
| R4 Drill down to details | existing details/events plus scrollback | — |
| R5 Terminals of active sessions run in the app | runner, xterm.js, E1–E3 | app-quit test |
| R6 Every paste works | clipboard module, key bindings, adapter image capability | paste matrix per adapter |
| R7 Harness tools between sessions | harness MCP, message store, Tasks delivery, fallback notices | two fake agents ask/reply; Claude wakes on `listen` |
| R8 Works with any coding agent | adapter trait, terminal as the minimum | conformance test with a scripted fake CLI |
| R9 Infrastructure tools for every hosted agent | agentgateway, per-session JWT | a hosted agent calls a Jira tool through the gateway |
| R10 Agents survive app quit and update | runner and service as LaunchAgents; protocol N−1 | update test |
| R11 No impersonation between agents, no loops | peer credentials, rate limits, hop count | impersonation and loop tests |
| R12 An external agent creates sessions | supervisor MCP, launch profiles, grant | `session_create` from a test client |
| R13 An external agent assigns tasks and gets results asynchronously | task tracker, Tasks extension, `task_status` fallback | Claude Code supervisor wakes on completion; Codex supervisor polls |
| R14 Supervision works while the app is closed | service as a LaunchAgent | quit the app, run a task through `--supervise` |
| R15 The supervisor has root access to the harness, and its actions are visible | full supervisor surface, audit, "created by" label | every harness operation reachable from a test client; audit rows |
| R16 Only the human approves; a waiting session is never quietly stalled | attention processor, macOS notifications, input refusal during prompts | prompt-with-app-closed test; refusal test; zero-tolerance count stays 0 |

**Coupling findings.**
- The **harness service** is named by R1, R3, R7, R9, R11, R12, R13, R14, R15 and R16: ten requirements. Its restart is designed to be harmless (agents live in the runner). Its *correctness* is the largest blast radius here, so it gets the most tests.
- The **runner** is named by R1, R5 and R10. A runner crash ends agents, so the runner stays small and rarely changes.
- The **task tracker** is named by R13 and by R7 through `ask`/`listen`. Whether a turn has finished comes from the adapter's signal, so a missed Stop hook stalls both kinds of task.
- The **adapter state signal** is named by R1, R7, R13 and R16. One missed hook makes a session look busy, stalls its tasks and hides it from the attention queue all at once. That's why the attention processor also reads BEL/OSC 9 from the terminal stream and raises a *guessed* "stalled" item after 10 minutes: a second, independent path for the promise you care most about.

## Slack connector (D14, MCR-26)

**Status:** first version built on 2026-11-17 for an end-to-end test on the owner's workspace; not yet run against Slack (see "What is built"). Ships in 1.0 as a preview. Tasks: MCR-27 to MCR-40.

### What is built

| Part | State |
|---|---|
| Connect flow: tokens checked with Slack, native confirmation, tokens in the Keychain, disconnect | Built; not run live |
| Socket Mode connection in the harness service: store, acknowledge, deliver; reconnect; off switch | Built; the Web API side is tested against a fake, the WebSocket loop only compiles until the live run |
| Channel policies in the app (Slack tab): listen, senders, route, posting, who may post | Built |
| Routing to a session or the Supervisor as inbox data; threads stay with their session | Built, tested |
| Catch-up of channels after a reconnect | Built, tested |
| Harness tools `slack_channels`, `slack_reply`, `slack_post`, `slack_post_status`, `slack_thread`; supervisor tool `slack_status` | Built, tested |
| Approval in the app (approve, edit then approve, deny with a reason) and in Slack (Approve, Deny) | Built, tested |
| Sending as the bot, at most once, with the outcome told to the session | Built, tested |

What differs from this design for now, and why:

| Design | Now | Closes with |
|---|---|---|
| Slack classes in `harness.sqlite`; 30 days of messages | `slack-state.json`, rewritten atomically before any change is acted on; the last 2,000 messages and 500 posts | MCR-30 |
| A pending post is an attention item in the attention list, repeated while unanswered | A badge on the Slack tab, the card in the Slack view and one macOS notification | MCR-35 |
| Route to a new session from a launch profile | Not built: a session or the Supervisor | MCR-32 |
| Catch-up of followed threads; a count of skipped messages | Channels only; "older messages were skipped" without a number | MCR-33 |
| A list of sessions or profiles that may post | The routed session and replies in its threads, or every session (the service takes a list; the app offers these two) | MCR-31 |
| User mentions for channel members by policy | Agent text mentions nobody | MCR-37 |
| Deny with a reason in Slack | Deny without a reason; reasons are given in the app | MCR-36 |
| A fake Socket Mode server in the tests | The connection loop is checked in the live run only | MCR-29 |
| A post tool may return a task (Tasks extension) | It returns an id; the outcome arrives in the inbox | D2 gap, as for the other tools |
| The connector works while the app is closed | True while a session runs. The harness service exits ten minutes after the last session ends, and with it the connection; what arrived meanwhile is caught up at the next start, within the catch-up bound | Owner decision if listening without sessions is wanted |

**Goal.** Hosted sessions receive messages from chosen Slack channels and post replies or new messages to chosen channels. The operator sets, per channel, what is listened to, whose messages reach a session, and what may be posted. A post that policy does not allow automatically waits for the operator.

### Facts the design depends on

Checked against Slack's documentation (docs.slack.dev, slack.com/terms-of-service/api) on 2026-11-17.

| Fact | Consequence here |
|---|---|
| **Socket Mode**: an app-level token (`xapp-`, scope `connections:write`) calls `apps.connections.open` and gets a temporary `wss://` URL. No public endpoint. Up to 10 connections. Slack ends connections itself: `warning` about 10 s ahead, `refresh_requested` every few hours without warning, `link_disabled` when Socket Mode is switched off | One connection. Reconnecting is routine, not an error. `link_disabled` is shown as *refused* |
| Every envelope must be acknowledged by its `envelope_id`. The Socket Mode guide gives no deadline; the 3 s figure comes from the Events API page and Slack's SDK guides. Slack retries unacknowledged events (about at once, after 1 min, after 5 min); `retry_attempt` may be missing | Store, then acknowledge, well inside 3 s. Deduplicate by event id, never by the retry fields |
| Events sent while no connection is open are not documented as replayed; the Events API is "best-effort" and drops events more than 2 hours late | Catch-up from history after every reconnect is required, not optional |
| Interactivity (button presses, modals) arrives over the same connection. `views.open` works; its `trigger_id` expires in 3 s and is single-use | Approval in Slack needs no public URL. A "deny with reason" modal must be opened right after the acknowledgement |
| Bot events cover only channels the bot is a member of: `message.channels` (`channels:history`), `message.groups` (`groups:history`), `app_mention` (`app_mentions:read`), `member_joined_channel` for membership | The operator invites the bot to each channel; the Slack panel lists exactly those |
| `chat.postMessage` needs `chat:write`; the bot must be a member (we don't ask for `chat:write.public`). `thread_ts` replies in a thread. A per-message name or icon needs `chat:write.customize`. No idempotency key exists. About 1 message/s per channel, several hundred per minute per workspace | The session's name goes into the message text, not a custom username. Duplicate protection is ours (pending-post states, history lookup) |
| A direct message to a user: the method reference and the sending guide disagree on posting to a `U…` id. The documented path is `conversations.open` (`im:write`), then post to the `D…` id | Approval messages use `conversations.open` |
| Mentions are `<!here>`, `<!channel>`, `<!everyone>`, `<@U…>`, `<!subteam^…>`. Escaping `&`, `<`, `>` neutralises them in `text`. Plain `@here` in top-level `text` is parsed only with `link_names=1`. **In Block Kit mrkdwn objects auto-parsing is on by default** (`verbatim: false`) | Agent text is escaped, sent without `link_names`, and every block that carries agent text sets `verbatim: true`. That includes the approval message |
| `conversations.history` and `conversations.replies` are Tier 3 (50+/min) for internal customer-built apps. Since 2025-05-29 (existing installs: 2026-03-03) commercially distributed apps outside the Marketplace get Tier 1: 1 request/min and at most 15 messages per call | See "Distribution status" below: catch-up is sized for Tier 1 |
| Socket Mode apps are not allowed in the Slack Marketplace | No way from here to a listed app without a hosted relay |
| Bot tokens don't expire unless token rotation is on, and rotation can't be switched off again. The manifest can set Socket Mode, interactivity, bot events and scopes; the app-level token is created by hand in the app's settings | The manifest leaves rotation off. Connecting takes two pasted tokens |
| From 2027-02-17 Slack answers 403 to a GET or HEAD request that has a body | The HTTP client sends arguments in the query string or uses POST |
| Slack's API terms (2025-10-10) forbid training an LLM on API data and bulk export, for applications offered outside one's own organisation. Nothing found against passing channel messages to a model at inference time in an internal app | Stated in the setup guide (MCR-39); see "Distribution status" |

**Distribution status (open, MCR-40).** The owner's own workspace with an app he created is an internal customer-built app: Tier 3 limits, internal terms. When TEOB HQ ships the manifest as a template to other people, Slack's terms name "a custom Application or Application template" connected to a commercial product, which may put every user's app under the commercial-distribution rules: Tier 1 history limits and the outside-organisation data terms. This reading is ours, not Slack's. Until it is settled, the design must work at Tier 1, and no setup guide for other users is published.

### Outside

| Client | What it does | Tolerances |
|---|---|---|
| **Operator in the app** | Connects Slack, sets channel policies, approves, edits or denies posts, switches the connector off | A post waiting for approval is as visible as a permission prompt. The off switch works at once. No post leaves without the approval its policy requires |
| **Operator in Slack** (phone or desktop, app closed) | Writes to listened channels; approves or denies a post from the bot's direct message | Approving in Slack does exactly what approving in the app does, for the exact text shown |
| **Other people in a listened channel** | Write messages | Their messages reach a session only when the operator put them on the channel's sender list |
| **Hosted agent** | Receives routed messages in its inbox; asks to reply or post | A post request is accepted with an id or refused with a typed reason, never "maybe". It is told the outcome |
| **Supervisor** | Reads Slack state, pending posts and the audit | Cannot approve, cannot change policies (D6 extended) |
| **Slack** | Delivers events over Socket Mode, accepts posts | Its limits and outages. A missed acknowledgement is retried by Slack; events sent while disconnected are not replayed |

What a client still gets when something fails:

| Failure | Operator | Hosted agent |
|---|---|---|
| Slack unreachable, or the Mac asleep | Connector shown *reconnecting*, with the time of the last event | Post requests are still accepted and wait (*pending but signalled*); nothing is delivered |
| Reconnect after a gap | Missed messages are caught up from channel history, marked with their original time; beyond the bound, a count of skipped messages per channel (*correct but late*, then *absent but signalled*) | Same |
| Token revoked or the app removed | Connector shown *refused*, attention item | Posts fail with a typed reason |
| Routed session ended | Message kept, shown as undelivered | — |
| Post outcome unknown (timeout after sending) | Shown as *outcome unknown* until the channel's history settles it | Told "outcome unknown", then the settled result |
| Harness service restart | Pending posts and policies survive | Tools fail for seconds |

### Load

All figures **assumed**; one workspace, one operator.

| Figure | Value | Used at |
|---|---|---|
| Listened channels | ≤ 20 | catch-up cost after a reconnect |
| Followed threads at a time | ≤ 20 | catch-up cost |
| Incoming messages | ≤ 2,000/day, bursts ≤ 5/s | store size, routing rate limits |
| Posts by agents | ≤ 200/day, ≤ 1/min per session | approval load on the operator, Slack's posting limit |
| Stored message bodies | 30 days or 50,000 messages, whichever is less | retention |

Slack's posting limit is about one message per second per channel, three orders of magnitude above this load. Catch-up is where Slack binds. At Tier 1, one history call per minute returns at most 15 messages: 20 channels and 20 threads take 40 minutes for one page each, and a channel that got 150 messages during a night takes 10 calls. So catch-up reads the newest page of each channel first, round-robin, and stops at a bound per channel (default 45 messages or 12 hours); the rest is counted as skipped. At Tier 3 the same catch-up takes seconds. The other binding limit is the operator's attention: at more than a few approvals per hour a channel should move to an automatic policy or stop being a target. One node suffices.

### Data

| Data class | Source of truth | Write acknowledgement | Invariants |
|---|---|---|---|
| **Slack tokens** (bot, app-level) | macOS Keychain | Completion | Never in the harness store, the app's store, exports, logs, the audit, tool results or an agent's environment |
| **Connection record**: workspace, bot user, operator's Slack user, Slack approval on/off | Harness store | Completion | The operator's Slack user is set only in the app, after a native confirmation |
| **Channel policies** | Harness store | Completion | Changed only from the app. Defaults: listen off, senders = the operator, posting never |
| **Received events** | Harness store | **Receipt**, before the envelope is acknowledged to Slack | One row per Slack event id. Bounded retention |
| **Channel cursors**: last seen timestamp per channel and per followed thread | Harness store | Completion | Only moves forward |
| **Pending posts**: session, channel, thread, exact text, text hash, state, who decided, where | Harness store | **Receipt** on request; every state change is stored before it is acted on | States: waiting → approved → sent, or denied, cancelled, failed, outcome unknown. A post is sent at most once. An approval is valid only for the stored hash |
| **Audit**: routed message, approval, denial, post, refused approval | Harness store | Receipt | Text is referenced by hash; no tokens |

The harness store is still `harness-state.json`, rewritten whole. Slack events and pending posts need receipts, queries and bounded retention, which is the trigger this document already names for `harness.sqlite`. The Slack classes are the first tables of `harness.sqlite`; the existing JSON classes move under their own task.

### Runtime and channels

The connector is a module of the **harness service**. It is never part of the runner (the runner holds no policy and no network) and never part of the app (it must work with the app closed). It holds one Socket Mode WebSocket and calls Slack's Web API over HTTPS. The service's sockets and threads are blocking, so the connector uses blocking clients on its own threads: `tungstenite` for the WebSocket and `ureq` for HTTPS, both on `rustls`; `security-framework` for the Keychain. None of them enters the runner's code path. Versions are pinned when MCR-29 adds them.

| Edge | Sync | Guarantee / ordering | Backpressure | Departure |
|---|---|---|---|---|
| **S1** Slack → service (Socket Mode events and button presses) | async | At least once from Slack; exactly once into the store by event id; ordered per channel by Slack timestamp | Events are stored first and routed after; routing is rate-limited per channel and per session, with a visible "held back" count | Reconnect with backoff; catch-up from history (S3) |
| **S2** service → Slack (posts, approval messages, message updates) | sync, HTTPS | At most once per pending post | One queue per channel, about one post per second | Timeout → *outcome unknown* → settled from history, never a blind retry |
| **S3** service → Slack (history for catch-up and thread reads) | sync, HTTPS | Ordered per channel | One call per minute when the app is on Tier 1, otherwise Tier 3; a single queue for all history calls, newest page of each channel first; bounded depth | A 429 answer is obeyed by its `Retry-After` |
| **S4** service → session inbox | existing message path (E6) | Receipt | Existing limits | Session ended: message stays undelivered and visible |
| **S5** agent → harness MCP (`slack_*` tools) | sync, receipt | Caller from peer credentials | Rate limit per session | A pending post outlives the agent's connection |
| **S6** app → service (policies, approve / edit / deny, off switch) | sync | — | — | — |

**Harness tools** (hosted sessions): `slack_channels` (where this session may post, and under which policy), `slack_reply(message, text)`, `slack_post(channel, text)`, `slack_post_status(id)`, `slack_thread(message)` (more of a thread the session was addressed in, bounded, untrusted). A post tool stores a pending post and returns its id at once; it never blocks on the operator. With the Tasks extension it may return a task that completes on the decision. The outcome reaches the session through its inbox. **Supervisor tools:** `slack_status`, pending posts, audit: read only.

**Incoming message.** Stored event → channel policy (listen mode, sender list) → route → inbox message carrying channel, sender name, thread, permalink, original time and text, labelled *untrusted data from Slack* → the existing wake-up (`listen` task, or the fixed notice for agents without Tasks; the notice never contains Slack text). A thread stays with the session that got its first message. Routes in the first version: one session, the Supervisor, a new session from a launch profile (the message is its first inbox item, never argv). Routing to a group waits for D9.

**Outgoing post.** Request → typed refusal or pending post → policy: *never* (refused), *approve each*, *automatic for replies in a thread where an allowed sender addressed this session*, *automatic* → sent as the bot with the session's name, link previews off → outcome to the session and the audit. Text only. Agent text is escaped, sent without `link_names` and with `verbatim: true` in every block, so it cannot mention anyone. A channel's policy can allow user mentions for members of that channel; broadcast mentions stay off in the first version.

**Approval.** Two paths, same effect, first decision wins:

- **App:** a card with session, channel, thread and the exact text. Approve, edit then approve, or deny with a reason.
- **Slack:** the bot opens its direct message with the operator (`conversations.open`) and posts the same content and two buttons there. The press comes back over the same WebSocket. The service accepts it only when Slack names the recorded operator as the acting user, the pending post is still waiting, and the hash carried by the button equals the stored one. After a decision the direct message is rewritten without buttons. Editing stays in the app in the first version.

A pending post is an attention item of its own kind. Today a session carries at most one attention item; posts need a list beside it, shown in the same attention view. Priority: permission > question > ended unexpectedly > **post approval** > stalled > turn finished: a waiting post blocks nobody's process, since the tool has already returned.

### Trust

| Boundary | Risk | Enforcement |
|---|---|---|
| **Slack channel → agent** | Prompt injection: anyone who can write in a listened channel instructs an agent that has a shell as the user | Per-channel sender list, default the operator only; other messages are stored and shown, never delivered. Bot messages are never routed. Delivered text is data labelled untrusted. The session's own permission mode still gates what it does |
| **Agent → Slack channel** | Exfiltration of anything the agent has read; spam; impersonation | Default posting *never*. Per-channel list of sessions that may post. Approval shows the exact text. Automatic policies are a confirmed choice per channel. Posts carry the session's name. Rate limit per session |
| **Approval** | Something other than the operator approves | Only two paths are accepted: the app's control connection, and a Slack button press by the recorded operator for the stored hash. The Supervisor, peers and hosted sessions are refused. Policies and the operator's Slack user change only in the app |
| **Slack account as an instruction path** | The operator's Slack account can ask a session to do things, and that session can run commands | Decided with D14: a message from the recorded operator is marked `fromOperator` and read as the operator's request, inside what the session is allowed to do. Messages of other listed senders are data. Taking the operator off a channel's sender list, or the off switch, closes it |
| **Slack account as an approval path** | Whoever controls the operator's Slack account approves posts | It can approve or deny posts and nothing else: no permission prompts, no terminal input, no policy changes. It can be switched off in the app |
| **Approval message** | The text of a post leaves the Mac before it is approved | The operator's direct message with the bot holds the text of every post that waited, denied ones included. Accepted with D14; switching Slack approval off removes it |
| **Tokens** | An agent posts or reads directly with the bot token | Keychain only; never returned by any tool or written to a log |
| **Loops** | Two bots answering each other; an agent answering itself | Bot messages and the bot's own posts are never routed; rate limits per channel and session |

The finding of section 05 holds here too. A **hostile** hosted agent runs as the same OS user: it can reach the service's socket, and with the user's login Keychain unlocked it may be able to read the tokens the service stored. The enforcement above binds cooperative agents and gives correct attribution. MCR-38 states what a Keychain access control list on the items does and does not add.

### Failure: how each promise is reached

| Promise | Mechanism | Test |
|---|---|---|
| No post without the approval its policy requires | The sender takes only pending posts in state *approved* or allowed by policy; the approval paths are the only writers of *approved* | Approval from the Supervisor surface refused; zero-tolerance count |
| An approval covers the exact text | Hash stored with the pending post, carried by the Slack button, compared on every decision | Edit after approval voids it; replayed button payload refused |
| A post is sent at most once | State stored before sending; on a timeout the post becomes *outcome unknown* and is looked up in history before anything else | Fake server accepts, then drops the connection: one message |
| An event reaches a session once | Event id is the store's key; the envelope is acknowledged after the write | Duplicate and retried envelopes |
| Messages sent while disconnected arrive | Catch-up from the channel cursors after every reconnect and service start, bounded; skipped counts shown | Sleep and wake with the fake server |
| A stranger's message reaches no session | Sender list checked in the service before routing | Message from a user outside the list |
| The connector can't hurt sessions | Own threads, own store tables; every call to it from the session path is non-blocking | Connector panics and hangs under test; sessions and tasks continue |
| Off means off | The switch stops the WebSocket, cancels waiting posts with a typed reason and empties the send queues before it returns | Post approved, switch turned off before sending: not sent |

### Operations

Zero-tolerance counts added to the harness panel: **posts sent without the approval their policy required** · **approvals accepted from anything but the app or the recorded operator in Slack** · **Slack events acknowledged but not stored** · **messages delivered to a session from a sender outside the channel's list**. The Slack panel shows the connector's state, the last event's time, held-back and skipped counts, pending posts and the audit. Flags: connecting Slack is a permission flag (native confirmation, like the harness grant); the off switch and "approval in Slack" are operations toggles.

### Traceability

| Requirement (testable) | Mechanism | Verified by |
|---|---|---|
| S-R1 Messages from chosen channels and senders reach the routed session, with the app closed | connector in the service, policies, routing, existing wake-up | live: the operator's message wakes a Claude Code and a Codex session |
| S-R2 Nothing from other channels or senders reaches a session | policy check before routing | sender and channel tests |
| S-R3 Agents reply in threads and post to chosen channels as a bot | `slack_reply`, `slack_post`, sender | live post with the session's name |
| S-R4 The operator controls listening and posting per channel, and can stop everything at once | policies, off switch | policy tests; off-switch test |
| S-R5 Only the operator approves, in the app or in Slack, and only the exact text | two approval paths, hash, refusals | refusal tests; zero-tolerance counts stay 0 |
| S-R6 Credentials stay on this Mac and away from agents | Keychain, no token in any output | search of the config dir, logs and tool results |
| S-R7 No message is lost or duplicated without a signal | receipt before ack, event id, catch-up, skipped counts | fake-server tests |
| S-R8 A post is never sent twice | pending-post states, history lookup | timeout test |

**Coupling.** The pending-post state machine is named by S-R3, S-R5 and S-R8: it gets the most tests, including a service stop between every pair of steps. The policy check is named by S-R1, S-R2 and S-R4. The connector adds one requirement to the harness service (network access and a secret) and none to the runner.

### Delivery order

MCR-27 design → MCR-28 connect and Keychain → MCR-29 connector → MCR-30 store → MCR-31 policies UI → MCR-32 routing → MCR-33 catch-up → MCR-34 tools → MCR-35 approval in the app → MCR-36 approval in Slack → MCR-37 sending → MCR-38 security review and live run → MCR-39 release fit. MCR-40 (distribution status under Slack's terms) gates MCR-39's setup guide, not the owner's own use. Listening is usable after MCR-33, before any post can be sent.

### Risk register (Slack)

| Assumption | Decision it supports | How to settle it |
|---|---|---|
| The harness service can use the Keychain and the network as a LaunchAgent, and as the helper outside the store (MCR-16, MCR-19) | D14 | Spike in MCR-28 |
| A Keychain access control list keeps other processes of the same user from reading the tokens without a prompt | Token row of the trust table | MCR-38 |
| The load figures | Retention, approval load | Measure after a month of use |
| Apps created from our manifest count as internal customer-built apps | Tier 3 history limits; the terms that apply to users' data | MCR-40: read the terms with the owner, ask Slack if unclear. The design holds at Tier 1 either way |
| The acknowledgement deadline in Socket Mode is 3 s | Store before acknowledging | Measure store latency in MCR-29; it is a local write |
| The operator answers approvals within minutes | "approve each" as a usable policy | Watch the age of pending posts; otherwise prefer the thread-reply policy |

## Engineering defaults

Why the D7–D9 defaults: with up to 20 agents and only the human approving (D6), prompting for every edit would flood the attention queue (D7). Parallel agents in one repository overwrite each other's files (D8).

Also decided: terminal scrollback isn't kept on disk after a session ends; the harness UI extends the Sessions workspace instead of adding a third workspace; the MCP layer stays hand-written unless `rmcp` covers 2026-07-28.

## Delivery sequence

1. **Run and view:** runner, service skeleton, LaunchAgents, terminal pane, launch profiles (generic, Claude, Codex), paste matrix, verified liveness, **attention queue with macOS notifications**. Permission prompts appear in the very first terminals, so being able to see them can't wait.
2. **One list:** transcript linking, external process sampling, active and inactive together, resume.
3. **Supervision:** supervisor MCP (2026-07-28, Tasks plus fallback), task tracker, grant and limits.
4. **Coordination:** harness MCP for agents, message store, `ask` / `listen`, dependency graph.
5. **Infrastructure:** agentgateway supervision, per-session JWTs, Atlassian then TEOB memory.

Supervision comes before agent-to-agent coordination because it reuses the same task tracker and is the simpler path: one caller, one target.

### Risk register

| Assumption | Decision it supports | How to settle it |
|---|---|---|
| agentgateway passes the Tasks extension through | Moving harness tools behind the gateway (recorded option only) | Test against 1.4.x |
| agentgateway can handle Atlassian's upstream OAuth for local agents | R9 for Atlassian | Test; otherwise keep Atlassian as a direct MCP server in each launch profile |
| Claude Code's Stop hook fires reliably at the end of every turn | R13, R7 | Fixture over 100 turns |
| Codex rollout can be linked by cwd and spawn time | R1 for Codex | Spawn 5 Codex sessions in one directory |
| Codex accepts an image by pasted path | R6 for Codex | Manual check |
| `rmcp` supports 2026-07-28 and Tasks | MCP implementation choice | Check the crate |
| Bursts ≤ 1 MB/s; scrollback ≤ 5 MB | Raw replay without an emulator in the runner | Measure in phase 1 |
| The service, run by launchd from inside `MDViewer.app`, can post macOS notifications under the app's identity | R16 with the app closed | Phase 1 spike; otherwise the service opens a minimal notifier from the bundle |
| Claude Code's Notification hook fires for every permission prompt; Codex emits an approval event or OSC 9 | R16 | Claude: seen live for a Bash approval. Codex: an OSC 9 text containing "approv" raises the item; **not yet seen live** |
| Codex's title writer is recognised by its prompt ("Generate a concise, single-line task title") | Codex turn ends, task results | Re-check on every Codex update; a wrong guess shows as a task completing with a `{"title": …}` result |
| Codex's input box is recognised on screen by "›" and "for shortcuts" | Typing tasks into a Codex session before its first turn end | Re-check on every Codex update; when the marker is missing the task stays queued and the operator is told |
| A Claude session that is quiet with no hook 10 s after start is asking a start-up question | R16 for trust and login questions | A slow start raises a false item that clears at the first hook |
