# Local agent harness: architecture

**Status:** design, revision 4 (2026-11-13). Decisions D1–D12 are signed (below). Home: `lambda-house/agent-mcr` (Agent Mission Control Room), a private repository carrying mdviewer-mj's history; viewer fixes merge from `upstream` (`lambda-house/mdviewer-mj`). Derived with the Outside-In method: every mechanism cites the requirement it serves (traceability map at the end).

**Goal.** MDViewer becomes the local harness for a group of coding agents. It runs their terminals and connects them to each other, to infrastructure tools (Atlassian now, TEOB memory later) and to two kinds of supervisor: the human operator in the app, and an external agent that creates sessions and assigns them tasks. It must not depend on any one agent.

## Decisions

| | Decision | Signed |
|---|---|---|
| D1 | Agents survive quitting or updating the app. The part that runs agents is separate from the view and controls | 2026-11-13 |
| D2 | Asynchronous work between agents and supervisors uses MCP's async mechanism: the Tasks extension of revision 2026-07-28 | 2026-11-13 |
| D3 | Atlassian, TEOB memory and other infrastructure tools are MCP servers behind a local gateway (agentgateway). Every hosted agent gets all of them | 2026-11-13 |
| D4 | macOS only for now | 2026-11-13 |
| D5 | A local supervisor gets root access: every internal of the harness, with no separate grant or limits. It's all local | 2026-11-13 |
| D6 | Only the human answers permission prompts. A session waiting on the human must be clearly visible, never quietly stalled | 2026-11-13 |
| D7 | Launch profiles carry the agent's own permission mode (Claude `acceptEdits`, Codex `workspace-write` with `on-request` approvals), so prompts are limited to shell commands and network | 2026-11-13 |
| D8 | `session_create` takes `worktree: true`. That's the default when another live session already uses the same repository. It creates `../<repo>-<session>` on a new branch, and the graph shows the branch. Removing a worktree is a human or supervisor action, never automatic | 2026-11-13 |
| D9 | Sessions belong to named groups (for example a supervisor's task force). `list_peers` and messaging cover the group by default, and the whole machine only with a flag. The graph collapses by group | 2026-11-13 |
| D10 | The harness is built in a separate repository: `lambda-house/agent-mcr` (private), with mdviewer-mj's history and mdviewer-mj as `upstream`. MDViewer itself stays a Markdown viewer | 2026-11-13 |
| D11 | agentgateway is a prerequisite installed with Homebrew, found on `PATH` or configured, with a version check | 2026-11-13 |
| D12 | Local builds are the gate: `npm run build`, `npm test`, `cargo clippy --all-targets` and `cargo test` on the Mac. GitHub CI stays Linux-only and checks what compiles there; macOS-only modules are behind `cfg(target_os = "macos")` | 2026-11-13 |

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
| **Harness** (agent tools) | Service, via `--harness-mcp` | Hosted agents only (identity from peer credentials) | `whoami`, `list_peers`, `send_message`, `ask` → task, `reply`, `listen` → task, `read_inbox`, `set_status`, `declare_dependency` / `resolve_dependency` |
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
| Claude Code's Notification hook fires for every permission prompt; Codex emits an approval event or OSC 9 | R16 | Fixture per agent |
