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
- Pid reuse (planner decision after the W2 review): the peer pid is taken at connect time, as with `LOCAL_PEERPID`/`SO_PEERCRED` on macOS and Linux, so a connector that exits can have its pid reused. Windows closes that window: the server notes the time just before `accept` returns, opens the peer process by pid and keeps that handle for every later check (SID, image, parents), and refuses the caller unless the process's creation time (`GetProcessTimes`) is earlier than that accept time. A process that took over the pid was created after the connector exited, so it fails this check. What stays possible is what is already possible on macOS: a same-user program handing its connection to another process, and on Windows also creating a process with a chosen parent (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`). Both need a deliberate program, not one plain command. The accept-time rule leaves one window: a connection that waits in the listen backlog, whose connector exits and whose pid is reused by a process that looks trusted before `accept` returns. Closing it would need the pid bound to the socket, which Windows AF_UNIX does not offer; it is accepted because parent spoofing already reaches the same result without any race, and macOS has the whole race unmitigated. The parent walk is three-valued: a session ancestor found, no session ancestor (the chain reached a process outside every session, all links checked), or unknown (a link could not be opened, failed the creation-time rule or the walk hit its limit); unknown is refused, never taken as outside; D5a and `peer.rs` say these checks are not a wall between same-user programs. The operator can overrule this decision.
- Access to the socket files: the inherited `%LOCALAPPDATA%` ACL is not trusted (profiles can be migrated or customized). The security descriptor for the config dir is: owner = current user's SID; protected DACL (`SE_DACL_PROTECTED`, nothing inherited from above) with one allow ACE, full control for that SID, flags `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`, so files, sockets and subfolders created inside inherit it. `private_dir` on Windows: if the dir does not exist, it is created with that descriptor in the same call (`CreateDirectoryW` with `SECURITY_ATTRIBUTES`), before any secret or socket exists. If it exists, nothing is changed: it is checked (not a reparse point, owner is the user, DACL protected, every allow ACE is for the user's SID) and anything else is an error that names the folder; the runner, service and session MCP then do not start (fail closed, never repaired silently). `private_file` runs the same check for one file. Every place that creates the config dir on Windows (`get_config_dir` and the services) goes through `private_dir`, so the app never creates it with the inherited ACL first. Until W3 implements this, the Windows bodies return an error. The per-connection SID check stays as a second gate, like the uid check on macOS.

**Config dir on Windows is `%LOCALAPPDATA%\agent-mcr`**, not Roaming: it holds sockets, SQLite and logs, none of which may roam.

