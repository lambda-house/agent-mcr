# Agent MCR Plugin System & Upgrade Guide

## 1. Self-contained modules (copy as-is on platform upgrade)

These files and directories are isolated from upstream core files:

- `src/plugins/` — Plugin SDK (`sdk.ts`, `usePlugins.ts`, `index.ts`) and plugins:
  - `src/plugins/layouts/` — split panes in Live: preset bar, split and close buttons (core keeps the pane tree)
  - `src/plugins/command-panel/` — hosts the command panel in Sessions (Ctrl+Shift+P, ⇧⌘P on macOS; the key is the command `app.commandPalette`)
- `src/utils/paneLayout.ts` + `src/utils/paneLayout.test.ts`

## 2. Core integration points (small hooks in upstream files)

When pulling or moving to a newer version of `agent-mcr`, only these core files carry integration hooks:

1. **`src/components/SessionWorkspace.tsx`**
   - Subscribes via `usePluginVersion()` and renders `pluginRegistry.getTopTabs()` in `.hs-view-switch`.
2. **`src/components/LiveWorkspace.tsx`** (+ **`src/styles/harness.css`**)
   - Hosts the multi-pane split tree (`PaneNode` from `utils/paneLayout.ts`), drawn by the workbench `LayoutView` (`@lambda-house/workbench`); session panes are kept alive there.
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
