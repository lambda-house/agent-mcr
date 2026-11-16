# Agent-written plugins: design

**Status:** approved in discussion 2026-11-16, not built. Branch `plugins`.

## Goal

Agents working in Agent MCR can extend the app's UI for their task: a panel or sidebar widget that shows harness data and can propose actions. The human approves every plugin and every action.

## Decisions

| | Decision |
|---|---|
| P1 | Plugin authors are agents. Their code is untrusted: a prompt injection into the agent is an injection into the plugin |
| P2 | A plugin can read harness data and **propose** actions. Each action is confirmed by the human. D6 holds: a plugin can never answer a permission prompt |
| P3 | A plugin is a folder in the project: `.mcr/plugins/<id>/`. It lives in git with the project |
| P4 | Plugins run in a sandboxed iframe with an opaque origin and no network. They talk to the host only through a `postMessage` bridge |
| P5 | There is one plugin system. The in-tree registry (`src/plugins/sdk.ts`) is removed; its plugins become core code or are deleted |

## Package

`.mcr/plugins/<id>/` in a session folder:

- `manifest.json`
  - `id` (`[a-z0-9-]{1,40}`, equal to the folder name), `name`, `version`, `description`
  - `slot`: `pane` (a pane in the Live split layout) or `sidebar` (a section in the Live sidebar)
  - `reads`: subset of `sessions`, `reports`, `bulletin`, `usage`
  - `proposes`: subset of `task`, `session`
- `index.html`: one self-contained file, at most 1 MB. No other files are served.

An invalid manifest is listed with its error and cannot be approved.

## Discovery (Rust)

Rust looks for `.mcr/plugins/*/manifest.json` in the folders `session_folders` already returns for the Documents scan, and at the same moments (`agent_workspace` scan, `agent::Watch`). The webview gets no access to these folders: it receives the parsed manifest, the folder, the content hash and the approval state through a new command `plugins_list`. The source for review is returned by `plugin_source(folder, id)`, read by Rust and size-limited.

## Approval

- The UI shows a notice in Live ("New plugin in <folder>") and an entry in Settings → Plugins with manifest, permissions and source.
- Approval is a native dialog opened by Rust (`plugin_approve(folder, id, hash)`), like the other grants. The dialog names the folder, the plugin and its permissions. The author is not shown: a file has no trustworthy author.
- The approval is stored in `access.json` as `plugins: { "<folder>/<id>": "<sha256>" }`. The hash covers `manifest.json` and `index.html`.
- Any change to either file changes the hash. The plugin shows as "changed, needs approval" and the old version is not run (only the approved bytes could be served, and those are gone).
- `plugin_revoke(folder, id)` removes the entry. Revoking session or agent workspace access does not touch plugin approvals, but a plugin whose folder is no longer a session folder is not listed or served.

## Runtime

- Rust registers the protocol `mcrplugin://<sha256>/`. It serves `index.html` only when the hash is an approved one and the file on disk still hashes to it. The response carries its own CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`.
- The host injects the SDK script (`mcr.js`) into the served HTML, before the plugin's own scripts.
- The host renders `<iframe sandbox="allow-scripts" src="mcrplugin://<hash>/">`, without `allow-same-origin`, so the origin is opaque.
- The app CSP gets `frame-src mcrplugin:`.
- **Risk checked first:** Tauri must refuse IPC from this iframe. A plugin calling `invoke` (or the raw IPC endpoint) and `fetch` must fail. If IPC passes, deny it with a capability scoped to the app's own origin before anything else is built.

## Bridge

SDK inside the plugin:

```ts
mcr.read(kind: 'sessions' | 'reports' | 'bulletin' | 'usage', args?): Promise<unknown>
mcr.on(kind: 'sessions', cb: (data) => void): () => void
mcr.propose(p:
  | { kind: 'task'; session: string; text: string }
  | { kind: 'session'; profile: 'claude' | 'codex'; folder: string; task?: string }
): Promise<{ accepted: boolean; error?: string }>
```

Host side (`src/utils/pluginBridge.ts`):

- Accepts messages only whose `source` is its own iframe's `contentWindow`. Request shape `{ id, method, params }`, response `{ id, result | error }`.
- Every request is checked against the manifest's `reads` and `proposes`; anything else is refused.
- Reads use existing calls: `sessions` → `harness_list`, `usage` → `session_stats` (only when session workspace access is on). `reports` and `bulletin` use new read-only service control ops `reports` and `notes`, the same data as the supervisor's `reports_list` and `bulletin_list`. This also gives the app its first view of reports and the board.
- `on('sessions')` pushes from the Live view's existing polling; no new polling.

## Actions

- `propose` opens a host dialog showing the plugin, the action and its full text. The plugin cannot draw over it (cross-origin iframe).
- One proposal at a time per plugin; others are refused while one is open. Three rejections in a row pause the plugin until the human resumes it.
- `task` goes through a new service control op `task`: the same queue as `task_assign`, with the same refusals: `plain_prompt`, no shell sessions, not while the session waits on a permission prompt (D6).
- `session` goes through `harness_spawn`, only into the plugin's own folder or below it. `task`, when given, must pass `plain_prompt`.
- Never available: `terminal_write`, signals, restart, close, answering prompts, messages. `message` is left out of v1: the service has no operator sender. Add it when a plugin needs it.

## For agents

- Skill `agent-mcr:plugins`, served like `agent-mcr:peers` and `agent-mcr:reporting` from the launch's `--plugin-dir`, and appended to the `guide` tool. It covers the package format, the `mcr` API, limits and an example.
- `mcr.d.ts` is included in the skill text.
- Peers note (`PEER_NOTE`) is not changed: plugins are not about peers.

## Migration of the in-tree plugins

| Now | Becomes |
|---|---|
| `teob-theme` | Direct CSS imports and providers in `main.tsx` |
| `command-panel` | Rendered by `SessionWorkspace`, Cmd+K handled through `utils/commands.ts` |
| `doc-pane` | A built-in pane kind in `LiveWorkspace` |
| `projects-sidebar` | Deleted (off by default, duplicates the Live sidebar) |
| `theme-overrides` | Merged into the theme CSS |
| `sdk.ts`, `index.ts`, `usePlugins.ts`, `sdk.test.ts`, overrides, events | Deleted |
| Settings → Plugins | Lists agent plugins: state, permissions, approve, revoke, resume |

`src/plugins/README.md` is replaced by a section in `CLAUDE.md`.

## Tests

- Rust: manifest parsing and refusals; discovery only in session folders; hash over both files; the protocol serves only approved, unchanged bytes; a changed file drops the approval; control ops `task`, `reports`, `notes` including D6 and `plain_prompt` refusals.
- Vitest: bridge refuses messages from other sources, filters by manifest, validates proposals, enforces one open proposal and the pause after three rejections.
- Live check in the built app: `invoke` and `fetch` from a plugin fail; a proposal to a session waiting on a prompt is refused.

## Out of scope

Third-party distribution, signing, plugin settings storage, network access, more slots, messages from the operator.