**Runner and service outlive the app (D1)** without a LaunchAgent: the app starts them detached (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`, retried without the breakaway flag when the parent job forbids it). No scheduled task, no Windows service.

**Agent launch.** There is no login shell. Agents run as `cmd.exe /d /v:off /s /c "<command line>"`, which finds `claude`, `codex` and `agy` through `PATH` and `PATHEXT` whether they are `.exe` or npm `.cmd` shims. cmd.exe expands `%VAR%` even inside quotes and npm shims re-parse `%*`, so:
- encoding (pure function `cmd_line`, specified here so the reviewer can check it): every argument, including the program name, is wrapped in double quotes; an empty argument is `""`; backslashes are literal except a run of backslashes at the end of an argument, which is doubled so the closing quote is not escaped under the CRT/`CommandLineToArgvW` rules; arguments joined by one space; the whole line wrapped once more in quotes for `/s /c`;
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

- Executor A ("Windows port: executor", Antigravity): worktree `agent-mcr-windows`, branch `windows-port`. Track: W2–W6 and R1–R3, and the merges.
- Executor B ("Windows port: executor B", Codex): worktree `agent-mcr-windows-b`, branch `windows-port-b` (from 9116835). Track: W8, W9, W7 (moved from A by the operator), W10, W11, W12. Before W7, B merges `windows-port` into `windows-port-b` once, because W7 needs `ipc::private_dir` (W3) and `peer.rs` (W2).
- Pipeline: an executor starts its next task as soon as it reports a commit; review fixes come as follow-up commits. At most one unreviewed task per executor ahead of the reviewer.
- Review: the executor runs the scoped gate. Before a task is released, the planner asks the reviewer what it will check and writes the answers into the task text, aiming at one review round per task. The reviewer re-runs only `cargo xwin clippy` (plus `cargo test` when the diff touches Rust tests) and reads the diff closely. The full gate runs on every merge and at the final check.
- File ownership, to keep merges small: `harness.rs`, `runner.rs`, `peer.rs`, `ipc.rs`, `agents*`, `Cargo.toml`/`Cargo.lock` belong to A. `session_mcp.rs`, `session_analysis_commands.rs`, `agent.rs`, `sessions.rs`, `session_memory.rs`, `src/`, `tauri.conf.json`, `package.json`, `.github/`, `CLAUDE.md`, `README.md`, `docs/SESSION_ANALYSIS_MCP.md`, `docs/AGENT_HARNESS_DESIGN.md` belong to B. `main.rs` is shared: A owns `get_config_dir` and the `--runner`/`--harness` branches; B owns the `--mcp` branch (W7), `session_folders`, the Access path checks (W8) and the `tauri::Builder` run error path (W10). If W7 needs a dependency in `Cargo.toml`, B asks the planner. `docs/WINDOWS_PORT.md`: the planner edits the plan; A writes only under "Wine findings". A needed change in a file the other owns goes to the planner, who hands it to the owner. B collects doc notes from A's commits for W12.
- Merges (operator decision): B merges `windows-port` into `windows-port-b` once before W7. At the end, A merges `windows-port-b` into `windows-port` once and runs the full gate. No other intermediate merges.

## Tasks

| Id | Goal | Files | Acceptance |
|---|---|---|---|
| W1 | Windows build compiles, failing closed. Add target deps (`windows-sys` with the needed features, `uds_windows`, `sysinfo`), `ipc.rs` with `Stream`/`Listener` aliases (std on Unix, `uds_windows` on Windows) and `private_dir`/`private_file`/`is_socket` helpers; switch every `std::os::unix::net` use to it. Windows bodies that are not done yet return an error or `None` (peer checks deny), never allow. Unix behaviour unchanged | `Cargo.toml`, `ipc.rs` (new), `main.rs`, `runner.rs`, `peer.rs`, `harness.rs`, `harness_commands.rs`, `harness_preferences.rs`, `session_mcp.rs`, `sessions.rs` | Full gate, including `cargo xwin clippy` with no warnings. `grep -rn 'std::os::unix' src-tauri/src` shows only `cfg(unix)` code. No `#[allow(dead_code)]` added to hide Windows gaps |
| M1 | Merge `plugins` (at least d76cee6: `terminal_write` `submit`, shared deliver helper, inbox notices for untracked agents) into `windows-port` after W1 is approved, so W5/W6 work on the current `harness.rs`. New Unix-only code from the merge gets the W1 treatment (compiles for Windows, fails closed) | merge commit | Gate, including `cargo xwin clippy`. No change in behaviour on macOS beyond what `plugins` brings |
| W2 | Process identity on Windows as specified above (`credentials`, `same_user`, `parent` with the creation-time rule, `program`, `is_this_program`) | `peer.rs` | Gate. The existing peer test runs on Windows too (`cfg` removed or mirrored). Code review confirms every failure path returns `None`/`false` |
| W3 | Private config dir on Windows: `private_dir`/`private_file` set and verify the DACL as specified above, failing closed. Config, cache and socket paths. `get_config_dir` uses `data_local_dir` on Windows; attachments under `cache_dir`; check every `dirs::` use and every hard-coded `/` or `~/Library` path in Rust | `main.rs`, `harness.rs`, `harness_commands.rs`, `session_analysis_commands.rs` | Gate. `cfg(windows)` tests: a new dir from `private_dir` reads back as owner = user, protected, exactly one allow ACE for the user with both inherit flags, and a file created inside inherits it; an existing dir with an extra ACE (e.g. Everyone read) or that is a junction is refused, not repaired. A pure-function test for the chosen dirs per platform where practical |
| W4 | Runner on Windows: detached start of runner and service (`runner::start`), signals, tests that spawn `/bin/sh`/`/bin/true`/`nc` get Windows equivalents (`cmd.exe /c`) or are `cfg(unix)` with a reason | `runner.rs` | Gate. Windows tests compile; list in the commit which tests are Unix-only |
| W5 | Agent launch on Windows as specified above: `argv_for`, a pure `cmd_line` quoting function with tests (refusals for `"`, `%`, CR, LF; spaces; `&`, `^`, `<`), Codex `-c` values as TOML literals, Claude hook command form, first task and agy prompt typed instead of argv, shell profile | `harness.rs`, `agents.rs` | Gate. New Mac-run tests cover the Windows command lines of Claude, Codex, agy and shell, launch and resume, supervisor included, and `cmd_line` (empty argument, trailing backslash, spaces, `& \| < > ^ ( ) !`, each refusal). A `cfg(windows)` integration test runs real lines through `cmd.exe /d /v:off /s /c` into a probe program that prints its argv as JSON (an example binary, `examples/argv_probe.rs`), directly and through a generated npm-style `.cmd` shim (`@"%~dp0argv_probe.exe" %*`), and asserts argv is preserved exactly. It runs in the Windows CI job (W11) and under Wine (R2) |
| W6 | Harness service on Windows: `process_table` via `sysinfo` behind a pure parser/mapper, shell matcher for `bash.exe -c`, `powershell -Command`, `cmd /c`; `notify_user` no-op; `serve`, `tool_cli` and `bridge` on the alias types | `harness.rs` | Gate. Matcher tests with Windows command lines |
| W7 | Session analysis MCP over the same transport on Windows (`--mcp` bridge, app socket, revocation closing sockets) | `session_mcp.rs`, `session_analysis_commands.rs`, `main.rs` | Gate. The `cfg(not(unix))` stubs are gone; the stream test runs on both |
| W8 | Windows paths in the indexers and the agent workspace: Claude's `projects/<encoded>` names for `C:\…` folders, `session_folders` home exclusion, transcript `cwd` values with backslashes and drive letters, `is_agent_document` / `classify_rel` with `\` separators | `agent.rs`, `sessions.rs`, `session_memory.rs`, `main.rs` | Gate. Tests with Windows-style paths on pure functions |
| W9 | Frontend paths: one separator-agnostic helper set (basename, short path with `~` for `C:\Users\<name>`, parent) used by `LiveWorkspace`, `StatusBar`, `SessionResults`, `SessionWorkspace`, `SessionCommandPanel`, `utils/harness.ts`, `utils/sessions.ts`; the Live folder input accepts `C:\…` | `src/utils/paths.ts` (new) and the files named | `npm run build`, `npm test` with new tests for Windows paths |
| W10 | Installer and missing WebView2: `tauri.conf.json` bundle targets add `nsis` (`installMode: currentUser`), `windows.webviewInstallMode` `downloadBootstrapper` (or `embedBootstrapper`), `windows` section; when WebView2 is missing the app shows a native error dialog instead of panicking (the `tauri::Builder` `run` error path in `main.rs`, which B may change for this), CSP checked for `http://localfile.localhost` and `http://ipc.localhost`; `npm run build:win`; capabilities checked | `tauri.conf.json`, `package.json`, `capabilities/` | Gate. `npx tauri build --bundles nsis --target x86_64-pc-windows-msvc --runner cargo-xwin` is attempted; its result goes in the commit message (a cross-built installer is not required to pass) |
| W11 | CI: a `windows-latest` job running `npm ci`, `npm run build`, `npm test`, `cargo clippy --locked --all-targets`, `cargo test --locked` | `.github/workflows/ci.yml` | YAML reviewed; the job mirrors the Linux job. Its first green run is on the manual list |
| W12 | Docs: CLAUDE.md (platform notes, transport, launch, gate), `SESSION_ANALYSIS_MCP.md`, `AGENT_HARNESS_DESIGN.md` (D12 amended for the Windows gate, "What differs" row for D4), README build steps for Windows | docs | Reviewer reads them against the code |

## Runtime tests under Wine (Rum)

Real Windows is not available here. The app is run under Rum 2.0.0-beta.1 (`/Applications/Rum.app`, a Wine wrapper). CLI: `/Applications/Rum.app/Contents/Resources/RumCmd` (not on `PATH`): `list`, `create <name>`, `run <bottle> <path.exe> [args]`, `shellenv <bottle>` (env exports to run `wine` directly, e.g. with `WINEDEBUG`). Use a dedicated bottle `agent-mcr-test`; leave `Default` alone.

Build with `cargo xwin build --target x86_64-pc-windows-msvc` (x86_64 only: Wine on Apple Silicon runs x64 through Rosetta). Tauri needs WebView2 in the bottle; try the Evergreen standalone or the fixed-version runtime.

Wine differs from Windows (ConPTY, AF_UNIX and its `SIO_AF_UNIX_GETPEERPID`, process tokens, WebView2). A failure under Wine is not proof of a code bug: record each one with the exact console/log output in "Wine findings" below, decide whether it is ours, and if not, keep the case on the real-Windows list. Fail-closed identity checks refusing under Wine are expected if Wine lacks the ioctl; they must not be loosened for Wine.

| Id | After | Goal | Acceptance |
|---|---|---|---|
| R1 | W1 | Smoke run: bottle `agent-mcr-test`, WebView2 installed, debug build started with `RumCmd run`, console captured | The window opens and the Documents view renders, or the exact errors are in Wine findings with a verdict (ours / Wine / WebView2) |
| R2 | W7 | Harness under Wine, command line only (no UI): `agent-mcr.exe --runner` and `--harness` start and create their sockets in a private config dir; `--harness-tool list_peers` from outside is refused; the `argv_probe` test lines through `cmd.exe`; session MCP `--mcp` connects or fails closed | Each step's result and output in Wine findings |
| R3 | W10 | The NSIS installer runs in a clean bottle (installs files, WebView2 bootstrapper step attempted); the UI is not judged under Wine | Result in Wine findings |

### Wine findings

- **R1 (smoke run, commit `9116835`)**:
  - Bottle: `agent-mcr-test` (Windows 10, Rum 2.0.0-beta.1).
  - WebView2: Evergreen bootstrapper (`MicrosoftEdgeWebview2Setup.exe /silent /install`) exited 0 without installing; standalone x64 installer (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install`, `linkid=2124701`) installed `EdgeWebView\Application\157.0.4341.60` cleanly.
  - Build: `npm run build` + `cargo xwin build --target x86_64-pc-windows-msvc` (debug, `custom-protocol` default).
  - Run: `agent-mcr.exe` started and stayed running alongside `msedgewebview2.exe` (`--embedded-browser-webview=1 --webview-exe-name=agent-mcr.exe --user-data-dir=C:\users\vadim\AppData\Local\cc.lambdahouse.agent-mcr\EBWebView` and `crashpad-handler`); `EBWebView` initialized (`Default`, `Local State`, `Last Version` created). Zero Rust panics or app errors on stdout/stderr (`WINEDEBUG=-all`); `WINEDEBUG=err+all` showed only standard Wine stubs (`NtQueryInformationToken` class 39, `SetPreferredAppMode`, `UIViewSettings`, `RegisterPowerSettingNotification`).
  - Verdict: **inconclusive (visual rendering unverified)**: `screencapture -x` failed (`could not create image from display`, exit 1 — lacks Screen Recording permission), so window opening and Documents view rendering were not visually observed. Partial evidence retained: process survival and `EBWebView` profile initialization with zero app errors.
- **R1 result from the operator and Supervisor (observed on screen)**: in bottle `Default` (no WebView2) `agent-mcr.exe` exits with status 101 (Rust panic). In `agent-mcr-test` (WebView2 157.0.4341.60) the window opens but stays empty, also with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-gpu --disable-gpu-compositing --no-sandbox"`; processes stay alive, no app errors (only Wine stubs: `NtQueryInformationToken` 33/39, ole `ensure_mta` 0x800401f0, `RoGetActivationFactory`). Launch that works: `eval "$(RumCmd shellenv agent-mcr-test)"; "$WINELOADER" <exe>` (`RumCmd run` exits silently; `nohup` strips the `DYLD_` variables). Verdict: Wine/WebView2, not ours. **Wine cannot verify the UI**; it is used only for non-UI checks (R2). UI verification moves to real Windows (W11 CI or a VM; operator decides).

## Verification status

Cross-clippy and Mac tests prove that Windows code compiles and that the pure functions are right; they do not prove Windows behaviour. A task whose acceptance includes a `cfg(windows)` test (W2, W3, W5, W7) is approved for the Mac gate only and stays marked "Windows-unverified" until that test has run green on Windows (the CI job of W11, which needs a push the operator decides on, or a real Windows machine). Wine runs (R1–R3) are supporting evidence, not proof. The final report lists each task's status.

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
