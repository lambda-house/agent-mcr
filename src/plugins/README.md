# Agent MCR Plugin System & Upgrade Guide

## 1. Self-contained modules (copy as-is on platform upgrade)

These files and directories are isolated from upstream core files:

- `src/plugins/` — Plugin SDK (`sdk.ts`, `usePlugins.ts`, `index.ts`) and plugins. `sdk.ts` is Agent MCR's typed API over the workbench's `PluginRegistry` (`@lambda-house/workbench`): each `register*` contributes to one of its points (`live:pane-type`, `sessions:overlay`, …), `overrideComponent` puts a render function in a slot, and the points, slots and events are declared on the workbench's `WorkbenchPoints`/`WorkbenchSlots`/`WorkbenchEvents` by declaration merging. Which plugins are off stays in localStorage under `agent-mcr:disabled-plugins` / `agent-mcr:enabled-plugins`. `registerTopTab`, `registerPaletteProvider`, `registerAppWrapper` and `registerSettingsTab` contribute to the workbench's own points (`workbench:view` on the `sessions` surface, `workbench:palette-provider`, `workbench:wrapper`, `workbench:settings-tab`), which the `Workbench` in `App.tsx` (and `SessionWorkspace`, for the views) draws with the reader's, the journal's and the app's; the reader, the journal and Agent MCR's own part (`src/documents.tsx`) are required plugins in the same registry (always on, not in the Plugins tab). A slot falls back to the previous plugin's override when the last one is turned off; a plugin whose setup throws is taken back and the others still load:
  - `src/plugins/layouts/` — Live's presets (the list beside one pane, two columns, a 2×2 grid) among Live's tools in the top bar; each pane splits, joins, swaps and closes through the workbench's pane menu (⋯)
  - `src/plugins/command-panel/` — the sessions, views and actions in the palette (`sessionPaletteProvider`; Ctrl+Shift+P, ⇧⌘P on macOS; the key is the command `app.commandPalette`) and the Live list's Search button
- `src/utils/paneLayout.ts` + `src/utils/paneLayout.test.ts`

## 2. Core integration points (small hooks in upstream files)

When pulling or moving to a newer version of `agent-mcr`, only these core files carry integration hooks:

1. **`src/components/SessionWorkspace.tsx`**
   - Subscribes via `usePluginVersion()` and draws the views of `sessions` (`useViews`: its own, contributed by `src/documents.tsx`, and the plugins' top tabs) with `ShellViews`, which puts the switch into the window's top bar. A top tab's `order` places it: Live is 10, the Journal 200, Board 210, Slack 220, a plugin's 100 by default.
2. **`src/components/LiveWorkspace.tsx`** (+ **`src/styles/harness.css`**)
   - Hosts Live's workbench layout (`src/sessionsLayout.ts`; the operations in `utils/paneLayout.ts`), drawn by the workbench `LayoutView` (`@lambda-house/workbench`): the list, the panes sessions open in (session panes are kept alive there), plugin panes (`custom`), empty panes and Board's and Slack's panels. `controller.layout` is that layout (`LayoutNode`).
   - Calls `pluginRegistry.getSidebarSections()`, `getPaneType()`, `getEmptyActions()`, `getSessionEnrichers()`, `getOverride('live:*')`, and `emitEvent(...)`.
3. **`src-tauri/src/agents.rs` & `src-tauri/src/harness.rs`** (optional Rust backend enrichment)
   - `transcript_summary` (`title`, `role`, `tags` on `Resumable`) and `antigravity` harness support.

## 3. Adding a new plugin

Create `src/plugins/<name>/index.tsx`:

```tsx
import { createPlugin } from '../sdk';

export const plugin = createPlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  setup(api) {
    // api.registerTopTab(...)
    // api.registerPaletteProvider(...)
    // api.registerPaneType(...)
    // api.registerSidebarSection(...)
    // api.registerEmptyAction(...)
    // api.registerSessionEnricher(...)
    // api.overrideComponent('live:sidebar', ...)
    // api.onEvent('session:started', ...)
  },
});
```

`src/plugins/index.ts` auto-discovers `./*/index.{ts,tsx}` via `import.meta.glob`.
