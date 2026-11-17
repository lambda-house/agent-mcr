# Windows port

Plan for full Windows support of Agent MCR (decision D13 in `AGENT_HARNESS_DESIGN.md`, which supersedes D4). Branch `windows-port`. One task per commit; the reviewer approves each before the next starts.

## Gate for every task

Scoped (operator decision, 2026-11-16): a frontend-only diff runs `npm run build` and `npm test`; a Rust-only diff runs `cargo clippy --all-targets -- -D warnings`, `cargo test` and `cargo xwin clippy`; a diff touching both runs all. The full five-check gate runs at the final merge and the final check.

On this Mac, all must pass:

```bash
npm run build && npm test
cd src-tauri && cargo clippy --all-targets && cargo test
cd src-tauri && PATH="/opt/homebrew/opt/llvm/bin:$PATH" cargo xwin clippy --target x86_64-pc-windows-msvc --all-targets
```

`cargo xwin` needs Homebrew LLVM on `PATH` (`llvm-lib`, `llvm-rc`, `clang-cl`); without it `libsqlite3-sys` fails to build.

State at plan time (32afc4a): all dependencies (sqlx/SQLite, portable-pty, Tauri) build for Windows. The crate fails with 86 errors because `runner`, `peer`, `agents`, `harness_commands` and `harness_preferences` are declared `cfg(unix)` in `main.rs`, and `harness.rs` and `main.rs` use `std::os::unix`, `libc::getuid`/`getpwuid` and `PermissionsExt` unconditionally.

`cargo test` cannot run for Windows here. Logic that differs per platform goes into pure functions that are not behind `cfg`, so the Mac test run covers it (quoting, path encoding, process-table parsing). Only the thin system calls are behind `cfg(windows)`.

## Design choices

**Transport: AF_UNIX on Windows, not named pipes.** Windows 10 1803+ has Unix-domain sockets; the `uds_windows` crate gives `UnixStream`/`UnixListener` with the same shape as std (connect, bind, `try_clone`, `shutdown`, timeouts). Every socket user here runs a reader thread and a writer thread on one connection. A synchronous named-pipe handle serializes reads and writes on the same file object, so that pattern deadlocks, and overlapped I/O would be a rewrite of runner, harness and session MCP. With AF_UNIX the code keeps its shape behind one alias module (`ipc.rs`).

**Identity stays as strong as on macOS (D5a).** Every check fails closed.
- Peer pid: `WSAIoctl(SIO_AF_UNIX_GETPEERPID)` on the accepted socket.
- Same user: the peer process token's user SID equals ours (`OpenProcessToken` + `GetTokenInformation(TokenUser)` + `EqualSid`). This replaces the uid check.
- Program: `QueryFullProcessImageNameW`, compared with `current_exe` after `dunce::canonicalize`.
- Parent: `CreateToolhelp32Snapshot` `th32ParentProcessID`. Windows reuses pids and does not re-parent orphans, so a parent only counts when its creation time (`GetProcessTimes`) is earlier than the child's; otherwise the walk stops (unknown caller).
- Pid reuse (planner decision after the W2 review): the peer pid is taken at connect time, as with `LOCAL_PEERPID`/`SO_PEERCRED` on macOS and Linux, so a connector that exits can have its pid reused. Windows closes that window: the server notes the time just before `accept` returns, opens the peer process by pid and keeps that handle for every later check (SID, image, parents), and refuses the caller unless the process's creation time (`GetProcessTimes`) is earlier than that accept time. A process that took over the pid was created after the connector exited, so it fails this check. What stays possible is what is already possible on macOS: a same-user program handing its connection to another process, and on Windows also creating a process with a chosen parent (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`). Both need a deliberate program, not one plain command. The accept-time rule leaves one window: a connection that waits in the listen backlog, whose connector exits and whose pid is reused by a process that looks trusted before `accept` returns. Closing it would need the pid bound to the socket, which Windows AF_UNIX does not offer; accepted by the operator on 2026-11-16 (option a): same-user programs are not walled off from each other (D5a), parent spoofing already reaches the same result without any race, and macOS has the whole race unmitigated. Possible later hardening, not planned: a per-session secret handed to hosted processes and presented on connect. The parent walk is three-valued: a session ancestor found, no session ancestor (the chain reached a process outside every session, all links checked), or unknown (a link could not be opened, failed the creation-time rule or the walk hit its limit); unknown is refused, never taken as outside; D5a and `peer.rs` say these checks are not a wall between same-user programs.
- Access to the socket files: the inherited `%LOCALAPPDATA%` ACL is not trusted (profiles can be migrated or customized). The security descriptor for the config dir is: owner = current user's SID; protected DACL (`SE_DACL_PROTECTED`, nothing inherited from above) with one allow ACE, full control for that SID, flags `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`, so files, sockets and subfolders created inside inherit it. `private_dir` on Windows: if the dir does not exist, it is created with that descriptor in the same call (`CreateDirectoryW` with `SECURITY_ATTRIBUTES`), before any secret or socket exists. If it exists, nothing is changed: it is checked (not a reparse point, owner is the user, DACL protected, every allow ACE is for the user's SID) and anything else is an error that names the folder; the runner, service and session MCP then do not start (fail closed, never repaired silently). `private_file` runs the same check for one file. Every place that creates the config dir on Windows (`get_config_dir` and the services) goes through `private_dir`, so the app never creates it with the inherited ACL first. Until W3 implements this, the Windows bodies return an error. The per-connection SID check stays as a second gate, like the uid check on macOS.

