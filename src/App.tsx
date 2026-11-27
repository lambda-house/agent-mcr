import React from 'react';
import { useStore, panelShown } from './store';
import { reader } from './readerHost';
import { flushEditorChanges, readerPlugin } from '@lambda-house/reader';
import { journalPlugin } from '@lambda-house/journal';
import { agentsPlugin } from '@lambda-house/agents';
import { Workbench } from '@lambda-house/workbench';
import { isTauri, onMenuCommand, onWindowCloseRequested } from './utils/tauri';
import { appMenu, buildMenu, commandContext, useCommandContext } from './utils/commands';
import MemoryConnection from './components/MemoryConnection';
import { journal } from './journal';
import { pluginRegistry } from './plugins';
import { agents } from './agents';
import { documentWindowPath } from './utils/documentWindow';
import { useTitleBar } from './utils/windowChrome';
import { NO_DOCUMENT, documentsPlugin, zoomOf } from './documents';

// ============================================================
// Agent MCR's window: the Workbench of its plugins (shared UI spec §3.3), the
// reader's, the journal's, the agent documents', Agent MCR's own
// (documents.tsx: Documents and Sessions) and the plugins in src/plugins. A
// memory reader window (`documentWindowPath`) is the Documents surface with
// one document.
// ============================================================

const registry = pluginRegistry.workbench;
registry.register(readerPlugin(reader, {
  empty: NO_DOCUMENT,
  contents: { zoom: zoomOf('toc'), onClose: () => useStore.getState().toggleTocVisible() },
  // A memory window doesn't take the main window's tabs
  restore: isTauri() && !documentWindowPath,
  windowDocument: documentWindowPath,
  confirmClose: { name: 'Agent MCR', onCloseRequested: onWindowCloseRequested },
}));
// Its view is a view of Sessions (SessionWorkspace); here its tabs, with the TEOB connection above the memories
registry.register(journalPlugin(journal, { memories: <MemoryConnection /> }));
// Agent documents are watched while Documents shows their pane or one of them is open
registry.register(agentsPlugin(agents, {
  useWatched: (open) => {
    const documentsShown = useStore((s) => s.surface !== 'sessions');
    const paneShown = useStore((s) => panelShown(s, 'agent-docs'));
    return documentsShown && (paneShown || open);
  },
}));
registry.register(documentsPlugin);

// The commands, with their shortcuts, are in utils/commands.ts; the main
// menu, the keys, the native menu and the palette all read this one list
const menu = buildMenu();
appMenu.set(menu);

const App: React.FC = () => {
  // The shown surface is the store's: commands of the other one wait
  const surface = useStore((s) => s.surface);
  const setSurface = useStore((s) => s.setSurface);
  const statusBarPinned = useStore((s) => s.statusBarPinned);
  const setStatusBarPinned = useStore((s) => s.setStatusBarPinned);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  // The palette (the command panel) works in Sessions: elsewhere the top bar's ⌕ is disabled
  const paletteOpen = useStore((s) => s.paletteOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const titleBar = useTitleBar();

  return (
    <Workbench
      registry={registry}
      surface={surface}
      onSurface={setSurface}
      menu={menu}
      commandContext={commandContext}
      useCommandContext={useCommandContext}
      onMenuOpen={flushEditorChanges}
      nativeMenu={onMenuCommand}
      status={{ pinned: statusBarPinned, onPinnedChange: setStatusBarPinned }}
      // macOS: the top bar is the window's title bar (MCR-138); elsewhere, and in reader windows, a native one
      titleBar={titleBar}
      palette={{
        open: paletteOpen, onOpenChange: setPaletteOpen, enabled: surface === 'sessions',
        label: 'Control panel', placeholder: 'Search sessions, tickets, models, or commands…',
      }}
      settings={{ open: settingsOpen, onOpenChange: setSettingsOpen }}
      appearance={{ theme, setTheme }}
    />
  );
};

export default App;