**Config dir on Windows is `%LOCALAPPDATA%\agent-mcr`**, not Roaming: it holds sockets, SQLite and logs, none of which may roam.

**Runner and service outlive the app (D1)** without a LaunchAgent: the app starts them detached (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`, retried without the breakaway flag when the parent job forbids it). No scheduled task, no Windows service.

**Agent launch.** There is no login shell. portable-pty re-quotes every argv element with CRT rules (`"` becomes `\"`), which cmd.exe does not understand, so the line cannot be passed as an argument. Agents run as argv `cmd.exe /d /v:off /c %AMCR_LAUNCH%` with the encoded line in the environment variable `AMCR_LAUNCH` of that process: the last argument has no space or quote, so portable-pty passes it verbatim; cmd.exe sees no leading quote, so it strips none, and expands the variable before it parses the line (expansion is not rescanned, and `%` is refused anyway). If a real Windows run shows otherwise, the fallback is the same line written to `launch-<session>.cmd` in the private config dir and run as `cmd.exe /d /v:off /c <path>`. This finds `claude`, `codex` and `agy` through `PATH` and `PATHEXT` whether they are `.exe` or npm `.cmd` shims. cmd.exe expands `%VAR%` even inside quotes and npm shims re-parse `%*`, so:
- encoding (pure function `cmd_line`, specified here so the reviewer can check it): every argument, including the program name, is wrapped in double quotes; an empty argument is `""`; backslashes are literal except a run of backslashes at the end of an argument, which is doubled so the closing quote is not escaped under the CRT/`CommandLineToArgvW` rules; arguments joined by one space; no outer wrapping (no `/s`);
- refusals: an argument containing `"`, `%`, CR, LF or NUL makes the launch fail (nothing runs). With `"` refused, cmd.exe's quote state never toggles inside an argument, so `& | < > ^ ( )` stay inert in both cmd.exe's parse and the npm shim's `%*` re-parse; `%` is refused because cmd.exe expands it even inside quotes; `!` is inert because of `/v:off`;
- free text (the first task, Antigravity's `--prompt-interactive`) never goes into argv on Windows: it is typed into the terminal when the agent is ready, as later tasks already are;
- JSON in Codex `-c` values is written as TOML literal strings (single quotes, no escapes), so no `"` is needed;
- no `exec` prefix.
Claude hook commands use `"<exe with forward slashes>" --harness-hook <Event>`, which both Git Bash and cmd.exe run. The shell profile is `powershell.exe -NoLogo`.

**Signals.** `INT` writes `0x03` to the ConPTY input. `HUP`, `TERM` and `KILL` end the session's job object (`TerminateJobObject`) and close the pseudoconsole. The child is assigned to a per-session job right after spawn (portable-pty cannot start it suspended); if creating or assigning the job fails, the child is killed and the spawn fails. Termination errors are returned to the caller. Known limit: a process the child starts in the microseconds before assignment is not in the job; it still loses its console when the pseudoconsole closes. This matches macOS, where a process that calls `setsid` leaves the group `killpg` reaches. A test checks that a known descendant pid has exited after `TERM`.

**Process table** (`process_table`, running shells): `sysinfo` as a Windows-only dependency (pid, parent, command line, CPU time, start time). The shell matcher also recognizes `bash.exe -c` (Claude Code uses Git Bash), `powershell.exe`/`pwsh.exe -Command` (Codex) and `cmd.exe /c`.

**Notifications.** The service's "session waits" notification is a no-op on Windows for now; the Live list and Board still show it. (Same as Linux today.)

**Out of scope.** Code signing (SmartScreen will warn), an updater (MCR-24), D8 worktrees (not built on any platform), ARM64 builds.

## Team and workflow (operator decision, 2026-11-16)

Update: Codex usage ran out; the Codex reviewer and executor B ended after B's track was complete (branches converged at fe6f81b). Review continues with "Windows port: reviewer 2" (Antigravity); executor A takes any remaining follow-ups, CI fixes and R3. From a74f2db on, A pushes `windows-port` to the `ci` remote itself (never `origin`), watches the runs with `gh` and reports results to the planner; the Supervisor only observes.

- Executor A ("Windows port: executor", Antigravity): worktree `agent-mcr-windows`, branch `windows-port`. Track: W2–W7 (W7 moved back from B by the operator once A was free) and R1–R3, and the final merge.
- Executor B ("Windows port: executor B", Codex): worktree `agent-mcr-windows-b`, branch `windows-port-b` (from 9116835). Track: W8, W9, W10, W11 (moved forward by the operator), W12.
- Pipeline: an executor starts its next task as soon as it reports a commit; review fixes come as follow-up commits. At most one unreviewed task per executor ahead of the reviewer.
- Review: the executor runs the scoped gate. Before a task is released, the planner asks the reviewer what it will check and writes the answers into the task text, aiming at one review round per task. The reviewer re-runs only `cargo xwin clippy` (plus `cargo test` when the diff touches Rust tests) and reads the diff closely. The full gate runs on every merge and at the final check.
- File ownership, to keep merges small: `harness.rs`, `runner.rs`, `peer.rs`, `ipc.rs`, `agents*`, `session_mcp.rs`, `session_analysis_commands.rs`, `Cargo.toml`/`Cargo.lock` belong to A. `agent.rs`, `sessions.rs`, `session_memory.rs`, `src/`, `tauri.conf.json`, `package.json`, `.github/`, `CLAUDE.md`, `README.md`, `docs/SESSION_ANALYSIS_MCP.md`, `docs/AGENT_HARNESS_DESIGN.md` belong to B. `main.rs` is shared: A owns `get_config_dir` and the `--runner`/`--harness`/`--mcp` branches; B owns `session_folders`, the Access path checks (W8) and the `tauri::Builder` run error path (W10). `docs/WINDOWS_PORT.md`: the planner edits the plan; A writes only under "Wine findings". A needed change in a file the other owns goes to the planner, who hands it to the owner. B collects doc notes from A's commits for W12.
- Merges (operator decision): W12 (docs) comes last: when A reports W7, B merges `windows-port` into `windows-port-b` and writes the docs against the merged code. Then, A merges `windows-port-b` into `windows-port` once and runs the full gate. No other intermediate merges.

## Remotes

`ci`: private repo `vadimchirkov/agent-mcr-windows`, where CI runs; executor A pushes `windows-port` there. `origin` (`lambda-house/agent-mcr`) has branch `windows-port`, first pushed by the Supervisor at 951dbb9 (operator decision, 2026-11-17); only the Supervisor or the operator updates it. Executors never push to `origin`.

## Tasks

| Id | Goal | Files | Acceptance |
|---|---|---|---|
| W1 | Windows build compiles, failing closed. Add target deps (`windows-sys` with the needed features, `uds_windows`, `sysinfo`), `ipc.rs` with `Stream`/`Listener` aliases (std on Unix, `uds_windows` on Windows) and `private_dir`/`private_file`/`is_socket` helpers; switch every `std::os::unix::net` use to it. Windows bodies that are not done yet return an error or `None` (peer checks deny), never allow. Unix behaviour unchanged | `Cargo.toml`, `ipc.rs` (new), `main.rs`, `runner.rs`, `peer.rs`, `harness.rs`, `harness_commands.rs`, `harness_preferences.rs`, `session_mcp.rs`, `sessions.rs` | Full gate, including `cargo xwin clippy` with no warnings. `grep -rn 'std::os::unix' src-tauri/src` shows only `cfg(unix)` code. No `#[allow(dead_code)]` added to hide Windows gaps |
| M1 | Merge `plugins` (at least d76cee6: `terminal_write` `submit`, shared deliver helper, inbox notices for untracked agents) into `windows-port` after W1 is approved, so W5/W6 work on the current `harness.rs`. New Unix-only code from the merge gets the W1 treatment (compiles for Windows, fails closed) | merge commit | Gate, including `cargo xwin clippy`. No change in behaviour on macOS beyond what `plugins` brings |
| W2 | Process identity on Windows as specified above (`credentials`, `same_user`, `parent` with the creation-time rule, `program`, `is_this_program`) | `peer.rs` | Gate. The existing peer test runs on Windows too (`cfg` removed or mirrored). Code review confirms every failure path returns `None`/`false` |
| W3 | Private config dir on Windows: `private_dir`/`private_file` set and verify the DACL as specified above, failing closed. Config, cache and socket paths. `get_config_dir` uses `data_local_dir` on Windows; attachments under `cache_dir`; check every `dirs::` use and every hard-coded `/` or `~/Library` path in Rust | `main.rs`, `harness.rs`, `harness_commands.rs`, `session_analysis_commands.rs` | Gate. `cfg(windows)` tests: a new dir from `private_dir` reads back as owner = user, protected, exactly one allow ACE for the user with both inherit flags, and a file created inside inherits it; an existing dir with an extra ACE (e.g. Everyone read) or that is a junction is refused, not repaired. A pure-function test for the chosen dirs per platform where practical |
| W4 | Runner on Windows: detached start of runner and service (`runner::start`), signals, tests that spawn `/bin/sh`/`/bin/true`/`nc` get Windows equivalents (`cmd.exe /c`) or are `cfg(unix)` with a reason | `runner.rs` | Gate. Windows tests compile; list in the commit which tests are Unix-only |
| W5 | Agent launch on Windows as specified above: `argv_for`, a pure `cmd_line` quoting function with tests (refusals for `"`, `%`, CR, LF; spaces; `&`, `^`, `<`), Codex `-c` values as TOML literals, Claude hook command form, first task and agy prompt typed instead of argv, shell profile | `harness.rs`, `agents.rs` | Gate. New Mac-run tests cover the Windows command lines of Claude, Codex, agy and shell, launch and resume, supervisor included, and `cmd_line` (empty argument, trailing backslash, spaces, `& \| < > ^ ( ) !`, each refusal). A `cfg(windows)` integration test spawns real lines through portable-pty's `CommandBuilder` exactly as the runner does (argv and environment from `argv_for`), into a probe program that prints its argv as JSON (an example binary, `examples/argv_probe.rs`), directly and through a generated npm-style `.cmd` shim (`@"%~dp0argv_probe.exe" %*`), and asserts argv is preserved exactly. It runs in the Windows CI job (W11) and under Wine (R2) |
| W6 | Harness service on Windows: `process_table` via `sysinfo` behind a pure parser/mapper, shell matcher for `bash.exe -c`, `powershell -Command`, `cmd /c`; `notify_user` no-op; `serve`, `tool_cli` and `bridge` on the alias types | `harness.rs` | Gate. Matcher tests with Windows command lines |
| W7 | Session analysis MCP over the same transport on Windows (`--mcp` bridge, app socket, revocation closing sockets) | `session_mcp.rs`, `session_analysis_commands.rs`, `main.rs` | Gate. The `cfg(not(unix))` stubs are gone; the stream test runs on both |
| W8 | Windows paths in the indexers and the agent workspace: Claude's `projects/<encoded>` names for `C:\…` folders, `session_folders` home exclusion, transcript `cwd` values with backslashes and drive letters, `is_agent_document` / `classify_rel` with `\` separators | `agent.rs`, `sessions.rs`, `session_memory.rs`, `main.rs` | Gate. Tests with Windows-style paths on pure functions |
| W9 | Frontend paths: one separator-agnostic helper set (basename, short path with `~` for `C:\Users\<name>`, parent) used by `LiveWorkspace`, `StatusBar`, `SessionResults`, `SessionWorkspace`, `SessionCommandPanel`, `utils/harness.ts`, `utils/sessions.ts`; the Live folder input accepts `C:\…` | `src/utils/paths.ts` (new) and the files named | `npm run build`, `npm test` with new tests for Windows paths |
| W10 | Installer and missing WebView2: `tauri.conf.json` bundle targets add `nsis` (`installMode: currentUser`), `windows.webviewInstallMode` `downloadBootstrapper` (or `embedBootstrapper`), `windows` section; when WebView2 is missing the app shows a native error dialog instead of panicking (the `tauri::Builder` `run` error path in `main.rs`, which B may change for this), CSP checked for `http://localfile.localhost` and `http://ipc.localhost`; `npm run build:win`; capabilities checked | `tauri.conf.json`, `package.json`, `capabilities/` | Gate. `npx tauri build --bundles nsis --target x86_64-pc-windows-msvc --runner cargo-xwin` is attempted; its result goes in the commit message (a cross-built installer is not required to pass) |
| W11 | CI (operator decision: runs in the private repo `vadimchirkov/agent-mcr-windows`, remote `ci`; the Supervisor pushes, executors never push). Triggers: push to `windows-port` and `windows-port-b`, plus `workflow_dispatch`, besides the existing ones. Keep the Linux job; add `windows-latest`: `npm ci`, `npm run build`, `npm test`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` (runs the `cfg(windows)` tests). Optional step: build the NSIS bundle and upload it as an artifact. `package.json` depends on the private `teob-cc/teob-ui`: before `npm ci` in both jobs, `git config --global url."https://x-access-token:${TEOB_UI_TOKEN}@github.com/teob-cc/".insteadOf "https://github.com/teob-cc/"` with the secret `TEOB_UI_TOKEN` (a read-only fine-grained token the operator creates); the token never appears in logs | `.github/workflows/ci.yml` | YAML reviewed. After the Supervisor pushes, the Windows job's result is reported; its failures become follow-ups of the task they belong to |
| W12 | Docs: CLAUDE.md (platform notes, transport, launch, gate), `SESSION_ANALYSIS_MCP.md`, `AGENT_HARNESS_DESIGN.md` (D12 amended for the Windows gate, "What differs" row for D4), README build steps for Windows | docs | Reviewer reads them against the code |

### Review checklists (from the reviewer, written into the tasks)

- **W5**: exact argv through an `.exe` and through a real npm-style `.cmd` shim: empty arguments, spaces, Unicode, trailing backslashes, shell metacharacters; refusals for `"`, `%`, CR, LF, NUL; no command injection on any path. The first prompt arrives verbatim, once, when the agent is ready, for launch, resume and the supervisor. Hook commands run under Git Bash and under cmd.exe. Program lookup through `PATH`/`PATHEXT`. macOS command lines unchanged (existing tests untouched).
- **W6**: pid and parent mapping; CPU time and start time units (match what the Unix `ps` path produces); processes missing or exited mid-scan; shell paths with spaces, quotes and mixed case; option variants (`-c`, `-Command`, `-command`, `/c`, `/C`, `-EncodedCommand` not shown as text); descendants only, filtering of MCP servers and the bridge as on macOS; `serve`/`tool_cli`/`bridge` stay non-blocking with reconnect after a service restart; macOS unchanged.
- **W7**: same-user admission and caller handling on every connection; private dir, stale socket replacement and refusal of a non-socket or reparse point at the socket path; frame size bounds; parallel readers and writers; grant and revoke racing active requests; revocation closes every active stream; restart and reconnect; Windows paths. Tests on Windows (`cfg(windows)`) and Unix.

## CI follow-ups (first real Windows test run, 2026-11-16, run 43969269489 on 63f609f)

`cargo test` ran on Windows for the first time and hit the 10-minute step limit. Tasks for executor A, in this order (the hang first, so later tests report). Each is a separate commit; A pushes `windows-port` to `ci` after each and reads the new run with `gh`; reviewer 2 reviews each. A failure under Windows is first a question about the code, then about the test: say which in the commit message.

| Id | Failure | Task |
|---|---|---|
| CI-6 (done 5972e70, approved; CI result pending) | `session_mcp::socket_tests::live_socket_protocol_and_revocation` hangs. Cause: on Windows AF_UNIX `shutdown()` does not unblock a thread already in `recv()`. Fix: 100 ms read timeout under `cfg(windows)` plus a `Service::generation` counter bumped in `revoke()`, which `read_frame_with_abort` checks; the test has a 10 s channel timeout | Find the blocked accept/read after revocation on Windows. Fix the cause (revocation must close every active stream and wake the accept loop; on Windows, shutting a `uds_windows` socket does not unblock a thread blocked in `accept` or `read` on another clone: use a non-blocking accept with a short poll, read timeouts, or a self-connect wake-up). Give the test its own timeout so a hang fails in seconds |
| CI-1 | `owner is not the current user` for files, sockets and dirs created in a fresh private dir: `ipc::win::tests::new_private_dir_has_protected_user_only_dacl_and_file_inherits` (ipc.rs:416), runner tests `a_second_runner_refuses…`, `control_writes_resizes_and_signals`, `spawn_attach_type_replay_and_exit` | Cause: a process of a member of Administrators creates objects owned by `BUILTIN\Administrators` (the token's default owner, `TOKEN_OWNER`), not by the user SID; the GitHub runner and real admin users are such. Decision (planner, security unchanged): the DACL is the gate. `private_dir` on creation sets the owner to the user SID (already so); the check accepts an owner equal to the user SID **or** to the token's default owner (`GetTokenInformation(TokenOwner)`), and nothing else (no Everyone, no other user, no SYSTEM unless it is the token's own default). Files and sockets created inside inherit the DACL; `private_file` checks the DACL by the same rule, not the owner alone. Fail closed on every query error. Tests: owner = user, owner = token default, owner = another SID (refused), widened DACL (refused) |
| CI-3 | `harness::tests::windows_cmd_line_preserves_argv_through_cmd_and_npm_shim`: `argv_probe.exe missing at …\target\debug\build\…\examples\argv_probe.exe` | The test must not assume the example is built. Build it from the test (`cargo build --example argv_probe` with `CARGO_TARGET_DIR` from `CARGO_TARGET_DIR` or the test exe's `../../` layout) or locate it relative to `std::env::current_exe()` (`target/debug/examples/`), and CI builds examples first (`cargo build --locked --examples`) before `cargo test` |
| CI-2 | `peer::tests::a_connection_from_this_process_is_recognised`: `same_user(&a)` false (peer.rs:553) | Find out why: the connecting side's pid from `SIO_AF_UNIX_GETPEERPID`, `OpenProcess` access rights, or the token-user comparison (`same_user_handle`). If it is the Administrators default-owner effect from CI-1, it is not: `same_user` compares TokenUser, not owner. Must pass in CI without loosening the check; a wrong SID comparison or a handle opened without `PROCESS_QUERY_LIMITED_INFORMATION` is the usual cause |
| CI-4 | `harness::tests::launches_carry_hooks_session_ids_and_quoted_tasks` (expects single quotes), `notes_reach_the_sessions_of_their_folder_until_they_expire` (`claude,0,1,1` vs `0,2,1`), `peers_are_the_live_sessions_a_session_exchanged_messages_with` (`[]` vs `["b","c"]`) | The first is a test assumption: on Windows the line is double-quoted `cmd_line`; assert the Windows form under `cfg(windows)`. The other two may be real bugs: `folder_relation` and the folder/`cwd` matching in `harness.rs` with Windows paths (separators, case, drive letters, `\\?\` prefixes from `dunce`/canonicalize, a test using `/tmp`-style folders). Decide from the code; fix the matching with tests on Windows-style paths that also run on the Mac |
| CI-5 | `session_analysis` tests (`correlates_…`, `legacy_checkpoints_…`, `pagination_…`, `restart_…`, `skill_observations_…`): `Os error 32` (file in use) | Windows refuses to rename, delete or reopen a file with an open handle. Find the open handle (SQLite pool or connection not closed before the index is replaced or reopened, a transcript file held while it is rewritten, `TempDir` removed while open). Real bug if the app replaces the index while a connection is open: close first. If only the test, close handles before the step |

| CI-7 | Found in the CI-3 review: ConPTY sends `\x1b[6n` (cursor position request) at start and may hold the child's output until it is answered. In the app xterm.js answers when a view is attached; `runner.rs::pump` answers nothing | On Windows the runner answers `\x1b[6n` with `\x1b[1;1R` on the master writer **only while no view is attached** (`out.views.is_empty()`), so headless sessions (supervisor/task launches, app closed) start; with a view attached the view answers (a second answer would be typed into the agent as input). Detect the request across read-chunk boundaries (keep a 3-byte carry); answer once per request. Test with a fake pty stream: split request, request with view, request without view |

Rules for every CI-n: no test may block without a timeout (a hang hides the rest of the suite; give every spawned child, socket read and channel wait a bounded wait and kill the child on timeout); push only when no CI run for `windows-port` is in progress (`cancel-in-progress` cancels the earlier run and loses its results); read each run's `cargo test` summary and failing names with `gh run view --log-failed`.

When all six pass in CI, A runs the full five-check gate on the final sha and reports; reviewer 2 gives the final approval.

## Runtime tests under Wine (Rum)

Real Windows is not available here. The app is run under Rum 2.0.0-beta.1 (`/Applications/Rum.app`, a Wine wrapper). CLI: `/Applications/Rum.app/Contents/Resources/RumCmd` (not on `PATH`): `list`, `create <name>`, `run <bottle> <path.exe> [args]`, `shellenv <bottle>` (env exports to run `wine` directly, e.g. with `WINEDEBUG`). Use a dedicated bottle `agent-mcr-test`; leave `Default` alone.

Build with `cargo xwin build --target x86_64-pc-windows-msvc` (x86_64 only: Wine on Apple Silicon runs x64 through Rosetta). Tauri needs WebView2 in the bottle; try the Evergreen standalone or the fixed-version runtime.

Wine differs from Windows (ConPTY, AF_UNIX and its `SIO_AF_UNIX_GETPEERPID`, process tokens, WebView2). A failure under Wine is not proof of a code bug: record each one with the exact console/log output in "Wine findings" below, decide whether it is ours, and if not, keep the case on the real-Windows list. Fail-closed identity checks refusing under Wine are expected if Wine lacks the ioctl; they must not be loosened for Wine.

| Id | After | Goal | Acceptance |
|---|---|---|---|
| R1 | W1 | Smoke run: bottle `agent-mcr-test`, WebView2 installed, debug build started with `RumCmd run`, console captured | The window opens and the Documents view renders, or the exact errors are in Wine findings with a verdict (ours / Wine / WebView2) |
| R2 | — | Dropped (Wine has no AF_UNIX, see Wine findings). Was: harness under Wine, command line only: `agent-mcr.exe --runner` and `--harness` start and create their sockets in a private config dir; `--harness-tool list_peers` from outside is refused; the `argv_probe` test lines through `cmd.exe`; session MCP `--mcp` connects or fails closed | Each step's result and output in Wine findings |
| R3 | W10 | The NSIS installer runs in a clean bottle (installs files, WebView2 bootstrapper step attempted); the UI is not judged under Wine | Result in Wine findings |

### Wine findings

- **R1 (smoke run, commit `9116835`)**:
  - Bottle: `agent-mcr-test` (Windows 10, Rum 2.0.0-beta.1).
  - WebView2: Evergreen bootstrapper (`MicrosoftEdgeWebview2Setup.exe /silent /install`) exited 0 without installing; standalone x64 installer (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install`, `linkid=2124701`) installed `EdgeWebView\Application\157.0.4341.60` cleanly.
  - Build: `npm run build` + `cargo xwin build --target x86_64-pc-windows-msvc` (debug, `custom-protocol` default).
  - Run: `agent-mcr.exe` started and stayed running alongside `msedgewebview2.exe` (`--embedded-browser-webview=1 --webview-exe-name=agent-mcr.exe --user-data-dir=C:\users\vadim\AppData\Local\cc.lambdahouse.agent-mcr\EBWebView` and `crashpad-handler`); `EBWebView` initialized (`Default`, `Local State`, `Last Version` created). Zero Rust panics or app errors on stdout/stderr (`WINEDEBUG=-all`); `WINEDEBUG=err+all` showed only standard Wine stubs (`NtQueryInformationToken` class 39, `SetPreferredAppMode`, `UIViewSettings`, `RegisterPowerSettingNotification`).
  - Verdict: **inconclusive (visual rendering unverified)**: `screencapture -x` failed (`could not create image from display`, exit 1 — lacks Screen Recording permission), so window opening and Documents view rendering were not visually observed. Partial evidence retained: process survival and `EBWebView` profile initialization with zero app errors.
- **R1 result from the operator and Supervisor (observed on screen)**: in bottle `Default` (no WebView2) `agent-mcr.exe` exits with status 101 (Rust panic). In `agent-mcr-test` (WebView2 157.0.4341.60) the window opens but stays empty, also with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-gpu --disable-gpu-compositing --no-sandbox"`; processes stay alive, no app errors (only Wine stubs: `NtQueryInformationToken` 33/39, ole `ensure_mta` 0x800401f0, `RoGetActivationFactory`). Launch that works: `eval "$(RumCmd shellenv agent-mcr-test)"; "$WINELOADER" <exe>` (`RumCmd run` exits silently; `nohup` strips the `DYLD_` variables). Verdict: Wine/WebView2, not ours. **Wine cannot verify the UI**; it is used only for non-UI checks (R2). UI verification moves to real Windows (W11 CI or a VM; operator decides).
- **Test run under Wine (Supervisor, windows-port at 2027d21)**: `cargo xwin test --target x86_64-pc-windows-msvc` with `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER=$HOME/.local/bin/agent-mcr-wine-run` (separate `CARGO_TARGET_DIR`), bottle `agent-mcr-test`: 58 passed, 7 failed. Every socket test fails with `WSAEAFNOSUPPORT` (os error 10047) on bind/connect: this Wine build (Sikarugir 10.0_8) has no AF_UNIX (`peer::a_connection_from_this_process_is_recognised`, `runner::{a_second_runner_refuses_the_socket…, control_writes_resizes_and_signals, spawn_attach_type_replay_and_exit}`, `session_mcp::framing_bounds_and_missing_app`). Both DACL tests fail (`ipc.rs:392`, `:523`): Wine's ACL emulation, not evidence against W3. Pure-logic tests pass (quoting, paths, parsers). Verdict: Wine. **R2 is dropped**: the harness cannot run under this Wine at all. Wine stays an optional runner for pure tests only; sockets, DACLs, identity and ConPTY stay on the real-Windows list.
- **R3 (NSIS installer, commit `a74f2db`)**:
  - Build: `PATH="/opt/homebrew/opt/llvm/bin:$PATH" npx tauri build --bundles nsis --target x86_64-pc-windows-msvc --runner cargo-xwin` produced `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Agent MCR_0.1.0_x64-setup.exe` (7.91 MiB).
  - Bottle: fresh clean bottle `agent-mcr-r3` (created with `RumCmd create agent-mcr-r3`).
  - Run: `"Agent MCR_0.1.0_x64-setup.exe" /S` exited with status 0.
  - Result: installed `agent-mcr.exe` (21,692,928 bytes) and `uninstall.exe` (79,223 bytes) into `C:\users\vadim\AppData\Local\Agent MCR\`; launched the WebView2 bootstrapper (`MicrosoftEdgeWebview2Setup.exe` -> `MicrosoftEdgeUpdate.exe`) and installed WebView2 Runtime `157.0.4341.60` into `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\157.0.4341.60`. Verdict: pass (files and WebView2 bootstrapper verified; UI not judged under Wine).

## Verification status

Cross-clippy and Mac tests prove that Windows code compiles and that the pure functions are right; they do not prove Windows behaviour. A task whose acceptance includes a `cfg(windows)` test (W2, W3, W5, W7) is approved for the Mac gate only and stays marked "Windows-unverified" until that test has run green on Windows (the CI job of W11, which needs a push the operator decides on, or a real Windows machine). Wine runs (R1–R3) are supporting evidence, not proof. The final report lists each task's status.

### Status (planner's record)

| Task | Commits | Review | Windows runtime |
|---|---|---|---|
| W1 | 38aa0df (code part), 2e12eed | Approved | n/a (compile) |
| M1 | 9116835 | Approved | n/a |
| W2 | d351047, da8f787, 9139a7a, b902636, 27974b9 (clippy) | Code reviewed; pid race accepted by the operator (221f392) | Unverified (CI) |
| W3 | 1bc76ce, c6a8a7e | Approved, Mac gate | Unverified (CI): DACL tests |
| W4 | 4df92a9, 4618a56, 59eb453, 898dc3d, b902636 | Failure handling accepted; pre-assignment race documented as a known limit | Unverified (CI): descendant test |
| W5 | dc1d3f8, 27974b9 (+ test gating in 60fea4c) | Mac gate passed at 60fea4c; code conditionally accepted | Unverified (CI): ConPTY argv_probe and shim |
| W6 | 60fea4c | Approved | Unverified |
| W7 | 2bc9013 + follow-up pending | Not approved: Unix symlink regression, Windows test setup | Unverified |
| W8 | 5f8e778 | Approved | Unverified (CI) |
| W9 | a6d5d0d, 06fe06a | Approved | Unverified (UI on Windows) |
| W10 | 44ebe8f | Approved | Unverified: installer, error dialog |
| W11 | 07ca075 (= 315dc73 on windows-port) | Approved | First runs failed at `npm ci` (no credentials); SSH deploy-key fix pending |
| W12 | pending | | |
| R1 | b9c9239, 476a395 | Inconclusive (Wine shows an empty window) | |
| R2 | | Dropped (no AF_UNIX in Wine) | |
| R3 | pending (after the final merge) | | |

## Manual test list (needs a real Windows 10 1903+ / 11 machine)

1. Install with the NSIS installer as a normal user; app starts; WebView2 present; no SmartScreen bypass needed beyond "Run anyway".
2. Documents view: agent workspace grant, `%USERPROFILE%\.claude` and `.codex` files listed; file watching updates; images through `localfile`.
3. Live: start Claude, Codex, agy and shell sessions in a folder with a space in its path; `claude`/`codex` found whether installed as `.exe` or npm `.cmd`; agents see the user's PATH.
4. Quit the app: sessions keep running; reopen: terminals reattach with scrollback. Runner exits after 10 idle minutes.
5. Hooks: Claude state goes working → idle → waiting on a permission prompt; Codex turn ends tracked; `--harness-hook` prints nothing.
6. Interrupt (Escape for Claude, Ctrl-C path for others) and Close session; Restart resumes the conversation.
7. Tasks typed when idle, including the first task (typed, not argv); text with `&`, `%`, `"` and `^` arrives verbatim.
8. `mcr` tools between two sessions: list_peers, send_message, ask/reply, report, bulletin; a process outside the harness (plain PowerShell running `agent-mcr --harness-tool list_peers`) is refused.
9. Supervisor session and `--supervise` from an outside Claude with the setting off (refused) and on.
10. Running shells under a session (Git Bash and PowerShell commands), quiet marking.
11. Session analysis MCP: grant, an outside client over `--mcp`, revocation drops it.
12. Sessions workspace index and Journal with Windows transcripts; Claude memory for `C:\` projects grouped under the right folder.
13. Pasted image into a terminal; attachment path typed correctly.
14. ACL: the config dir's DACL has only the user (`icacls`); a second, non-admin Windows user cannot connect to `runner.sock`, `harness.sock` or the analysis socket, nor read `harness-state.json`. A config dir whose DACL was widened by hand makes the service refuse to start.
15. Launch quoting on real Windows: the `argv_probe` integration test passes; a folder and a user name containing `&`, `^` and a trailing space launch correctly.
16. A user name with a space and one with non-ASCII letters (paths in config dir and argv).

## Caller states on Windows (peer.rs, read 2026-11-17, not run on Windows)

`Peer::ancestor_among` walks parents with `CreateToolhelp32Snapshot`, checking each parent's creation time against the child's (Windows does not re-parent orphans and reuses PIDs). The runner (`Runner::trusts`) and the service (`Harness::who`, control ops) require `Outside` plus `is_this_program`.

Before this fix `Outside` was reached only at a pid of 4 or below. A parent that had exited (`explorer.exe` → `userinit.exe` is the usual end of a user's chain), could not be opened, or had a later creation time all gave `Unknown`. So an app started from Explorer would likely have been classed `Unknown` and refused by its own runner and service, and nothing was Outside in practice. This is inferred from the code, not observed.

Now a recorded parent that is gone (`ERROR_INVALID_PARAMETER`), not openable by this user (`ERROR_ACCESS_DENIED`), reused (created after the child) or recorded as 0 ends the walk as `Outside`, the same as reaching launchd on Unix. Any other error, a failed snapshot, or the process itself missing from the snapshot stays `Unknown` and is refused. `Found` is unchanged.

Residual, same as on macOS: an orphan left by a hosted session whose parent exited is `Outside` and passes if it is this program's executable and the same user. Not a wall between same-user programs (D5a, D13).

Needs a real Windows machine or CI: start the app from Explorer and from a terminal, check that the app reaches the runner (`hello`, `list`, `spawn`) and the service; from a hosted session run `agent-mcr --harness-tool whoami` and check it is a `Session`, not `Outside`; check a process started by a hosted session that outlives its parent gets `Outside` only for control ops it still cannot pass (`is_this_program`).
